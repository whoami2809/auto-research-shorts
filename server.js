const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
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

// Limpa arquivos temporários antigos na inicialização
try {
  fs.readdirSync(os.tmpdir()).filter(f=>f.startsWith('ztemp_')).forEach(f=>{
    try{fs.unlinkSync(path.join(os.tmpdir(),f));}catch(e){}
  });
} catch(e){}

const frameCache=new Map();const FRAME_TTL=15*60*1000;
function cleanFrames(){const now=Date.now();for(const[id,f]of frameCache)if(now>f.exp)frameCache.delete(id);}

function extractVideoId(url){
  for(const p of[/youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,/youtu\.be\/([a-zA-Z0-9_-]{11})/,/youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})/,/[?&]v=([a-zA-Z0-9_-]{11})/]){
    const m=url.match(p);if(m)return m[1];}return null;}

function safeFilename(title, ext){
  const s=(title||'video').replace(/[^a-zA-Z0-9\u00C0-\u024F\s\-_]/g,'').trim().replace(/\s+/g,'_').slice(0,80)||'video';
  return s+'.'+ext;
}

// ─── Piped.video ──────────────────────────────────────────────────────────────
const PIPED=['https://pipedapi.kavin.rocks','https://pipedapi.adminforge.de','https://piped-api.garudalinux.org','https://api.piped.yt','https://pipedapi.tokhmi.xyz','https://watchapi.whatever.social'];
async function pipedStreams(videoId){
  for(const api of PIPED){
    try{
      const r=await fetch(`${api}/streams/${videoId}`,{signal:AbortSignal.timeout(8000)});
      if(!r.ok)continue;
      const d=await r.json();
      if(!d.error&&(d.videoStreams?.length||d.audioStreams?.length)){console.log('[piped] OK:',api);return d;}
    }catch(e){console.log('[piped fail]',api,e.message);}
  }
  return null;
}

