const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors()); app.use(express.json()); app.use(express.static('public'));

let ytdl = null;
try { ytdl = require('@distube/ytdl-core'); } catch(e) {}
let ytdlpBin = null;
(async () => {
  for (const b of ['yt-dlp','/usr/local/bin/yt-dlp',`${process.env.HOME}/.local/bin/yt-dlp`]) {
    const ok = await new Promise(r=>{const p=spawn(b,['--version']);p.on('close',c=>r(c===0));p.on('error',()=>r(false));});
    if (ok){ytdlpBin=b;break;}
  }
})();

// ─── Frame cache (Lens) ───────────────────────────────────────────────────────
const frameCache = new Map();
const FRAME_TTL = 15*60*1000;
function cleanFrames(){const now=Date.now();for(const[id,f]of frameCache)if(now>f.exp)frameCache.delete(id);}

function extractVideoId(url){
  for(const p of[/youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,/youtu\.be\/([a-zA-Z0-9_-]{11})/,/youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})/,/[?&]v=([a-zA-Z0-9_-]{11})/]){
    const m=url.match(p);if(m)return m[1];}return null;}

// ─── Piped.video — proxy YouTube sem bloqueio de datacenter ──────────────────
const PIPED_APIS = [
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.adminforge.de',
  'https://piped-api.garudalinux.org',
  'https://api.piped.yt',
  'https://pipedapi.tokhmi.xyz',
];

async function pipedGetStreams(videoId){
  for(const api of PIPED_APIS){
    try{
      const r=await fetch(`${api}/streams/${videoId}`,{signal:AbortSignal.timeout(8000)});
      if(!r.ok)continue;
      const d=await r.json();
      if((d.videoStreams?.length||d.audioStreams?.length)&&!d.error)return d;
    }catch(e){console.log('[piped]',api,'->',e.message);}
  }
  return null;
}

// Cache de URLs de stream (expira em 8 min — URLs do YouTube têm prazo curto)
const streamCache = new Map();

// ─── /api/info ────────────────────────────────────────────────────────────────
app.get('/api/info', async(req,res)=>{
  const {url}=req.query;
  if(!url)return res.status(400).json({error:'URL obrigatória'});
  const videoId=extractVideoId(url);
  if(!videoId)return res.status(400).json({error:'Link inválido'});
  try{
    const r=await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`);
    if(!r.ok)throw new Error();
    const d=await r.json();
    res.json({videoId,title:d.title||'',channel:d.author_name||''});
  }catch{res.json({videoId,title:'',channel:''});}
});

// ─── /api/transcript ──────────────────────────────────────────────────────────
app.get('/api/transcript', async(req,res)=>{
  const {url}=req.query;
  const videoId=extractVideoId(url);
  if(!videoId)return res.status(400).json({error:'Link inválido'});
  try{
    const r=await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false',{
      method:'POST',headers:{'Content-Type':'application/json','User-Agent':'Mozilla/5.0'},
      body:JSON.stringify({videoId,context:{client:{clientName:'WEB',clientVersion:'2.20240101.01.00',hl:'en',gl:'US'}}}),
    });
    const data=await r.json();
    const tracks=data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if(!tracks?.length)throw new Error('sem legenda');
    const track=tracks.find(c=>c.languageCode==='en')||tracks[0];
    let captionUrl=track.baseUrl;
    if(!/[?&]fmt=/.test(captionUrl))captionUrl+='&fmt=srv3';
    const xml=await(await fetch(captionUrl)).text();
    const texts=[];let m;
    const pR=/<p\b[^>]*>([\s\S]*?)<\/p>/g;
    while((m=pR.exec(xml))!==null){
      const t=m[1].replace(/<[^>]+>/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#39;/g,"'").replace(/\s+/g,' ').trim();
      if(t)texts.push(t);
    }
    if(!texts.length)throw new Error('sem texto');
    res.json({transcript:texts.join(' '),language:track.languageCode});
  }catch(e){res.status(404).json({error:'Sem legendas. '+e.message});}
});

// ─── /api/audio (Whisper) ─────────────────────────────────────────────────────
app.get('/api/audio', async(req,res)=>{
  if(!ytdl)return res.status(503).json({error:'ytdl indisponível'});
  const {url}=req.query;
  const videoId=extractVideoId(url);
  if(!videoId)return res.status(400).json({error:'Link inválido'});
  try{
    const info=await ytdl.getInfo(`https://www.youtube.com/watch?v=${videoId}`);
    const fmts=ytdl.filterFormats(info.formats,'audioonly').sort((a,b)=>(a.audioBitrate||999)-(b.audioBitrate||999));
    if(!fmts.length)throw new Error('sem áudio');
    res.setHeader('Content-Type',(fmts[0].mimeType||'audio/mp4').split(';')[0]);
    const stream=ytdl.downloadFromInfo(info,{format:fmts[0]});
    stream.on('error',()=>{if(!res.headersSent)res.status(500).end();});
    req.on('close',()=>stream.destroy());
    stream.pipe(res);
  }catch(e){if(!res.headersSent)res.status(500).json({error:e.message});}
});

