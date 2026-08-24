const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const { Readable } = require('stream');
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
    const version = await new Promise(r=>{
      const p=spawn(b,['--verbose','--version']);let out='',debug='';
      p.stdout.on('data',d=>{out+=d.toString();});
      p.stderr.on('data',d=>{debug+=d.toString();});
      p.on('close',c=>{
        const pluginLine=debug.split(/\r?\n/).find(line=>/PO Token Providers|Plugin directories/i.test(line));
        if(pluginLine)console.log('[yt-dlp]',pluginLine.trim());
        r(c===0?out.trim():null);
      });
      p.on('error',()=>r(null));
    });
    if(version){ytdlpBin=b;console.log('[yt-dlp] OK: %s (%s)',b,version);break;}
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

async function fetchAnonymousVisitorData(req, videoId){
  const authorization = req.get('authorization');
  if(!authorization) return null;
  const appUrl = process.env.PUBLIC_APP_URL || 'https://auto-research-shorts.darknet-web28.workers.dev';
  try{
    const response = await fetch(`${appUrl}/api/youtube-visitor?videoId=${encodeURIComponent(videoId)}`, {
      headers: { authorization },
      signal: AbortSignal.timeout(12000),
    });
    if(!response.ok){
      console.warn('[youtube visitor] Cloudflare respondeu', response.status);
      return null;
    }
    const data = await response.json();
    if(typeof data.visitorData !== 'string' || !/^[a-zA-Z0-9_\-=.%]+$/.test(data.visitorData)) return null;
    console.log('[youtube visitor] sessão anônima obtida via Cloudflare');
    return data.visitorData;
  }catch(error){
    console.warn('[youtube visitor] indisponível:', error.message);
    return null;
  }
}

// ─── Piped ────────────────────────────────────────────────────────────────────
// Lista estática só como fallback caso a API de instâncias abaixo esteja fora do ar
let PIPED = [
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.leptons.xyz',
  'https://piped-api.privacy.com.de',
  'https://pipedapi.adminforge.de',
  'https://api.piped.yt',
];