// ─── /api/info ────────────────────────────────────────────────────────────────
app.get('/api/info',async(req,res)=>{
  const {url}=req.query;const videoId=extractVideoId(url);
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
    const track=tracks.find(c=>c.languageCode==='pt')||tracks.find(c=>c.languageCode==='en')||tracks[0];
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
// /api/video-dl — download completo, sem arquivo corrompido
//
// ESTRATÉGIA: yt-dlp baixa para arquivo TEMPORÁRIO (não stdout)
//   → garante MP4 completo e válido, mesmo com streams DASH
//   → só serve o arquivo após download 100% concluído
//   → fallback: Piped.video
// ═══════════════════════════════════════════════════════════════════════
app.get('/api/video-dl',async(req,res)=>{
  const {url,quality,mode,title}=req.query;
  if(!url)return res.status(400).send('URL obrigatória');

  const isAudio = mode==='audio';
  const isMute  = mode==='mute';
  const h = (quality&&quality!=='max')?parseInt(quality)||720:9999;
  const ext = isAudio?'m4a':'mp4';
  const filename = safeFilename(title, ext);
  const contentType = isAudio?'audio/mp4':'video/mp4';

  // ── yt-dlp: baixa para arquivo temp, depois serve ───────────────────────────
  if(ytdlpBin){
    const tmpFile = path.join(os.tmpdir(), `ztemp_${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`);

    let fmtStr;
    if(isAudio){
      // M4A de melhor qualidade
      fmtStr='bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio';
    }else if(isMute){
      // Só vídeo sem áudio
      fmtStr = h>=9999
        ?'bestvideo[ext=mp4]/bestvideo'
        :`bestvideo[height<=${h}][ext=mp4]/bestvideo[height<=${h}]`;
    }else{
      // Vídeo + Áudio combinados (yt-dlp muxeia automaticamente quando salva em arquivo)
      // Formatos progressivos (não-DASH) são os mais confiáveis: 22=720p, 18=360p
      // yt-dlp faz muxing automático dos DASH se necessário quando salva em arquivo
      if(h>=1080){
        fmtStr='bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio/22/18/best';
      }else if(h>=720){
        fmtStr='22/bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=720]+bestaudio/18/best[height<=720]';
      }else if(h>=480){
        fmtStr='18/bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/best[height<=480]';
      }else{
        fmtStr='18/best[height<=360]/best';
      }
    }

    const args=[
      '--extractor-args','youtube:player_client=ios,web_creator',
      '--no-check-certificates',
      '--merge-output-format', ext,
      '-f', fmtStr,
      '--no-playlist',
      '-o', tmpFile,
      url
    ];

    console.log('[yt-dlp] baixando para arquivo:',tmpFile);
    console.log('[yt-dlp] formato:',fmtStr);

    const proc=spawn(ytdlpBin,args);
    let stderrLog='';
    proc.stderr.on('data',d=>{
      const s=d.toString().trim();
      stderrLog+=s+'\n';
      // Log apenas linhas úteis
      if(s.includes('[download]')||s.includes('[ffmpeg]')||s.includes('ERROR')||s.includes('WARNING')){
        console.log('[yt-dlp]',s.slice(0,120));
      }
    });

    req.on('close',()=>{try{proc.kill();}catch(e){}});

    proc.on('close',async code=>{
      // Verifica se o arquivo foi criado
      // yt-dlp às vezes salva com extensão diferente (.mkv se muxing não gera mp4)
      let actualFile = tmpFile;
      if(!fs.existsSync(tmpFile)){
        // Tenta .mkv (quando ffmpeg não está disponível para mp4)
        const mkvFile = tmpFile.replace('.mp4','.mkv');
        if(fs.existsSync(mkvFile)) actualFile=mkvFile;
      }

      if(code===0&&fs.existsSync(actualFile)){
        const stat=fs.statSync(actualFile);
        console.log('[yt-dlp] arquivo pronto:',stat.size,'bytes',actualFile);

        // Detecta extensão real
        const realExt = path.extname(actualFile).slice(1)||ext;
        const realMime = realExt==='m4a'?'audio/mp4': realExt==='webm'?'video/webm':'video/mp4';
        const realFilename = safeFilename(title,realExt);

        res.setHeader('Content-Type',realMime);
        res.setHeader('Content-Disposition',`attachment; filename="${realFilename}"`);
        res.setHeader('Content-Length',stat.size);

        const stream=fs.createReadStream(actualFile);
        stream.pipe(res);
        stream.on('end',()=>{try{fs.unlinkSync(actualFile);}catch(e){}});
        stream.on('error',(e)=>{
          console.error('[stream]',e.message);
          try{fs.unlinkSync(actualFile);}catch(e){}
          if(!res.writableEnded)res.end();
        });
        req.on('close',()=>{try{fs.unlinkSync(actualFile);}catch(e){}});
      }else{
        // yt-dlp falhou — tenta Piped
        try{fs.unlinkSync(actualFile);}catch(e){}
        console.warn('[yt-dlp] falhou code',code,'— tentando Piped');
        console.warn('[yt-dlp stderr]',stderrLog.slice(-400));
        await pipedFallback();
      }
    });
    return;
  }

  await pipedFallback();

  async function pipedFallback(){
    if(res.headersSent||res.writableEnded)return;
    const videoId=extractVideoId(url);
    if(!videoId){
      if(!res.headersSent)res.status(400).json({error:'URL não suportada sem yt-dlp (apenas YouTube)'});
      return;
    }
    try{
      const data=await pipedStreams(videoId);
      if(!data)throw new Error('Piped: sem streams disponíveis');

      let stream=null;
      if(isAudio){
        stream=(data.audioStreams||[])[0];
      }else if(isMute){
        stream=(data.videoStreams||[]).filter(s=>s.videoOnly)
          .sort((a,b)=>parseInt(b.quality)-parseInt(a.quality))
          .find(s=>parseInt(s.quality)<=h);
      }else{
        // Somente streams combinados (não-DASH) — evita arquivo corrompido
        stream=(data.videoStreams||[]).filter(s=>!s.videoOnly)
          .sort((a,b)=>parseInt(b.quality)-parseInt(a.quality))
          .find(s=>parseInt(s.quality)<=h);
        if(!stream){
          stream=(data.videoStreams||[]).filter(s=>!s.videoOnly)
            .sort((a,b)=>parseInt(a.quality)-parseInt(b.quality))[0];
        }
      }

      if(!stream?.url)throw new Error('Piped: formato combinado não encontrado para esta qualidade');

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
        try{
          const{done,value}=await reader.read();
          if(done){if(!res.writableEnded)res.end();return;}
          if(!res.writableEnded){if(res.write(Buffer.from(value)))pump();else res.once('drain',pump);}
        }catch(e){if(!res.writableEnded)res.end();}
      }
      pump();

    }catch(e){
      console.error('[piped fallback]',e.message);
      if(!res.headersSent)res.status(503).json({
        error:'Download falhou em ambos os métodos. Tente outra qualidade.',
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