// ═══════════════════════════════════════════════════════════════════════
// /api/download-info — formatos reais via Piped
// ═══════════════════════════════════════════════════════════════════════
app.get('/api/download-info', async(req,res)=>{
  const {url}=req.query;
  if(!url)return res.status(400).json({error:'URL obrigatória'});

  const videoId=extractVideoId(url);
  if(videoId){
    try{
      const data=await pipedGetStreams(videoId);
      if(data){
        const cacheId=Date.now().toString(36)+Math.random().toString(36).substr(2,6);
        const streamMap={};
        const combined=[],videoOnly=[],audioOnly=[];
        const seenQ=new Set();

        // Vídeo + Áudio combinados
        (data.videoStreams||[]).filter(s=>!s.videoOnly&&s.quality).forEach(s=>{
          const q=s.quality;
          if(!seenQ.has('v:'+q)){seenQ.add('v:'+q);streamMap['v:'+q]=s.url;
            combined.push({k:'v:'+q,label:q,type:'combined'});}
        });
        combined.sort((a,b)=>parseInt(b.label)-parseInt(a.label));

        // Áudio apenas
        (data.audioStreams||[]).slice(0,3).forEach((s,i)=>{
          streamMap['a:'+i]=s.url;
          audioOnly.push({k:'a:'+i,label:s.quality||'Áudio '+i,type:'audio'});
        });

        // Vídeo sem áudio
        const seenV=new Set();
        (data.videoStreams||[]).filter(s=>s.videoOnly&&s.quality).slice(0,4).forEach(s=>{
          const q=s.quality;
          if(!seenV.has(q)){seenV.add(q);streamMap['vo:'+q]=s.url;
            videoOnly.push({k:'vo:'+q,label:q+' (sem áudio)',type:'video'});}
        });
        videoOnly.sort((a,b)=>parseInt(b.label)-parseInt(a.label));

        // Limpa cache antigo
        for(const[id,e]of streamCache)if(Date.now()>e.exp)streamCache.delete(id);
        streamCache.set(cacheId,{map:streamMap,exp:Date.now()+8*60*1000});

        return res.json({title:data.title||'',cacheId,combined,audioOnly,videoOnly,source:'piped'});
      }
    }catch(e){console.error('[download-info piped]',e.message);}
  }

  // Fallback: presets estáticos (para TikTok/Instagram via cobalt no browser)
  res.json({
    source:'cobalt',cacheId:'',
    combined:[
      {k:'max',mode:'auto',label:'Máxima qualidade',type:'combined'},
      {k:'1080',mode:'auto',label:'1080p Full HD',type:'combined'},
      {k:'720',mode:'auto',label:'720p HD',type:'combined'},
      {k:'480',mode:'auto',label:'480p',type:'combined'},
    ],
    audioOnly:[{k:'mp3',mode:'audio',audioFormat:'mp3',label:'MP3',type:'audio'}],
    videoOnly:[
      {k:'1080-mute',mode:'mute',label:'1080p (sem áudio)',type:'video'},
      {k:'720-mute',mode:'mute',label:'720p (sem áudio)',type:'video'},
    ],
  });
});

// ═══════════════════════════════════════════════════════════════════════
// /api/video-dl — baixa via Piped e envia pro browser como arquivo
// ═══════════════════════════════════════════════════════════════════════
app.get('/api/video-dl', async(req,res)=>{
  const {cacheId,k}=req.query;
  if(!cacheId||!k){return res.status(400).json({error:'Parâmetros inválidos'});}

  const cached=streamCache.get(cacheId);
  if(!cached||Date.now()>cached.exp){
    return res.status(410).json({error:'Link expirado. Clique em Baixar novamente para recarregar.'});
  }

  const streamUrl=cached.map[k];
  if(!streamUrl){return res.status(404).json({error:'Formato não encontrado.'});}

  try{
    const isAudio=k.startsWith('a:');
    const filename=isAudio?'audio.m4a':'video.mp4';

    const upstream=await fetch(streamUrl,{
      headers:{'User-Agent':'Mozilla/5.0','Referer':'https://piped.video/'},
      signal:AbortSignal.timeout(60000),
    });
    if(!upstream.ok)throw new Error(`upstream HTTP ${upstream.status}`);

    const ct=upstream.headers.get('Content-Type')||'video/mp4';
    res.setHeader('Content-Type',ct);
    res.setHeader('Content-Disposition',`attachment; filename="${filename}"`);
    const cl=upstream.headers.get('Content-Length');
    if(cl)res.setHeader('Content-Length',cl);

    // Stream direto pro browser (sem carregar tudo na memória)
    const reader=upstream.body.getReader();
    req.on('close',()=>reader.cancel());

    async function pump(){
      const {done,value}=await reader.read();
      if(done){res.end();return;}
      if(!res.writableEnded){res.write(Buffer.from(value));pump();}
    }
    pump();

  }catch(e){
    console.error('[video-dl]',e.message);
    if(!res.headersSent)res.status(500).json({error:'Falha no download: '+e.message});
  }
});

// ─── /api/frame (Lens) ───────────────────────────────────────────────────────
app.post('/api/frame',express.raw({type:'*/*',limit:'10mb'}),(req,res)=>{
  cleanFrames();
  while(frameCache.size>=300){const o=[...frameCache.entries()].sort((a,b)=>a[1].exp-b[1].exp)[0];if(o)frameCache.delete(o[0]);}
  const id=Date.now().toString(36)+Math.random().toString(36).substr(2,8);
  frameCache.set(id,{data:req.body,exp:Date.now()+FRAME_TTL});
  res.json({id,url:`/api/frame/${id}`});
});
app.get('/api/frame/:id',(req,res)=>{
  cleanFrames();
  const frame=frameCache.get(req.params.id);
  if(!frame)return res.status(404).send('Frame expirado');
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Content-Type','image/png');
  res.setHeader('Cache-Control','public, max-age=900');
  res.send(frame.data);
});

app.listen(PORT,()=>console.log(`Servidor na porta ${PORT}`));
