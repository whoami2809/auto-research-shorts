const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

let ytdl = null;
try { ytdl = require('@distube/ytdl-core'); } catch(e) {}

let ytdlpBin = null;
(async () => {
  for (const b of ['yt-dlp', '/usr/local/bin/yt-dlp', `${process.env.HOME}/.local/bin/yt-dlp`]) {
    const ok = await new Promise(r => { const p=spawn(b,['--version']); p.on('close',c=>r(c===0)); p.on('error',()=>r(false)); });
    if (ok) { ytdlpBin = b; break; }
  }
})();

// ─── Cache de frames para Google Lens ────────────────────────────────────────
const frameCache = new Map();
const FRAME_TTL = 15 * 60 * 1000;
function cleanFrames() { const now=Date.now(); for(const[id,f]of frameCache)if(now>f.exp)frameCache.delete(id); }

function extractVideoId(url) {
  for (const p of [/youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,/youtu\.be\/([a-zA-Z0-9_-]{11})/,/youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})/,/[?&]v=([a-zA-Z0-9_-]{11})/]) {
    const m = url.match(p); if (m) return m[1];
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════
// COBALT — instâncias públicas sem autenticação
// ═══════════════════════════════════════════════════════════════════════
let cobaltInstances = [];
let cobaltFetched = 0;

// Instâncias de fallback (caso a lista dinâmica falhe)
const COBALT_FALLBACKS = [
  'https://cobalt.canine.tools',
  'https://cobalt.api.beedev.win',
  'https://co.wuk.sh',
];

async function loadCobaltInstances() {
  if (cobaltInstances.length > 0 && Date.now() - cobaltFetched < 30 * 60 * 1000) return cobaltInstances;
  try {
    const r = await fetch('https://instances.cobalt.best/api', { signal: AbortSignal.timeout(8000) });
    const data = await r.json();
    const list = data
      .filter(i => i.online && i.info?.auth === false)
      .map(i => `${i.protocol}://${i.api}`);
    if (list.length > 0) { cobaltInstances = list; cobaltFetched = Date.now(); }
    return cobaltInstances.length > 0 ? cobaltInstances : COBALT_FALLBACKS;
  } catch(e) {
    return cobaltInstances.length > 0 ? cobaltInstances : COBALT_FALLBACKS;
  }
}

// Tenta baixar via cobalt (percorre instâncias até uma funcionar)
async function cobaltRequest(url, quality, mode, audioFormat) {
  const instances = await loadCobaltInstances();
  const body = {
    url,
    videoQuality: quality || '720',
    downloadMode: mode || 'auto',       // 'auto' | 'audio' | 'mute'
    audioFormat: audioFormat || 'mp3',
    filenameStyle: 'pretty',
    alwaysProxy: false,
  };

  const errors = [];
  for (const inst of instances.slice(0, 8)) {
    try {
      const r = await fetch(`${inst}/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) { errors.push(`${inst}: HTTP ${r.status}`); continue; }
      const d = await r.json();
      if ((d.status === 'tunnel' || d.status === 'redirect' || d.status === 'stream') && d.url) {
        console.log(`[cobalt] OK via ${inst}`);
        return d;
      }
      if (d.error) errors.push(`${inst}: ${d.error?.code || d.error}`);
    } catch(e) { errors.push(`${inst}: ${e.message}`); }
  }
  throw new Error('Todas as instâncias cobalt falharam. ' + errors.slice(0,3).join(' | '));
}

// ─── /api/info ────────────────────────────────────────────────────────────────
app.get('/api/info', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL obrigatória' });
  const videoId = extractVideoId(url);
  if (!videoId) return res.status(400).json({ error: 'Link inválido' });
  try {
    const r = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`);
    if (!r.ok) throw new Error();
    const d = await r.json();
    res.json({ videoId, title: d.title || '', channel: d.author_name || '' });
  } catch { res.json({ videoId, title: '', channel: '' }); }
});

// ─── /api/transcript ──────────────────────────────────────────────────────────
app.get('/api/transcript', async (req, res) => {
  const { url } = req.query;
  const videoId = extractVideoId(url);
  if (!videoId) return res.status(400).json({ error: 'Link inválido' });
  try {
    const r = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
      body: JSON.stringify({ videoId, context: { client: { clientName: 'WEB', clientVersion: '2.20240101.01.00', hl: 'en', gl: 'US' } } }),
    });
    const data = await r.json();
    const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!tracks?.length) throw new Error('sem legenda');
    const track = tracks.find(c => c.languageCode === 'en') || tracks[0];
    let captionUrl = track.baseUrl;
    if (!/[?&]fmt=/.test(captionUrl)) captionUrl += '&fmt=srv3';
    const xml = await (await fetch(captionUrl)).text();
    const texts = [];
    let m;
    const pR = /<p\b[^>]*>([\s\S]*?)<\/p>/g;
    while ((m = pR.exec(xml)) !== null) {
      const t = m[1].replace(/<[^>]+>/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#39;/g,"'").replace(/\s+/g,' ').trim();
      if (t) texts.push(t);
    }
    if (!texts.length) throw new Error('sem texto');
    res.json({ transcript: texts.join(' '), language: track.languageCode });
  } catch(e) { res.status(404).json({ error: 'Sem legendas. ' + e.message }); }
});

