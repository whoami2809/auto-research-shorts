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
    if(ok){ytdlpBin=b;console.log('[yt-dlp] OK:',b);break;}
  }
  if(!ytdlpBin) console.warn('[yt-dlp] não encontrado');
})();

const frameCache=new Map(), FRAME_TTL=15*60*1000;
function cleanFrames(){const now=Date.now();for(const[id,f]of frameCache)if(now>f.exp)frameCache.delete(id);}

function extractVideoId(url){
  for(const p of[/youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,/youtu\.be\/([a-zA-Z0-9_-]{11})/,/youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})/,/[?&]v=([a-zA-Z0-9_-]{11})/]){
    const m=url.match(p); if(m) return m[1];
  } return null;
}

function safeFilename(title, ext){
  return ((title||'video').replace(/[<>:"/\\|?*\x00-\x1f]/g,'').trim().replace(/\s+/g,'_').slice(0,80)||'video')+'.'+ext;
}

// ─── Piped ────────────────────────────────────────────────────────────────────
const PIPED = [
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.adminforge.de',
  'https://piped-api.garudalinux.org',
  'https://api.piped.yt',
  'https://pipedapi.tokhmi.xyz',
];
async function pipedStreams(videoId){
  for(const api of PIPED){
    try{
      const r=await fetch(`${api}/streams/${videoId}`,{signal:AbortSignal.timeout(8000)});
      if(!r.ok) continue;
      const d=await r.json();
      if(!d.error&&(d.videoStreams?.length||d.audioStreams?.length)){ console.log('[piped] OK:',api); return d; }
    }catch(e){ console.log('[piped fail]',api,e.message.slice(0,50)); }
  }
  return null;
}

// ─── /api/info ────────────────────────────────────────────────────────────────
app.get('/api/info',async(req,res)=>{
  const{url}=req.query; const videoId=extractVideoId(url);
  if(!videoId) return res.status(400).json({error:'Link inválido'});
  try{
    const r=await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`);
    if(!r.ok) throw new Error();
    const d=await r.json(); res.json({videoId,title:d.title||'',channel:d.author_name||''});
  }catch{ res.json({videoId,title:'',channel:''}); }
});

// ─── /api/transcript ──────────────────────────────────────────────────────────
app.get('/api/transcript',async(req,res)=>{
  const{url}=req.query; const videoId=extractVideoId(url);
  if(!videoId) return res.status(400).json({error:'Link inválido'});
  try{
    const r=await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false',{
      method:'POST',headers:{'Content-Type':'application/json','User-Agent':'Mozilla/5.0'},
      body:JSON.stringify({videoId,context:{client:{clientName:'WEB',clientVersion:'2.20240101.01.00',hl:'en',gl:'US'}}}),
    });
    const data=await r.json();
    const tracks=data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if(!tracks?.length) throw new Error('sem legenda');
    const track=tracks.find(c=>c.languageCode==='pt')||tracks.find(c=>c.languageCode==='en')||tracks[0];
    let cu=track.baseUrl; if(!/[?&]fmt=/.test(cu)) cu+='&fmt=srv3';
    const xml=await(await fetch(cu)).text();
    const texts=[]; let m; const pR=/<p\b[^>]*>([\s\S]*?)<\/p>/g;
    while((m=pR.exec(xml))!==null){
      const t=m[1].replace(/<[^>]+>/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#39;/g,"'").replace(/\s+/g,' ').trim();
      if(t) texts.push(t);
    }
    if(!texts.length) throw new Error('sem texto');
    res.json({transcript:texts.join(' '),language:track.languageCode});
  }catch(e){ res.status(404).json({error:'Sem legendas. '+e.message}); }
});

// ─── /api/audio (Whisper) ─────────────────────────────────────────────────────
app.get('/api/audio',async(req,res)=>{
  if(!ytdl) return res.status(503).json({error:'ytdl indisponível'});
  const{url}=req.query; const videoId=extractVideoId(url);
  if(!videoId) return res.status(400).json({error:'Link inválido'});
  try{
    const info=await ytdl.getInfo(`https://www.youtube.com/watch?v=${videoId}`);
    const fmts=ytdl.filterFormats(info.formats,'audioonly').sort((a,b)=>(a.audioBitrate||999)-(b.audioBitrate||999));
    if(!fmts.length) throw new Error('sem áudio');
    res.setHeader('Content-Type',(fmts[0].mimeType||'audio/mp4').split(';')[0]);
    const stream=ytdl.downloadFromInfo(info,{format:fmts[0]});
    stream.on('error',()=>{ if(!res.headersSent) res.status(500).end(); });
    req.on('close',()=>stream.destroy()); stream.pipe(res);
  }catch(e){ if(!res.headersSent) res.status(500).json({error:e.message}); }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  /api/video-dl
//
//  SOLUÇÃO CORRETA:
//
//  yt-dlp stdout + formatos PROGRESSIVOS do YouTube
//  ─────────────────────────────────────────────────
//  Formatos progressivos = arquivo único, sem DASH, sem muxing, sem ffmpeg:
//    22  → 720p  H.264+AAC  MP4 completo  ← preferido
//    18  → 360p  H.264+AAC  MP4 completo  ← fallback universal
//    140 → 128kbps M4A áudio
//    136 → 720p vídeo-only
//    137 → 1080p vídeo-only
//
//  Por que stdout e não arquivo temporário?
//  → Render free tier tem timeout de 90s por request
//  → Arquivo temp: servidor espera 100% baixado antes de enviar → timeout
//  → stdout: streaming começa imediatamente → sem timeout
//
//  Por que progressivo e não DASH?
//  → DASH = vídeo+áudio separados → precisa de ffmpeg para muxar
//  → Sem ffmpeg → arquivo fragmentado/corrompido
//  → Progressivo = arquivo único, stream byte-a-byte → sempre válido
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/video-dl',async(req,res)=>{
  const {url, quality, mode, title} = req.query;
  if(!url) return res.status(400).send('URL obrigatória');

  const isAudio = mode==='audio';
  const isMute  = mode==='mute';
  const h = (quality && quality!=='max') ? parseInt(quality)||720 : 9999;

  // Formatos progressivos APENAS (MP4 completo, sem DASH, sem ffmpeg)
  let fmtStr, fileExt;
  if(isAudio){
    fmtStr  = '140/bestaudio[ext=m4a]/bestaudio';
    fileExt = 'm4a';
  } else if(isMute){
    fmtStr  = h>=1080 ? '137/bestvideo[height<=1080][ext=mp4]'
            : h>=720  ? '136/137/bestvideo[height<=720][ext=mp4]'
            : h>=480  ? '135/bestvideo[height<=480][ext=mp4]'
            :           '134/bestvideo[height<=360][ext=mp4]';
    fileExt = 'mp4';
  } else {
    // 22 = 720p H.264+AAC progressivo (não-DASH)
    // 18 = 360p H.264+AAC progressivo (disponível em ~100% dos vídeos)
    fmtStr  = h>=720 ? '22/18' : '18';
    fileExt = 'mp4';
  }

  const filename    = safeFilename(title, fileExt);
  const contentType = isAudio ? 'audio/mp4' : 'video/mp4';

  // ── yt-dlp: stdout streaming (inicia imediatamente, sem timeout do Render) ───
  if(ytdlpBin){
    const args = [
      '--extractor-args','youtube:player_client=ios,web',
      '--no-check-certificates',
      '-f', fmtStr,
      '--no-playlist',
      '-o', '-',          // stdout — streaming direto para o browser
      url,
    ];
    console.log('[yt-dlp] format=%s file=%s', fmtStr, filename);

    const proc = spawn(ytdlpBin, args);
    let headersSent = false;
    let stderrBuf   = '';

    // Primeiro chunk: manda headers e começa a stremar
    proc.stdout.once('data', chunk => {
      if(!res.headersSent){
        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        headersSent = true;
      }
      res.write(chunk);
    });
    proc.stdout.on('data', chunk => { if(headersSent) res.write(chunk); });
    proc.stdout.on('end',  ()     => { if(!res.writableEnded) res.end(); });

    proc.stderr.on('data', d => {
      const s = d.toString().trim();
      stderrBuf += s + '\n';
      if(/\[download\].*%|ERROR|WARNING|ffmpeg|format/i.test(s))
        console.log('[yt-dlp stderr]', s.slice(0,150));
    });

    proc.on('close', code => {
      if(code !== 0 && !headersSent){
        // yt-dlp falhou antes de enviar qualquer byte → tenta Piped
        console.warn('[yt-dlp] falhou code=%d\n%s', code, stderrBuf.slice(-500));
        pipedFallback();
      } else if(!res.writableEnded){
        res.end();
      }
    });

    req.on('close', () => { try{ proc.kill(); }catch(e){} });
    return;
  }

  // ── Piped (fallback quando yt-dlp não está instalado) ─────────────────────
  pipedFallback();

  async function pipedFallback(){
    if(res.headersSent || res.writableEnded) return;

    const videoId = extractVideoId(url);
    if(!videoId){
      return res.status(400).json({error:'Plataforma não suportada sem yt-dlp instalado'});
    }

    try{
      const data = await pipedStreams(videoId);
      if(!data) throw new Error('Todas as instâncias Piped falharam');

      let stream = null;
      if(isAudio){
        stream = (data.audioStreams||[]).find(s=>s.mimeType?.includes('mp4'))
              || (data.audioStreams||[])[0];
      } else if(isMute){
        stream = (data.videoStreams||[])
          .filter(s=>s.videoOnly && parseInt(s.quality)<=h)
          .sort((a,b)=>parseInt(b.quality)-parseInt(a.quality))[0]
          || (data.videoStreams||[]).filter(s=>s.videoOnly)
          .sort((a,b)=>parseInt(b.quality)-parseInt(a.quality))[0];
      } else {
        // Preferência: stream combinado (videoOnly=false)
        stream = (data.videoStreams||[])
          .filter(s=>!s.videoOnly && parseInt(s.quality)<=h)
          .sort((a,b)=>parseInt(b.quality)-parseInt(a.quality))[0];
        // Fallback: qualquer combinado disponível
        if(!stream){
          stream = (data.videoStreams||[])
            .filter(s=>!s.videoOnly)
            .sort((a,b)=>parseInt(a.quality)-parseInt(b.quality))[0];
        }
      }

      if(!stream?.url) throw new Error('Nenhum stream disponível nesta qualidade via Piped');

      console.log('[piped] stream quality=%s videoOnly=%s', stream.quality, stream.videoOnly);

      const upstream = await fetch(stream.url,{
        headers:{'User-Agent':'Mozilla/5.0','Referer':'https://piped.video/'},
        signal:AbortSignal.timeout(90000),
      });
      if(!upstream.ok) throw new Error(`Piped upstream HTTP ${upstream.status}`);

      const ct = upstream.headers.get('Content-Type') || contentType;
      const cl = upstream.headers.get('Content-Length');
      res.setHeader('Content-Type', ct);
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      if(cl) res.setHeader('Content-Length', cl);

      const reader = upstream.body.getReader();
      req.on('close', ()=>reader.cancel());
      const pump = async()=>{
        try{
          const{done,value} = await reader.read();
          if(done){ if(!res.writableEnded) res.end(); return; }
          if(!res.writableEnded){ if(res.write(Buffer.from(value))) pump(); else res.once('drain',pump); }
        }catch(e){ if(!res.writableEnded) res.end(); }
      };
      pump();

    }catch(e){
      console.error('[piped fallback]', e.message);
      if(!res.headersSent)
        res.status(503).json({error:'Download falhou nos dois métodos. '+e.message});
    }
  }
});

// ─── /api/frame (Lens) ────────────────────────────────────────────────────────
app.post('/api/frame',express.raw({type:'*/*',limit:'10mb'}),(req,res)=>{
  cleanFrames();
  while(frameCache.size>=300){
    const o=[...frameCache.entries()].sort((a,b)=>a[1].exp-b[1].exp)[0];
    if(o) frameCache.delete(o[0]);
  }
  const id=Date.now().toString(36)+Math.random().toString(36).substr(2,8);
  frameCache.set(id,{data:req.body,exp:Date.now()+FRAME_TTL});
  res.json({id,url:`/api/frame/${id}`});
});
app.get('/api/frame/:id',(req,res)=>{
  cleanFrames(); const frame=frameCache.get(req.params.id);
  if(!frame) return res.status(404).send('Frame expirado');
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Content-Type','image/png');
  res.setHeader('Cache-Control','public, max-age=900');
  res.send(frame.data);
});

app.listen(PORT, ()=> console.log(`Porta ${PORT} — yt-dlp: ${ytdlpBin||'NÃO ENCONTRADO'}`));
