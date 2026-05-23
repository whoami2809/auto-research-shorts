const express = require('express');
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

let ytdl = null;
try { ytdl = require('@distube/ytdl-core'); console.log('[ytdl] ok'); }
catch(e) { console.warn('[ytdl] indisponível:', e.message); }

// Cache temporário de frames para o Google Lens (reset a cada deploy)
const frameCache = new Map();
const FRAME_TTL = 15 * 60 * 1000; // 15 minutos
function cleanFrameCache() {
  const now = Date.now();
  for (const [id, f] of frameCache) { if (now > f.exp) frameCache.delete(id); }
}

function extractVideoId(url) {
  const patterns = [
    /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})/,
    /[?&]v=([a-zA-Z0-9_-]{11})/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

// ─── /api/info ────────────────────────────────────────────────────────────────
app.get('/api/info', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL obrigatória' });
  const videoId = extractVideoId(url);
  if (!videoId) return res.status(400).json({ error: 'Link inválido' });
  try {
    const r = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`);
    if (!r.ok) throw new Error('falhou');
    const d = await r.json();
    res.json({ videoId, title: d.title || '', channel: d.author_name || '' });
  } catch(e) { res.json({ videoId, title: '', channel: '' }); }
});

// ─── /api/transcript ──────────────────────────────────────────────────────────
app.get('/api/transcript', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL obrigatória' });
  const videoId = extractVideoId(url);
  if (!videoId) return res.status(400).json({ error: 'Link inválido' });
  try {
    const body = { videoId, context: { client: { clientName: 'WEB', clientVersion: '2.20240101.01.00', hl: 'en', gl: 'US' } } };
    const r = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!tracks?.length) throw new Error('sem captionTracks');
    const track = tracks.find(c => c.languageCode === 'en') || tracks[0];
    let captionUrl = track.baseUrl;
    if (!/[?&]fmt=/.test(captionUrl)) captionUrl += '&fmt=srv3';
    const xmlRes = await fetch(captionUrl);
    if (!xmlRes.ok) throw new Error(`caption HTTP ${xmlRes.status}`);
    const xml = await xmlRes.text();
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

// ─── /api/audio ───────────────────────────────────────────────────────────────
app.get('/api/audio', async (req, res) => {
  if (!ytdl) return res.status(503).json({ error: 'ytdl indisponível' });
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL obrigatória' });
  const videoId = extractVideoId(url);
  if (!videoId) return res.status(400).json({ error: 'Link inválido' });
  try {
    const info = await ytdl.getInfo(`https://www.youtube.com/watch?v=${videoId}`);
    const formats = ytdl.filterFormats(info.formats, 'audioonly');
    if (!formats.length) throw new Error('sem áudio');
    formats.sort((a, b) => (a.audioBitrate || 999) - (b.audioBitrate || 999));
    const format = formats[0];
    res.setHeader('Content-Type', (format.mimeType || 'audio/mp4').split(';')[0]);
    res.setHeader('Cache-Control', 'no-store');
    const stream = ytdl.downloadFromInfo(info, { format });
    stream.on('error', e => { if (!res.headersSent) res.status(500).end(); });
    req.on('close', () => stream.destroy());
    stream.pipe(res);
  } catch(e) { console.error('[audio]', e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

// ─── /api/video (download completo) ──────────────────────────────────────────
app.get('/api/video', async (req, res) => {
  if (!ytdl) return res.status(503).json({ error: 'ytdl indisponível' });
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL obrigatória' });
  const videoId = extractVideoId(url);
  if (!videoId) return res.status(400).json({ error: 'Link inválido' });
  try {
    const info = await ytdl.getInfo(`https://www.youtube.com/watch?v=${videoId}`);
    const title = (info.videoDetails?.title || videoId).replace(/[^\w\s\-]/g, '').trim().substring(0, 60);
    // Prefere MP4 com vídeo+áudio combinados
    let format = ytdl.chooseFormat(info.formats, {
      quality: 'highest', filter: f => f.hasVideo && f.hasAudio && f.container === 'mp4'
    });
    if (!format) format = ytdl.chooseFormat(info.formats, {
      quality: 'highest', filter: f => f.hasVideo && f.hasAudio
    });
    if (!format) throw new Error('Nenhum formato disponível');
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(title)}.mp4"`);
    const stream = ytdl.downloadFromInfo(info, { format });
    stream.on('error', e => { if (!res.headersSent) res.status(500).end(); });
    req.on('close', () => stream.destroy());
    stream.pipe(res);
  } catch(e) { console.error('[video]', e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

// ─── /api/frame (hospedagem temporária para Google Lens) ─────────────────────
app.post('/api/frame', express.raw({ type: '*/*', limit: '10mb' }), (req, res) => {
  cleanFrameCache();
  if (frameCache.size >= 200) {
    // Remove o mais antigo
    const oldest = [...frameCache.entries()].sort((a, b) => a[1].exp - b[1].exp)[0];
    if (oldest) frameCache.delete(oldest[0]);
  }
  const id = Date.now().toString(36) + Math.random().toString(36).substr(2, 8);
  frameCache.set(id, { data: req.body, exp: Date.now() + FRAME_TTL, type: 'image/png' });
  res.json({ id, url: `/api/frame/${id}` });
});

app.get('/api/frame/:id', (req, res) => {
  cleanFrameCache();
  const frame = frameCache.get(req.params.id);
  if (!frame) return res.status(404).send('Frame não encontrado ou expirado');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'public, max-age=900');
  res.send(frame.data);
});

app.listen(PORT, () => console.log(`Servidor na porta ${PORT}`));