// ─── /api/audio (Whisper) ─────────────────────────────────────────────────────
app.get('/api/audio', async (req, res) => {
  if (!ytdl) return res.status(503).json({ error: 'ytdl indisponível' });
  const { url } = req.query;
  const videoId = extractVideoId(url);
  if (!videoId) return res.status(400).json({ error: 'Link inválido' });
  try {
    const info = await ytdl.getInfo(`https://www.youtube.com/watch?v=${videoId}`);
    const fmts = ytdl.filterFormats(info.formats, 'audioonly').sort((a, b) => (a.audioBitrate||999)-(b.audioBitrate||999));
    if (!fmts.length) throw new Error('sem áudio');
    res.setHeader('Content-Type', (fmts[0].mimeType || 'audio/mp4').split(';')[0]);
    const stream = ytdl.downloadFromInfo(info, { format: fmts[0] });
    stream.on('error', () => { if (!res.headersSent) res.status(500).end(); });
    req.on('close', () => stream.destroy());
    stream.pipe(res);
  } catch(e) { if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════
// /api/download-info — retorna opções de qualidade (presets cobalt)
// ═══════════════════════════════════════════════════════════════════════
app.get('/api/download-info', (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL obrigatória' });

  // Presets estáticos — cobalt aceita qualquer URL e filtra pela qualidade solicitada
  res.json({
    source: 'cobalt',
    combined: [
      { k: 'max',  mode: 'auto', label: 'Máxima qualidade', type: 'combined' },
      { k: '1080', mode: 'auto', label: '1080p Full HD',    type: 'combined' },
      { k: '720',  mode: 'auto', label: '720p HD',          type: 'combined' },
      { k: '480',  mode: 'auto', label: '480p',             type: 'combined' },
      { k: '360',  mode: 'auto', label: '360p',             type: 'combined' },
    ],
    audioOnly: [
      { k: 'mp3', mode: 'audio', audioFormat: 'mp3', label: 'MP3 (melhor)', type: 'audio' },
      { k: 'ogg', mode: 'audio', audioFormat: 'ogg', label: 'OGG',         type: 'audio' },
    ],
    videoOnly: [
      { k: '1080-mute', mode: 'mute', label: '1080p (sem áudio)', type: 'video' },
      { k: '720-mute',  mode: 'mute', label: '720p (sem áudio)',  type: 'video' },
    ],
  });
});

// ═══════════════════════════════════════════════════════════════════════
// /api/video-link — obtém URL de download via cobalt (ou fallbacks)
// ═══════════════════════════════════════════════════════════════════════
app.get('/api/video-link', async (req, res) => {
  const { url, k, mode, audioFormat } = req.query;
  if (!url || !k) return res.status(400).json({ error: 'Parâmetros inválidos' });

  const quality = k.replace('-mute', '');

  // 1. Cobalt (primário)
  try {
    const data = await cobaltRequest(url, quality, mode || 'auto', audioFormat || 'mp3');
    return res.json({ url: data.url, filename: data.filename || 'video.mp4' });
  } catch(e) { console.error('[video-link cobalt]', e.message); }

  // 2. yt-dlp (fallback)
  if (ytdlpBin) {
    try {
      const fmtArg = mode === 'audio' ? 'bestaudio'
        : mode === 'mute' ? `bestvideo[height<=${quality}]`
        : `bestvideo[height<=${quality}][ext=mp4]+bestaudio[ext=m4a]/best[height<=${quality}][ext=mp4]/best`;
      const dlUrl = await new Promise((resolve, reject) => {
        const p = spawn(ytdlpBin, ['--get-url', '-f', fmtArg, '--no-playlist', url]);
        let out='', err='';
        p.stdout.on('data', d=>out+=d); p.stderr.on('data', d=>err+=d);
        p.on('close', c => { if(c!==0)reject(new Error(err.trim().slice(0,150))); else resolve(out.trim().split('\n')[0]); });
        setTimeout(()=>{p.kill();reject(new Error('timeout'));},30000);
      });
      if (dlUrl) return res.json({ url: dlUrl, filename: 'video.mp4' });
    } catch(e) { console.error('[video-link ytdlp]', e.message); }
  }

  // 3. ytdl-core (YouTube only)
  const videoId = extractVideoId(url);
  if (videoId && ytdl) {
    try {
      const info = await ytdl.getInfo(`https://www.youtube.com/watch?v=${videoId}`);
      let format;
      if (mode === 'audio') format = ytdl.chooseFormat(info.formats, { quality: 'highestaudio', filter: 'audioonly' });
      else if (mode === 'mute') format = ytdl.chooseFormat(info.formats, { quality: 'highestvideo', filter: 'videoonly' });
      else format = ytdl.chooseFormat(info.formats, { quality: 'highest', filter: f => f.hasVideo && f.hasAudio });
      if (format?.url) return res.json({ url: format.url, filename: 'video.mp4' });
    } catch(e) { console.error('[video-link ytdl]', e.message); }
  }

  res.status(503).json({ error: 'Não foi possível gerar o link de download. Tente mais tarde.' });
});

// ─── /api/frame (Google Lens) ─────────────────────────────────────────────────
app.post('/api/frame', express.raw({ type: '*/*', limit: '10mb' }), (req, res) => {
  cleanFrames();
  while (frameCache.size >= 300) {
    const oldest = [...frameCache.entries()].sort((a,b)=>a[1].exp-b[1].exp)[0];
    if (oldest) frameCache.delete(oldest[0]);
  }
  const id = Date.now().toString(36) + Math.random().toString(36).substr(2, 8);
  frameCache.set(id, { data: req.body, exp: Date.now() + FRAME_TTL });
  res.json({ id, url: `/api/frame/${id}` });
});
app.get('/api/frame/:id', (req, res) => {
  cleanFrames();
  const frame = frameCache.get(req.params.id);
  if (!frame) return res.status(404).send('Frame expirado');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'public, max-age=900');
  res.send(frame.data);
});

app.listen(PORT, () => console.log(`Servidor na porta ${PORT}`));
