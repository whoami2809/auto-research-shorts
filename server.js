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
    if (ok){ytdlpBin=b;console.log('[yt-dlp] OK:',b);break;}
  }
  if(!ytdlpBin)console.warn('[yt-dlp] não encontrado');
})();

// ─── Limpa temp files antigos ao iniciar ──────────────────────────────────────
try {
  fs.readdirSync(os.tmpdir())
    .filter(f=>f.startsWith('zyt_'))
    .forEach(f=>{try{fs.unlinkSync(path.join(os.tmpdir(),f));}catch(e){}});
} catch(e){}

const frameCache=new Map();
const FRAME_TTL=15*60*1000;
function cleanFrames(){const now=Date.now();for(const[id,f]of frameCache)if(now>f.exp)frameCache.delete(id);}

function extractVideoId(url){
  for(const p of[/youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,/youtu\.be\/([a-zA-Z0-9_-]{11})/,/youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})/,/[?&]v=([a-zA-Z0-9_-]{11})/]){
    const m=url.match(p);if(m)return m[1];}return null;}

function safeFilename(title,ext){
  const s=(title||'video')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g,'')  // caracteres ilegais
    .replace(/\s+/g,'_')
    .slice(0,80)||'video';
  return s+'.'+ext;
}

// ─── Piped ───────────────────────────────────────────────────────────────────
const PIPED=['https://pipedapi.kavin.rocks','https://pipedapi.adminforge.de','https://piped-api.garudalinux.org','https://api.piped.yt','https://pipedapi.tokhmi.xyz'];
async function pipedStreams(videoId){
  for(const api of PIPED){
    try{
      const r=await fetch(`${api}/streams/${videoId}`,{signal:AbortSignal.timeout(8000)});
      if(!r.ok)continue;
      const d=await r.json();
      if(!d.error&&(d.videoStreams?.length||d.audioStreams?.length)){console.log('[piped] OK:',api);return d;}
    }catch(e){console.log('[piped fail]',api,e.message.slice(0,50));}
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

// ═══════════════════════════════════════════════════════════════════════════════
//  /api/video-dl
//
//  SOLUÇÃO DEFINITIVA para arquivo corrompido:
//
//  Usar APENAS formatos PROGRESSIVOS do YouTube:
//    format 22 = 720p  H.264+AAC  MP4 completo (não-DASH, não precisa de ffmpeg)
//    format 18 = 360p  H.264+AAC  MP4 completo (não-DASH, não precisa de ffmpeg)
//    format 140 = M4A  128kbps   áudio completo
//    format 136/135/134 = vídeo-only progressivo
//
//  Esses formatos são MP4s nativos, não fragmentados, abrem em qualquer player.
//  Não requerem muxing (sem ffmpeg necessário).
//
//  Fluxo: yt-dlp → arquivo temp → serve → deleta temp
//         (arquivo temp garante que 100% baixado antes de servir)
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/video-dl', async(req,res)=>{
  const {url, quality, mode, title} = req.query;
  if(!url) return res.status(400).send('URL obrigatória');

  const isAudio = mode==='audio';
  const isMute  = mode==='mute';
  const h = (quality && quality!=='max') ? parseInt(quality)||720 : 9999;

  // ── Seleção de formato: SOMENTE progressivos (MP4 completo, sem ffmpeg) ───────
  //
  //  Formatos progressivos do YouTube (vídeo+áudio num arquivo só):
  //    22  → 720p  MP4  H.264+AAC  (~30-80MB para Shorts)
  //    18  → 360p  MP4  H.264+AAC  (~10-25MB para Shorts)
  //
  //  Formatos progressivos de vídeo-only:
  //    137 → 1080p MP4  H.264      (~50-120MB para Shorts)
  //    136 → 720p  MP4  H.264
  //    135 → 480p  MP4  H.264
  //    134 → 360p  MP4  H.264
  //
  //  Formato de áudio:
  //    140 → M4A   128kbps   (~3-8MB para Shorts)
  //
  let fmtStr, fileExt;

  if(isAudio){
    fmtStr  = '140/bestaudio[ext=m4a]/bestaudio[acodec=mp4a]/bestaudio';
    fileExt = 'm4a';
  } else if(isMute){
    if(h>=1080)      fmtStr='137/136/bestvideo[ext=mp4]';
    else if(h>=720)  fmtStr='136/137/bestvideo[height<=720][ext=mp4]/bestvideo[height<=720]';
    else if(h>=480)  fmtStr='135/bestvideo[height<=480][ext=mp4]';
    else             fmtStr='134/133/bestvideo[height<=360][ext=mp4]';
    fileExt = 'mp4';
  } else {
    // Vídeo + Áudio: usa APENAS progressivos (22 ou 18)
    // Nota: sem ffmpeg não podemos fazer 1080p com áudio — max é 720p progressivo
    if(h>=720 || h>=9999) fmtStr='22/18';
    else                  fmtStr='18';
    fileExt = 'mp4';
  }

  const filename = safeFilename(title, fileExt);
  const contentType = isAudio ? 'audio/mp4' : 'video/mp4';
  const tmpFile = path.join(os.tmpdir(), `zyt_${Date.now()}.${fileExt}`);

  // ── Método 1: yt-dlp com arquivo temporário ──────────────────────────────────
  if(ytdlpBin){
    const args = [
      '--extractor-args','youtube:player_client=ios,web',
      '--no-check-certificates',
      '-f', fmtStr,
      '--no-playlist',
      '--output', tmpFile,
      url
    ];

    console.log(`[yt-dlp] format=${fmtStr} file=${tmpFile}`);

    const proc = spawn(ytdlpBin, args);
    let stderrBuf = '';
    proc.stderr.on('data', d => {
      const s = d.toString().trim();
      stderrBuf += s + '\n';
      if(s.match(/\[download\].*%|ERROR|WARNING|Merging/i))
        console.log('[yt-dlp]', s.slice(0,120));
    });

    req.on('close', ()=>{ try{proc.kill();}catch(e){} });

    proc.on('close', code => {
      // Verifica arquivo criado
      let actualFile = tmpFile;
      if(!fs.existsSync(tmpFile)){
        // Tenta mesma base com outra extensão (ex: .webm)
        const base = tmpFile.replace(/\.\w+$/, '');
        for(const ext2 of ['.mp4','.m4a','.webm','.mkv']){
          if(fs.existsSync(base+ext2)){actualFile=base+ext2;break;}
        }
      }

      if(code===0 && fs.existsSync(actualFile)){
        const stat = fs.statSync(actualFile);
        const realExt = path.extname(actualFile).slice(1)||fileExt;
        const realMime = {m4a:'audio/mp4',webm:'video/webm',mkv:'video/x-matroska'}[realExt]||'video/mp4';
        const realName = safeFilename(title, realExt);

        console.log(`[yt-dlp] OK — ${stat.size} bytes → ${realName}`);

        res.setHeader('Content-Type', realMime);
        res.setHeader('Content-Disposition', `attachment; filename="${realName}"`);
        res.setHeader('Content-Length', stat.size);

        const rs = fs.createReadStream(actualFile);
        rs.pipe(res);
        rs.on('close', ()=>{ try{fs.unlinkSync(actualFile);}catch(e){} });
        rs.on('error', ()=>{ try{fs.unlinkSync(actualFile);}catch(e){}; if(!res.writableEnded)res.end(); });
        req.on('close', ()=>{ try{fs.unlinkSync(actualFile);}catch(e){} });
      } else {
        try{fs.unlinkSync(actualFile);}catch(e){}
        console.warn(`[yt-dlp] falhou code=${code} stderr:\n${stderrBuf.slice(-500)}`);
        pipedFallback();
      }
    });
    return;
  }

  // ── Método 2: Piped.video ────────────────────────────────────────────────────
  pipedFallback();

  async function pipedFallback(){
    if(res.headersSent||res.writableEnded)return;
    const videoId = extractVideoId(url);
    if(!videoId){
      return res.status(400).json({error:'Plataforma não suportada sem yt-dlp'});
    }
    try{
      const data = await pipedStreams(videoId);
      if(!data) throw new Error('Piped indisponível');

      let stream = null;
      if(isAudio){
        // Pega audioStream com URL de container MP4/M4A
        stream = (data.audioStreams||[]).find(s=>s.mimeType?.includes('mp4'))||(data.audioStreams||[])[0];
      } else if(isMute){
        stream = (data.videoStreams||[])
          .filter(s=>s.videoOnly && parseInt(s.quality)<=h)
          .sort((a,b)=>parseInt(b.quality)-parseInt(a.quality))[0];
      } else {
        // SOMENTE streams combinados (não-DASH, videoOnly=false)
        stream = (data.videoStreams||[])
          .filter(s=>!s.videoOnly && parseInt(s.quality)<=h)
          .sort((a,b)=>parseInt(b.quality)-parseInt(a.quality))[0];
        if(!stream){
          stream = (data.videoStreams||[])
            .filter(s=>!s.videoOnly)
            .sort((a,b)=>parseInt(a.quality)-parseInt(b.quality))[0];
        }
      }

      if(!stream?.url) throw new Error('Nenhum stream combinado disponível nesta qualidade');

      const upstream = await fetch(stream.url,{
        headers:{'User-Agent':'Mozilla/5.0','Referer':'https://piped.video/'},
        signal:AbortSignal.timeout(90000),
      });
      if(!upstream.ok) throw new Error(`Piped HTTP ${upstream.status}`);

      const ct = upstream.headers.get('Content-Type')||contentType;
      const cl = upstream.headers.get('Content-Length');
      res.setHeader('Content-Type', ct);
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      if(cl) res.setHeader('Content-Length', cl);

      const reader = upstream.body.getReader();
      req.on('close',()=>reader.cancel());
      const pump = async()=>{
        const{done,value}=await reader.read();
        if(done){if(!res.writableEnded)res.end();return;}
        if(!res.writableEnded){if(res.write(Buffer.from(value)))pump();else res.once('drain',pump);}
      };
      pump().catch(()=>{if(!res.writableEnded)res.end();});

    }catch(e){
      console.error('[piped]',e.message);
      if(!res.headersSent) res.status(503).json({error:'Download falhou. '+e.message});
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
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Content-Type','image/png');
  res.setHeader('Cache-Control','public, max-age=900');
  res.send(frame.data);
});

app.listen(PORT,()=>console.log(`Servidor na porta ${PORT} — yt-dlp: ${ytdlpBin||'não encontrado'}`));
