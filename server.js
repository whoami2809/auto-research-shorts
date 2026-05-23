const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ─── ytdl-core (YouTube) ──────────────────────────────────────────────────────
let ytdl = null;
try { ytdl = require('@distube/ytdl-core'); console.log('[ytdl] ok'); }
catch(e) { console.warn('[ytdl] indisponível'); }

// ─── yt-dlp (multi-plataforma) ────────────────────────────────────────────────
let ytdlpBin = null;
async function findYtdlp() {
  const candidates = ['yt-dlp', '/usr/local/bin/yt-dlp', `${process.env.HOME}/.local/bin/yt-dlp`];
  for (const bin of candidates) {
    const ok = await new Promise(resolve => {
      const p = spawn(bin, ['--version']);
      p.on('close', code => resolve(code === 0));
      p.on('error', () => resolve(false));
    });
    if (ok) { ytdlpBin = bin; console.log('[yt-dlp] encontrado:', bin); return; }
  }
  console.warn('[yt-dlp] não encontrado — usando apenas ytdl-core');
}
findYtdlp();

function ytdlpJson(url) {
  return new Promise((resolve, reject) => {
    const p = spawn(ytdlpBin, ['--dump-json', '--no-playlist', url]);
    let out = '', err = '';
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => err += d);
    p.on('close', code => {
      if (code !== 0) reject(new Error(err.trim().slice(0, 200) || 'yt-dlp falhou'));
      else try { resolve(JSON.parse(out)); } catch(e) { reject(e); }
    });
    p.on('error', reject);
    setTimeout(() => { p.kill(); reject(new Error('timeout')); }, 35000);
  });
}

// ─── Cache temporário de frames para Google Lens ──────────────────────────────
const frameCache = new Map();
const FRAME_TTL = 15 * 60 * 1000;
function cleanFrames() {
  const now = Date.now();
  for (const [id, f] of frameCache) if (now > f.exp) frameCache.delete(id);
}

function extractVideoId(url) {
  const patterns = [
    /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})/,
    /[?&]v=([a-zA-Z0-9_-]{11})/,
  ];
  for (const p of patterns) { const m = url.match(p); if (m) return m[1]; }
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
    if (!xmlRes.ok) throw new Error(`XML HTTP ${xmlRes.status}`);
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

