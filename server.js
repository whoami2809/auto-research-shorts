const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors()); app.use(express.json()); app.use(express.static('public'));

const DOWNLOAD_DIR = path.join(__dirname, 'downloads');
fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

// ─── Cookies do YouTube ──────────────────────────────────────────────────────
// O Secret File do Render fica em /etc/secrets/cookies.txt, que é READ-ONLY.
// O yt-dlp precisa reescrever o arquivo de cookies após o uso (refresh de sessão),
// então copiamos pra uma cópia gravável e usamos essa cópia nas chamadas.
let YTDLP_COOKIES_PATH = null;
(function setupCookies(){
  const src = process.env.YTDLP_COOKIES_FILE;
  if (!src || !fs.existsSync(src)) { console.log('[cookies] YTDLP_COOKIES_FILE não configurado'); return; }
  try {
    const dest = path.join(DOWNLOAD_DIR, 'cookies-writable.txt');
    fs.copyFileSync(src, dest);
    YTDLP_COOKIES_PATH = dest;
    console.log('[cookies] copiado pra local gravável:', dest);
  } catch(e) {
    console.warn('[cookies] falha ao copiar:', e.message);
  }
})();

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

// ─── /api/tags ───────────────────────────────────────────────────────────────
app.get('/api/tags',async(req,res)=>{
  const{url}=req.query; const videoId=extractVideoId(url);
  if(!videoId) return res.status(400).json({error:'Link inválido'});
  try{
    const r=await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false',{
      method:'POST',headers:{'Content-Type':'application/json','User-Agent':'Mozilla/5.0'},
      body:JSON.stringify({videoId,context:{client:{clientName:'WEB',clientVersion:'2.20240101.01.00',hl:'pt',gl:'BR'}}}),
    });
    const data=await r.json();
    const tags=data.videoDetails?.keywords||[];
    const desc=data.videoDetails?.shortDescription||'';
    // Extrai hashtags do texto (#palavra)
    const hashtags=[...new Set((desc.match(/#[\w\u00C0-\u024F]+/g)||[]))].slice(0,30);
    res.json({tags,hashtags,description:desc.slice(0,600)});
  }catch(e){ res.json({tags:[],hashtags:[],description:''}); }
});

// ─── /api/translate ───────────────────────────────────────────────────────────
// Usa Claude para tradução natural (requer ANTHROPIC_API_KEY no Render)
// Fallback: retorna erro 503 → frontend usa Google Translate
app.post('/api/translate',async(req,res)=>{
  const{text,targetLang}=req.body;
  if(!text) return res.status(400).json({error:'Texto obrigatório'});
  const key=process.env.ANTHROPIC_API_KEY;
  if(!key) return res.status(503).json({error:'ANTHROPIC_API_KEY não configurada'});
  const langMap={pt:'Português do Brasil',en:'English',es:'Español',fr:'Français',de:'Deutsch',it:'Italiano',ja:'Japonês',ko:'Coreano'};
  const tl=langMap[targetLang]||targetLang;
  try{
    const r=await fetch('https://api.anthropic.com/v1/messages',{
      method:'POST',
      headers:{'Content-Type':'application/json','x-api-key':key,'anthropic-version':'2023-06-01'},
      body:JSON.stringify({
        model:'claude-haiku-4-5-20251001',
        max_tokens:2000,
        messages:[{role:'user',content:`Você é um tradutor especializado em conteúdo de vídeos curtos para redes sociais (YouTube Shorts, TikTok, Reels).

Traduza o texto abaixo para ${tl}.

Regras:
- Tradução natural e fluida — adapte ao estilo falado, não ao literário
- Preserve hashtags (#palavra) exatamente como estão, sem traduzir
- Adicione pontuação adequada (o texto pode ser transcrição sem pontuação)
- Adapte expressões idiomáticas para equivalentes naturais na língua alvo
- Mantenha tom e energia do original (pode ser informal, entusiasmado, narrativo)
- Retorne APENAS o texto traduzido, sem explicações ou prefixos

Texto:
${text.slice(0,3000)}`}]
      })
    });
    const d=await r.json();
    if(d.content&&d.content[0]) return res.json({translation:d.content[0].text,model:'claude'});
    throw new Error('Resposta inválida');
  }catch(e){
    console.error('[translate claude]',e.message);
    res.status(500).json({error:e.message});
  }
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
//  Fora do YouTube (TikTok, Instagram, Facebook, Kwai, etc.), usamos seletores
//  genéricos do yt-dlp (best/bestaudio/bestvideo). Essas plataformas quase
//  sempre entregam o vídeo já como um único MP4 mesclado, então não é
//  necessário DASH/merge na maioria dos casos — e quando for, o ffmpeg
//  instalado no container resolve automaticamente.
//
//  Por que stdout e não arquivo temporário?
//  → Render free tier tem timeout de 90s por request
//  → Arquivo temp: servidor espera 100% baixado antes de enviar → timeout
//  → stdout: streaming começa imediatamente → sem timeout
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/video-dl',async(req,res)=>{
  const {url, quality, mode, audioFormat, audioBitrate} = req.query;
  if(!url) return res.status(400).send('URL obrigatória');

  const isAudio = mode==='audio';
  const isMute  = mode==='mute';
  // "max" ou ausente = sem teto de altura (pega a maior disponível, ex.: 1080p+)
  const h = (quality && quality!=='max') ? parseInt(quality)||1080 : 9999;

  // Seletor de formato único e genérico, funciona igual em qualquer plataforma (YouTube,
  // TikTok, Instagram, Facebook, Kwai, Threads...). Como sempre baixamos pra arquivo
  // temporário (em vez de streamar puro pro stdout), o yt-dlp/ffmpeg pode mesclar
  // vídeo+áudio com segurança em qualquer qualidade — inclusive 4K/8K, se disponível.
  let fmtStr;
  if(isAudio){
    fmtStr = 'bestaudio/best';
  } else if(isMute){
    fmtStr = `bestvideo[height<=${h}][ext=mp4]/bestvideo[height<=${h}]/bestvideo`;
  } else {
    fmtStr = `bestvideo[height<=${h}]+bestaudio/best[height<=${h}]/best`;
  }

  if(!ytdlpBin){
    return res.status(503).json({error:'yt-dlp não está disponível no servidor'});
  }

  const jobId = Date.now().toString(36)+Math.random().toString(36).slice(2,8);
  // %(title)s embutido no template = o próprio yt-dlp nomeia o arquivo com o título real
  // do vídeo (obtido dos metadados da plataforma), então não dependemos mais do frontend
  // adivinhar/buscar o título. Limitado a 150 bytes pra evitar nomes gigantes.
  const outTemplate = path.join(DOWNLOAD_DIR, `${jobId}__%(title).150B.%(ext)s`);

  // YouTube passou a exigir verificação extra ("Sign in to confirm you're not a bot") em
  // IPs de datacenter como os do Render. Tentamos vários "clientes" do player em cascata —
  // cada um tem um comportamento de verificação diferente, então aumenta a chance de um
  // deles passar sem precisar de cookies. Se mesmo assim falhar, dá pra configurar cookies
  // reais (ver YTDLP_COOKIES_FILE abaixo) — essa é a solução definitiva pro bloqueio.
  const extractorArgs = 'youtube:player_client=ios,android,tv_embedded,web_embedded,web';

  const args = [
    '--extractor-args', extractorArgs,
    '--no-check-certificates',
    '--no-playlist',
    // usa o Node.js já instalado na imagem pra resolver o "n challenge" do YouTube.
    // Os scripts EJS agora vêm embutidos via pip (yt-dlp-ejs), sem depender do
    // GitHub em runtime — ver Dockerfile.
    '--js-runtimes','node',
  ];

  // Cookies opcionais — se o arquivo existir (configurado via Secret File no Render +
  // variável de ambiente YTDLP_COOKIES_FILE apontando pro caminho), usamos pra autenticar
  // como uma conta logada de verdade, o que resolve o bloqueio de bot do YouTube de vez.
  const cookiesPath = YTDLP_COOKIES_PATH;
  if(cookiesPath && fs.existsSync(cookiesPath)){
    args.push('--cookies', cookiesPath);
  }

  if(isAudio){
    const fmt = ['mp3','opus','m4a'].includes(audioFormat) ? audioFormat : 'm4a';
    const kbps = parseInt(audioBitrate) || 128;
    args.push('-f', fmtStr, '-x', '--audio-format', fmt, '--audio-quality', `${kbps}K`);
  } else {
    args.push('--merge-output-format','mp4', '-f', fmtStr);
  }
  args.push('-o', outTemplate, url);

  console.log('[yt-dlp] format=%s job=%s', fmtStr, jobId);

  const proc = spawn(ytdlpBin, args);
  let stderrBuf = '';
  proc.stderr.on('data', d => {
    const s = d.toString().trim();
    stderrBuf += s + '\n';
    if(/\[download\].*%|ERROR|WARNING|ffmpeg|format/i.test(s))
      console.log('[yt-dlp stderr]', s.slice(0,150));
  });

  proc.on('close', code => {
    if(code !== 0){
      console.warn('[yt-dlp] falhou code=%d\n%s', code, stderrBuf.slice(-500));
      if(!res.headersSent){
        const isBotCheck = /Sign in to confirm|not a bot/i.test(stderrBuf);
        res.status(500).json({
          error: isBotCheck
            ? 'O YouTube bloqueou o servidor por verificação anti-bot. Configure cookies (YTDLP_COOKIES_FILE) para resolver definitivamente.'
            : 'Falha no download. '+stderrBuf.slice(-300)
        });
      }
      return;
    }

    // Descobre o arquivo real gerado — nome já vem com o título verdadeiro do vídeo,
    // graças ao %(title)s no template de saída.
    fs.readdir(DOWNLOAD_DIR, (err, files) => {
      const match = !err && files.find(f => f.startsWith(jobId + '__'));
      if(!match){
        if(!res.headersSent) res.status(500).json({error:'Arquivo não encontrado após download'});
        return;
      }
      const filePath   = path.join(DOWNLOAD_DIR, match);
      const ext        = path.extname(match).slice(1) || (isAudio ? 'm4a' : 'mp4');
      const realTitle  = match.slice((jobId + '__').length, -(ext.length + 1));
      const filename   = safeFilename(realTitle, ext);

      res.download(filePath, filename, downloadErr => {
        if(downloadErr) console.error('[video-dl] erro ao enviar arquivo:', downloadErr.message);
        fs.unlink(filePath, () => {}); // limpeza — disco do Render é efêmero mesmo, mas evita lixo entre requests
      });
    });
  });

  req.on('close', () => { try{ proc.kill(); }catch(e){} });
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