// A lista de instâncias públicas do Piped muda com frequência (instâncias saem do ar
// e novas aparecem). Em vez de manter uma lista fixa no código (que fica velha), busca
// a lista oficial atualizada no início do servidor.
(async function loadPipedInstances(){
  try {
    const r = await fetch('https://piped-instances.kavin.rocks/', { signal: AbortSignal.timeout(8000) });
    if (r.ok) {
      const list = await r.json();
      const urls = (list || []).map(i => i.api_url).filter(Boolean);
      if (urls.length) {
        PIPED = urls.slice(0, 10);
        console.log('[piped] lista de instâncias atualizada:', PIPED.length, 'instâncias ativas');
      }
    }
  } catch(e) {
    console.warn('[piped] não consegui buscar lista de instâncias, usando fallback fixo:', e.message);
  }
})();
async function pipedStreams(videoId){
  const tryOne = async (api) => {
    const r = await fetch(`${api}/streams/${videoId}`, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) throw new Error('http ' + r.status);
    const d = await r.json();
    if (d.error || !(d.videoStreams?.length || d.audioStreams?.length)) throw new Error('sem streams');
    console.log('[piped] OK:', api);
    return d;
  };
  try {
    return await Promise.any(PIPED.map(tryOne));
  } catch (e) {
    console.log('[piped] todas as instâncias falharam');
    return null;
  }
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
  const {url, quality, mode, audioFormat, audioBitrate, useCookies} = req.query;
  if(!url) return res.status(400).send('URL obrigatória');

  const isAudio = mode==='audio';
  const isMute  = mode==='mute';
  // "max" ou ausente = sem teto de altura (pega a maior disponível, ex.: 1080p+)
  const h = (quality && quality!=='max') ? parseInt(quality)||1080 : 9999;

  // ─── Caminho 1: YouTube via ytdl-core ──────────────────────────────────────
  // DESATIVADO por enquanto: o IP compartilhado do Render também está sendo
  // rate-limitado (429) pelo endpoint que o ytdl-core usa, então essa tentativa
  // só adicionava uma chamada de rede inteira desperdiçada antes de cair pro
  // yt-dlp (que já está funcionando via cookies). Reative trocando pra "true"
  // se esse bloqueio específico for embora no futuro.
  const TRY_YTDLCORE_FIRST = false;
  const videoId = extractVideoId(url);
  const visitorData = videoId ? await fetchAnonymousVisitorData(req, videoId) : null;
  if (TRY_YTDLCORE_FIRST && videoId && ytdl) {
    try {
      const info = await ytdl.getInfo(`https://www.youtube.com/watch?v=${videoId}`);
      const title = info.videoDetails?.title || null;
      let format = null, kind = 'audio';

      if (isAudio) {
        const fmts = ytdl.filterFormats(info.formats, 'audioonly')
          .sort((a,b)=>(b.audioBitrate||0)-(a.audioBitrate||0));
        format = fmts[0];
      } else if (isMute) {
        const fmts = ytdl.filterFormats(info.formats, 'videoonly')
          .filter(f => !f.height || f.height <= h)
          .sort((a,b)=>(b.height||0)-(a.height||0));
        format = fmts[0]; kind = 'video';
      } else {
        // progressivo = vídeo+áudio já mesclados num único stream, sem precisar de ffmpeg
        const fmts = ytdl.filterFormats(info.formats, 'audioandvideo')
          .filter(f => !f.height || f.height <= h)
          .sort((a,b)=>(b.height||0)-(a.height||0));
        format = fmts[0]; kind = 'video';
      }

      if (format) {
        const ext = kind === 'audio' ? (format.container || 'm4a') : (format.container || 'mp4');
        const filename = safeFilename(title, ext);
        console.log('[ytdl-core] usando itag=%s (%sp) job=youtube:%s', format.itag, format.height||'-', videoId);
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
        res.setHeader('Content-Type', (format.mimeType||'application/octet-stream').split(';')[0]);
        const stream = ytdl.downloadFromInfo(info, { format });
        stream.on('error', e => { console.warn('[ytdl-core] erro no stream:', e.message); if(!res.headersSent) res.status(500).end(); });
        req.on('close', () => stream.destroy());
        return stream.pipe(res);
      }
      console.log('[ytdl-core] nenhum formato compatível (qualidade pedida acima do progressivo disponível) — caindo pro yt-dlp');
    } catch(e) {
      console.warn('[ytdl-core] falhou, caindo pro yt-dlp:', e.message);
    }
  }

  // ─── Caminho 1.5: YouTube via Piped ─────────────────────────────────────────
  // DESATIVADO: em 2026 a rede pública de instâncias do Piped está quase morta
  // (Google vem banindo os servidores que hospedam instâncias desde 2024) — na
  // prática só sobrou 1 instância ativa e mesmo essa falha. Deixar isso ligado só
  // adicionava demora (tentativa que sempre falha) sem nenhum benefício real.
  const TRY_PIPED = false;
  if (TRY_PIPED && videoId) {
    try {
      const piped = await pipedStreams(videoId);
      if (piped) {
        let stream = null, kind = 'video';
        if (isAudio) {
          stream = (piped.audioStreams||[])
            .slice().sort((a,b)=>(b.bitrate||0)-(a.bitrate||0))[0];
          kind = 'audio';
        } else if (isMute) {
          stream = (piped.videoStreams||[])
            .filter(s => s.videoOnly && (!s.height || s.height <= h))
            .sort((a,b)=>(b.height||0)-(a.height||0))[0];
        } else {
          // progressivo (vídeo+áudio já juntos) — sem precisar mesclar com ffmpeg
          stream = (piped.videoStreams||[])
            .filter(s => s.videoOnly === false && (!s.height || s.height <= h))
            .sort((a,b)=>(b.height||0)-(a.height||0))[0];
        }

        if (stream?.url) {
          const upstream = await fetch(stream.url, { signal: AbortSignal.timeout(15000) });
          if (upstream.ok && upstream.body) {
            const ext = kind === 'audio' ? (stream.codec === 'opus' ? 'webm' : 'm4a') : 'mp4';
            const filename = safeFilename(piped.title, ext);
            console.log('[piped] usando stream %sp/%s job=youtube:%s', stream.height||'-', kind, videoId);
            res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
            res.setHeader('Content-Type', stream.mimeType || 'application/octet-stream');
            req.on('close', () => upstream.body.cancel?.());
            return Readable.fromWeb(upstream.body).pipe(res);
          }
        }
        console.log('[piped] sem formato compatível pra essa qualidade — caindo pro yt-dlp');
      }
    } catch(e) {
      console.warn('[piped] falhou, caindo pro yt-dlp:', e.message);
    }
  }

  // ─── Caminho 2: yt-dlp (YouTube em qualidades altas / merge, e todas as outras
  // plataformas — TikTok, Instagram, Facebook, Kwai, Threads, etc.) ───────────

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

  const args = [
    '--verbose',
    '--no-check-certificates',
    '--no-playlist',
    // O IP do Render recebe 429 do YouTube antes mesmo da extração. A simulação
    // do handshake/headers reais do Chrome (via curl_cffi) permite carregar a
    // página pública e obter Visitor Data anônimo sem cookies de conta.
    '--impersonate','chrome',
    // Deno (instalado no Dockerfile) resolve o "n challenge" mais rápido que Node —
    // força ele primeiro, Node fica como fallback caso o Deno falhe por algum motivo.
    '--js-runtimes','deno',
    '--js-runtimes','node',
    // O "Unable to download webpage: 429" é retentado automaticamente pelo yt-dlp
    // com backoff antes de desistir e cair pro próximo player_client — isso é o
    // que está causando os 10-20s de demora. Reduzindo as tentativas, ele desiste
    // rápido de um cliente bloqueado e já parte pro próximo.
    '--extractor-retries','1',
    '--retries','2',
    '--socket-timeout','10',
    // baixa os fragmentos (DASH/HLS) em paralelo em vez de sequencial — acelera a
    // transferência em si depois que a extração termina, sem mudar formato/qualidade
    '--concurrent-fragments','4',
  ];

  // O cliente web depende de PO Token em parte dos formatos. Com a página pública
  // carregada por impersonation, o yt-dlp obtém Visitor Data anônimo e o provedor
  // bgutil local consegue gerar o token. Não pulamos mais a webpage/configs, pois
  // era justamente isso que removia os dados necessários e deixava só 360p.
  if(videoId){
    const youtubeArgs = [
      'player_client=web,web_embedded,mweb,android_vr',
      'player_skip=webpage,configs',
      visitorData ? `visitor_data=${visitorData}` : null,
    ].filter(Boolean).join(';');
    args.push(
      '--extractor-args',`youtube:${youtubeArgs}`,
      '--extractor-args','youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416'
    );
  }

  // Cookies de conta só são usados quando solicitados explicitamente. Para vídeos públicos,
  // cookies expirados/rotacionados pioram a extração e podem fazer o YouTube limitar a conta.
  const cookiesPath = YTDLP_COOKIES_PATH;
  if(useCookies==='true' && cookiesPath && fs.existsSync(cookiesPath)){
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
    if(/\[download\].*%|ERROR|WARNING|ffmpeg|format|\[pot|PO Token|player client/i.test(s))
      console.log('[yt-dlp stderr]', s.slice(0,150));
  });

  proc.on('close', code => {
    if(code !== 0){
      console.warn('[yt-dlp] falhou code=%d\n%s', code, stderrBuf.slice(-500));
      if(!res.headersSent){
        const isRateLimited = /429|Too Many Requests/i.test(stderrBuf);
        const isBotCheck = /Sign in to confirm|not a bot/i.test(stderrBuf);
        const invalidCookies = /cookies are no longer valid|cookies.*rotated/i.test(stderrBuf);
        res.status(isRateLimited ? 429 : 500).json({
          error: invalidCookies
            ? 'A sessão do YouTube configurada no servidor expirou. Tente novamente sem autenticação de conta.'
            : isRateLimited || isBotCheck
              ? 'O YouTube limitou temporariamente o servidor. Aguarde alguns minutos e tente novamente.'
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

  // `req.close` também dispara após uma requisição GET normal e podia encerrar o yt-dlp
  // durante downloads mais demorados. Só interrompemos se a resposta for abandonada.
  res.on('close', () => {
    if(!res.writableEnded){
      try{ proc.kill(); }catch(e){}
    }
  });
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