// ─── /api/audio (Whisper) ─────────────────────────────────────────────────────
app.get('/api/audio', async (req, res) => {
  if (!ytdl) return res.status(503).json({ error: 'ytdl indisponível' });
  const { url } = req.query;
  const videoId = extractVideoId(url);
  if (!videoId) return res.status(400).json({ error: 'Link inválido' });
  try {
    const info = await ytdl.getInfo(`https://www.youtube.com/watch?v=${videoId}`);
    const formats = ytdl.filterFormats(info.formats, 'audioonly');
    if (!formats.length) throw new Error('sem áudio');
    formats.sort((a, b) => (a.audioBitrate || 999) - (b.audioBitrate || 999));
    res.setHeader('Content-Type', (formats[0].mimeType || 'audio/mp4').split(';')[0]);
    const stream = ytdl.downloadFromInfo(info, { format: formats[0] });
    stream.on('error', e => { if (!res.headersSent) res.status(500).end(); });
    req.on('close', () => stream.destroy());
    stream.pipe(res);
  } catch(e) { if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

// ─── /api/download-info ───────────────────────────────────────────────────────
app.get('/api/download-info', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL obrigatória' });

  // Tenta yt-dlp primeiro (multi-plataforma)
  if (ytdlpBin) {
    try {
      const info = await ytdlpJson(url);
      const fmts = info.formats || [];

      const combined = fmts
        .filter(f => f.vcodec !== 'none' && f.acodec !== 'none' && f.height)
        .map(f => ({ id: f.format_id, label: `${f.height}p`, ext: f.ext, size: f.filesize ? Math.round(f.filesize/1024/1024)+'MB' : '~', type: 'combined' }))
        .sort((a, b) => parseInt(b.label) - parseInt(a.label))
        .filter((f, i, arr) => arr.findIndex(x => x.label === f.label) === i)
        .slice(0, 5);

      const audioOnly = fmts
        .filter(f => f.vcodec === 'none' && f.acodec !== 'none')
        .map(f => ({ id: f.format_id, label: f.abr ? Math.round(f.abr)+'kbps' : f.ext, ext: f.ext, size: f.filesize ? Math.round(f.filesize/1024/1024)+'MB' : '~', type: 'audio' }))
        .slice(0, 3);

      const videoOnly = fmts
        .filter(f => f.vcodec !== 'none' && f.acodec === 'none' && f.height)
        .map(f => ({ id: f.format_id, label: `${f.height}p`, ext: f.ext, size: f.filesize ? Math.round(f.filesize/1024/1024)+'MB' : '~', type: 'video' }))
        .sort((a, b) => parseInt(b.label) - parseInt(a.label))
        .filter((f, i, arr) => arr.findIndex(x => x.label === f.label) === i)
        .slice(0, 3);

      return res.json({ title: info.title || '', combined, audioOnly, videoOnly, source: 'ytdlp' });
    } catch(e) { console.error('[download-info ytdlp]', e.message); }
  }

  // Fallback: ytdl-core (apenas YouTube)
  const videoId = extractVideoId(url);
  if (videoId && ytdl) {
    try {
      const info = await ytdl.getBasicInfo(`https://www.youtube.com/watch?v=${videoId}`);

      const combined = ytdl.filterFormats(info.formats, f => f.hasVideo && f.hasAudio)
        .map(f => ({ id: String(f.itag), label: f.qualityLabel, ext: f.container || 'mp4', size: f.contentLength ? Math.round(Number(f.contentLength)/1024/1024)+'MB' : '~', type: 'combined' }))
        .filter(f => f.label)
        .sort((a, b) => parseInt(b.label) - parseInt(a.label))
        .filter((f, i, arr) => arr.findIndex(x => x.label === f.label) === i)
        .slice(0, 5);

      const audioOnly = ytdl.filterFormats(info.formats, f => !f.hasVideo && f.hasAudio)
        .map(f => ({ id: String(f.itag), label: (f.audioBitrate||'?')+'kbps', ext: f.container || 'mp4', size: f.contentLength ? Math.round(Number(f.contentLength)/1024/1024)+'MB' : '~', type: 'audio' }))
        .slice(0, 3);

      const videoOnly = ytdl.filterFormats(info.formats, f => f.hasVideo && !f.hasAudio)
        .map(f => ({ id: String(f.itag), label: f.qualityLabel, ext: f.container || 'mp4', size: f.contentLength ? Math.round(Number(f.contentLength)/1024/1024)+'MB' : '~', type: 'video' }))
        .filter(f => f.label)
        .sort((a, b) => parseInt(b.label) - parseInt(a.label))
        .filter((f, i, arr) => arr.findIndex(x => x.label === f.label) === i)
        .slice(0, 3);

      return res.json({ title: info.videoDetails?.title || '', combined, audioOnly, videoOnly, source: 'ytdl' });
    } catch(e) { console.error('[download-info ytdl]', e.message); }
  }

  res.status(503).json({ blocked: true, error: 'O servidor não conseguiu acessar os formatos. Tente via cobalt.tools.' });
});

// ─── /api/video (download) ────────────────────────────────────────────────────
app.get('/api/video', async (req, res) => {
  const { url, id: formatId } = req.query;
  if (!url) return res.status(400).json({ error: 'URL obrigatória' });

  // Tenta yt-dlp
  if (ytdlpBin) {
    const fmtArg = formatId || 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best';
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', 'attachment; filename="video.mp4"');
    const proc = spawn(ytdlpBin, ['-f', fmtArg, '--no-playlist', '--merge-output-format', 'mp4', '-o', '-', url]);
    proc.stdout.pipe(res);
    proc.stderr.on('data', d => console.error('[yt-dlp dl]', d.toString().trim().slice(0, 120)));
    proc.on('error', e => { console.error('[yt-dlp proc]', e); if (!res.headersSent) res.status(500).end(); else res.end(); });
    req.on('close', () => { try { proc.kill(); } catch(e) {} });
    return;
  }

  // Fallback ytdl-core
  const videoId = extractVideoId(url);
  if (!videoId || !ytdl) return res.status(503).json({ error: 'Download indisponível' });
  try {
    const info = await ytdl.getInfo(`https://www.youtube.com/watch?v=${videoId}`);
    const title = (info.videoDetails?.title || videoId).replace(/[^\w\s\-]/g,'').trim().substring(0,50);
    let format = formatId ? info.formats.find(f => String(f.itag) === formatId) : null;
    if (!format) format = ytdl.chooseFormat(info.formats, { quality: 'highest', filter: f => f.hasVideo && f.hasAudio && f.container === 'mp4' });
    if (!format) format = ytdl.chooseFormat(info.formats, { quality: 'highest', filter: f => f.hasVideo && f.hasAudio });
    if (!format) throw new Error('Nenhum formato disponível');
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(title)}.mp4"`);
    const stream = ytdl.downloadFromInfo(info, { format });
    stream.on('error', e => { if (!res.headersSent) res.status(500).end(); else res.end(); });
    req.on('close', () => stream.destroy());
    stream.pipe(res);
  } catch(e) { if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

// ─── /api/frame (Google Lens) ─────────────────────────────────────────────────
app.post('/api/frame', express.raw({ type: '*/*', limit: '10mb' }), (req, res) => {
  cleanFrames();
  if (frameCache.size >= 300) {
    const oldest = [...frameCache.entries()].sort((a,b) => a[1].exp - b[1].exp)[0];
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
