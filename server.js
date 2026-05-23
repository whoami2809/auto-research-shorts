const express = require('express');
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Carrega ytdl opcionalmente (caso instalação falhe, não quebra o servidor)
let ytdl = null;
try { ytdl = require('@distube/ytdl-core'); console.log('[ytdl] carregado'); }
catch(e) { console.warn('[ytdl] não disponível:', e.message); }

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
  } catch(e) {
    res.json({ videoId, title: '', channel: '' });
  }
});

// ─── /api/transcript ──────────────────────────────────────────────────────────
// Mantido como tentativa rápida; na prática o YouTube bloqueia de datacenters
app.get('/api/transcript', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL obrigatória' });
  const videoId = extractVideoId(url);
  if (!videoId) return res.status(400).json({ error: 'Link inválido' });

  const errors = [];

  // Tenta Innertube WEB
  try {
    const body = { videoId, context: { client: { clientName: 'WEB', clientVersion: '2.20240101.01.00', hl: 'en', gl: 'US' } } };
    const r = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
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
    if (!texts.length) throw new Error('XML sem texto');
    return res.json({ transcript: texts.join(' '), language: track.languageCode });
  } catch(e) { errors.push(e.message); }

  res.status(404).json({ error: 'Sem legendas disponíveis. ' + errors.join(' | ') });
});

// ─── /api/audio ───────────────────────────────────────────────────────────────
// Baixa o áudio do vídeo via ytdl-core e envia para o browser rodar o Whisper
app.get('/api/audio', async (req, res) => {
  if (!ytdl) return res.status(503).json({ error: 'ytdl não disponível no servidor' });

  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL obrigatória' });
  const videoId = extractVideoId(url);
  if (!videoId) return res.status(400).json({ error: 'Link inválido' });

  try {
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

    // Obtém info do vídeo
    const info = await ytdl.getInfo(videoUrl);

    // Escolhe o formato de áudio mais leve disponível
    const formats = ytdl.filterFormats(info.formats, 'audioonly');
    if (!formats.length) throw new Error('Nenhum formato de áudio disponível');

    // Ordena por bitrate (menor primeiro = menor arquivo = mais rápido)
    formats.sort((a, b) => (a.audioBitrate || 999) - (b.audioBitrate || 999));
    const format = formats[0];

    const mimeType = (format.mimeType || 'audio/mp4').split(';')[0];
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Cache-Control', 'no-store');

    const stream = ytdl.downloadFromInfo(info, { format });

    stream.on('error', (e) => {
      console.error('[audio stream error]', e.message);
      if (!res.headersSent) res.status(500).json({ error: e.message });
      else res.end();
    });

    req.on('close', () => stream.destroy());
    stream.pipe(res);

  } catch(e) {
    console.error('[audio]', e.message);
    if (!res.headersSent) res.status(500).json({ error: 'Falha ao obter áudio: ' + e.message });
  }
});

app.listen(PORT, () => console.log(`Servidor na porta ${PORT}`));
