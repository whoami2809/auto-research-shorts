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
    if (ok){ytdlpBin=b;console.log('[yt-dlp] instalado:',b);break;}
  }
  if(!ytdlpBin)console.warn('[yt-dlp] nao encontrado');
})();

const frameCache=new Map();const FRAME_TTL=15*60*1000;
function cleanFrames(){const now=Date.now();for(const[id,f]of frameCache)if(now>f.exp)frameCache.delete(id);}

function extractVideoId(url){
  for(const p of[/youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,/youtu\.be\/([a-zA-Z0-9_-]{11})/,/youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})/,/[?&]v=([a-zA-Z0-9_-]{11})/]){
    const m=url.match(p);if(m)return m[1];}return null;}

// ─── Piped.video (proxy YouTube) ─────────────────────────────────────────────
const PIPED=[
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.adminforge.de',
  'https://piped-api.garudalinux.org',
  'https://api.piped.yt',
  'https://pipedapi.tokhmi.xyz',
  'https://watchapi.whatever.social',
];
async function pipedStreams(videoId){
  for(const api of PIPED){
    try{
      const r=await fetch(`${api}/streams/${videoId}`,{signal:AbortSignal.timeout(8000)});
      if(!r.ok)continue;
      const d=await r.json();
      if(!d.error&&(d.videoStreams?.length||d.audioStreams?.length)){
        console.log('[piped] OK:',api);return d;
      }
    }catch(e){console.log('[piped fail]',api,e.message);}
  }
  return null;
}

// ─── /api/info ────────────────────────────────────────────────────────────────
app.get('/api/info',async(req,res)=>{
  const {url}=req.query;
  const videoId=extractVideoId(url);
  if(!videoId)return res.status(400).json({error:'Link inválido'});
  try{
    const r=await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`);
    if(!r.ok)throw new Error();
    const d=await r.json();res.json({videoId,title:d.title||'',channel:d.author_name||''});
  }catch{res.json({videoId,title:'',channel:''});}
});

// ─── /api/transcript ──────────────────────────────────────────────────────────
app.get('/api/transcript',async(req,res)=>{
  const {url}=req.query;const videoId=extractVideoId(url);
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
    let cu=track.baseUrl;if(!/[?&]fmt=/.test(cu))cu+='&fmt=srv3';
    const xml=await(await fetch(cu)).text();
    const texts=[];let m;const pR=/<p\b[^>]*>([\s\S]*?)<\/p>/g;
    while((m=pR.exec(xml))!==null){
      const t=m[1].replace(/<[^>]+>/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#39;/g,"'").replace(/\s+/g,' ').trim();
      if(t)texts.push(t);}
    if(!texts.length)throw new Error('sem texto');
    res.json({transcript:texts.join(' '),language:track.languageCode});
  }catch(e){res.status(404).json({error:'Sem legendas. '+e.message});}
});

// ─── /api/audio (Whisper) ─────────────────────────────────────────────────────
app.get('/api/audio',async(req,res)=>{
  if(!ytdl)return res.status(503).json({error:'ytdl indisponível'});
  const {url}=req.query;const videoId=extractVideoId(url);
  if(!videoId)return res.status(400).json({error:'Link inválido'});
  try{
    const info=await ytdl.getInfo(`https://www.youtube.com/watch?v=${videoId}`);
    const fmts=ytdl.filterFormats(info.formats,'audioonly').sort((a,b)=>(a.audioBitrate||999)-(b.audioBitrate||999));
    if(!fmts.length)throw new Error('sem áudio');
    res.setHeader('Content-Type',(fmts[0].mimeType||'audio/mp4').split(';')[0]);
    const stream=ytdl.downloadFromInfo(info,{format:fmts[0]});
    stream.on('error',()=>{if(!res.headersSent)res.status(500).end();});
    req.on('close',()=>stream.destroy());stream.pipe(res);
  }catch(e){if(!res.headersSent)res.status(500).json({error:e.message});}
});

// ═══════════════════════════════════════════════════════════════════════
// /api/video-dl  — download real, sem abrir novas abas
// Método 1: yt-dlp (cliente ios, bypassa bloqueios)
// Método 2: Piped.video (proxy do YouTube)
// Método 3: ytdl-core
// ═══════════════════════════════════════════════════════════════════════
app.get('/api/video-dl',async(req,res)=>{
  const {url,quality,mode}=req.query;
  if(!url)return res.status(400).send('URL obrigatória');

  const isAudio = mode==='audio';
  const isMute  = mode==='mute';
  const h = (quality&&quality!=='max')?parseInt(quality)||720:9999;
  const filename = isAudio?'audio.m4a':'video.mp4';
  const contentType = isAudio?'audio/mp4':'video/mp4';

  // ── Método 1: yt-dlp com cliente ios (mais sucesso em datacenters) ──────────
  if(ytdlpBin){
    let fmtStr;
    if(isAudio){
      fmtStr='bestaudio[ext=m4a]/bestaudio/best';
    }else if(isMute){
      fmtStr=h>=9999?'bestvideo[ext=mp4]/bestvideo':`bestvideo[height<=${h}][ext=mp4]/bestvideo[height<=${h}]/bestvideo`;
    }else{
      fmtStr=h>=9999
        ?'best[ext=mp4]/best'
        :`best[height<=${h}][ext=mp4]/best[height<=${h}]/mp4/best`;
    }

    const args=[
      '--extractor-args','youtube:player_client=ios,web_creator',
      '--no-check-certificates',
      '-f',fmtStr,
      '--no-playlist',
      '-o','-',
      url
    ];

    console.log('[yt-dlp] tentando com args:',args.join(' '));

    const proc=spawn(ytdlpBin,args);
    let headersSent=false;

    // Quando chegar o primeiro chunk, manda headers e começa a stremar
    proc.stdout.once('data',chunk=>{
      if(!res.headersSent){
        res.setHeader('Content-Type',contentType);
        res.setHeader('Content-Disposition',`attachment; filename="${filename}"`);
        headersSent=true;
      }
      res.write(chunk);
    });
    proc.stdout.on('data',chunk=>{if(headersSent)res.write(chunk);});
    proc.stdout.on('end',()=>{if(!res.writableEnded)res.end();});

    let stderrLog='';
    proc.stderr.on('data',d=>{const s=d.toString().trim();stderrLog+=s+'\n';console.log('[yt-dlp stderr]',s.slice(0,120));});

    req.on('close',()=>{try{proc.kill();}catch(e){}});

    proc.on('close',code=>{
      if(code!==0&&!headersSent){
        console.warn('[yt-dlp] falhou code',code,stderrLog.slice(-200));
        // Tenta Piped como fallback
        pipedFallback();
      }else if(!res.writableEnded){res.end();}
    });
    return; // yt-dlp vai cuidar do resto
  }

  // ── Se yt-dlp não instalado, vai direto ao Piped ─────────────────────────
  pipedFallback();

  async function pipedFallback(){
    if(res.headersSent||res.writableEnded)return;
    const videoId=extractVideoId(url);
    if(!videoId){
      if(!res.headersSent)res.status(400).json({error:'URL não suportada (apenas YouTube via Piped)'});
      return;
    }
    try{
      const data=await pipedStreams(videoId);
      if(!data)throw new Error('Piped: sem streams');

      let stream=null;
      if(isAudio){
        stream=(data.audioStreams||[])[0];
      }else if(isMute){
        stream=(data.videoStreams||[]).filter(s=>s.videoOnly)
          .sort((a,b)=>parseInt(b.quality)-parseInt(a.quality))
          .find(s=>parseInt(s.quality)<=h);
      }else{
        // Tenta combined primeiro
        stream=(data.videoStreams||[]).filter(s=>!s.videoOnly)
          .sort((a,b)=>parseInt(b.quality)-parseInt(a.quality))
          .find(s=>parseInt(s.quality)<=h);
        // Se não tiver combined na qualidade pedida, pega melhor disponível
        if(!stream){
          stream=(data.videoStreams||[]).filter(s=>!s.videoOnly)
            .sort((a,b)=>parseInt(a.quality)-parseInt(b.quality))[0];
        }
      }

      if(!stream?.url)throw new Error('Piped: stream não encontrado para essa qualidade');

      const upstream=await fetch(stream.url,{
        headers:{'User-Agent':'Mozilla/5.0','Referer':'https://piped.video/'},
        signal:AbortSignal.timeout(90000),
      });
      if(!upstream.ok)throw new Error(`Piped upstream HTTP ${upstream.status}`);

      const ct=upstream.headers.get('Content-Type')||contentType;
      res.setHeader('Content-Type',ct);
      res.setHeader('Content-Disposition',`attachment; filename="${filename}"`);
      const cl=upstream.headers.get('Content-Length');
      if(cl)res.setHeader('Content-Length',cl);

      const reader=upstream.body.getReader();
      req.on('close',()=>reader.cancel());
      async function pump(){
        try{const{done,value}=await reader.read();
          if(done){if(!res.writableEnded)res.end();return;}
          if(!res.writableEnded){if(res.write(Buffer.from(value)))pump();else res.once('drain',pump);}
        }catch(e){if(!res.writableEnded)res.end();}
      }
      pump();

    }catch(e){
      console.error('[piped fallback]',e.message);
      if(!res.headersSent)res.status(503).json({
        error:'Não foi possível baixar este vídeo agora. Tente uma qualidade diferente ou tente mais tarde.',
        detail:e.message
      });
    }
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
  cleanFrames();const frame=frameCache.get(req.params.id);
  if(!frame)return res.status(404).send('Frame expirado');
  res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Content-Type','image/png');
  res.setHeader('Cache-Control','public, max-age=900');res.send(frame.data);
});

app.listen(PORT,()=>console.log(`Servidor na porta ${PORT}`));
