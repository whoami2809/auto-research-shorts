const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ─── ytdl-core (fallback YouTube) ────────────────────────────────────────────
let ytdl = null;
try { ytdl = require('@distube/ytdl-core'); } catch(e) {}

// ─── yt-dlp (fallback multi-plataforma) ──────────────────────────────────────
let ytdlpBin = null;
(async () => {
  for (const b of ['yt-dlp', '/usr/local/bin/yt-dlp', `${process.env.HOME}/.local/bin/yt-dlp`]) {
    const ok = await new Promise(r => {
      const p = spawn(b, ['--version']); p.on('close', c => r(c===0)); p.on('error', () => r(false));
    });
    if (ok) { ytdlpBin = b; break; }
  }
})();

// ─── Cache de frames para Google Lens ────────────────────────────────────────
const frameCache = new Map();
const FRAME_TTL = 15 * 60 * 1000;
function cleanFrames() {
  const now = Date.now();
  for (const [id, f] of frameCache) if (now > f.exp) frameCache.delete(id);
}

function extractVideoId(url) {
  for (const p of [
    /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})/,
    /[?&]v=([a-zA-Z0-9_-]{11})/,
  ]) { const m = url.match(p); if (m) return m[1]; }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════
// yt5s.biz API — extração e download via serviço externo
// ═══════════════════════════════════════════════════════════════════════
const YT5S = 'https://yt5s.biz';
const YT5S_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/javascript, */*; q=0.01',
  'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
  'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
  'Referer': 'https://yt5s.biz/ptwr200/',
  'Origin': 'https://yt5s.biz',
  'X-Requested-With': 'XMLHttpRequest',
};

async function yt5sAnalyze(url) {
  const body = new URLSearchParams({ q: url, vt: 'home' }).toString();
  const r = await fetch(`${YT5S}/api/ajaxSearch`, {
    method: 'POST', headers: YT5S_HEADERS, body,
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`yt5s analyze HTTP ${r.status}`);
  const data = await r.json();
  if (data.status !== 'ok') throw new Error(data.mess || 'yt5s analyze falhou');
  return data;
}

async function yt5sConvert(vid, k) {
  const body = new URLSearchParams({ vid, k }).toString();
  const r = await fetch(`${YT5S}/api/ajaxConvert`, {
    method: 'POST', headers: YT5S_HEADERS, body,
    signal: AbortSignal.timeout(25000),
  });
  if (!r.ok) throw new Error(`yt5s convert HTTP ${r.status}`);
  return await r.json();
}

async function yt5sPollConvert(vid, k, maxAttempts = 25) {
  let data = await yt5sConvert(vid, k);
  let i = 0;
  while ((data.c_status === 'CONVERTING' || !data.c_status) && i < maxAttempts) {
    await new Promise(r => setTimeout(r, 2000));
    data = await yt5sConvert(vid, k);
    i++;
  }
  if (data.c_status === 'CONVERTED' && data.d_url) return data.d_url;
  throw new Error(data.mess || `Conversão falhou (status: ${data.c_status})`);
}

// Monta lista de formatos a partir da resposta do yt5s
function buildFormats(links = {}) {
  const combined = [];
  const audioOnly = [];
  const videoOnly = [];

  // MP4 com áudio
  for (const [q, f] of Object.entries(links.mp4 || {})) {
    if (f && f.k) combined.push({
      k: f.k, label: f.q || `${q}p`,
      size: f.size || '~', ext: 'mp4', type: 'combined'
    });
  }

  // MP3 / áudio
  for (const [q, f] of Object.entries(links.mp3 || {})) {
    if (f && f.k) audioOnly.push({
      k: f.k, label: f.q || `${q}kbps`,
      size: f.size || '~', ext: 'mp3', type: 'audio'
    });
  }

  // MP4 somente vídeo
  for (const [q, f] of Object.entries(links.mp4only || links['videoonly'] || {})) {
    if (f && f.k) videoOnly.push({
      k: f.k, label: (f.q || `${q}p`) + ' (sem áudio)',
      size: f.size || '~', ext: 'mp4', type: 'video'
    });
  }

  // Ordena por qualidade (maior primeiro)
  const sortQ = arr => arr.sort((a, b) => {
    const qa = parseInt(a.label) || 0;
    const qb = parseInt(b.label) || 0;
    return qb - qa;
  });

  return {
    combined: sortQ(combined),
    audioOnly: sortQ(audioOnly),
    videoOnly: sortQ(videoOnly),
  };
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
// /api/download-info — busca formatos disponíveis para download
// ═══════════════════════════════════════════════════════════════════════
app.get('/api/download-info', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL obrigatória' });

  // 1. Tenta yt5s (multi-plataforma, suporta YouTube/TikTok/Instagram/etc.)
  try {
    const info = await yt5sAnalyze(url);
    const { combined, audioOnly, videoOnly } = buildFormats(info.links || {});
    return res.json({
      title: info.title || '',
      vid: info.vid || '',
      combined, audioOnly, videoOnly,
      source: 'yt5s',
    });
  } catch(e) { console.error('[download-info yt5s]', e.message); }

  // 2. Fallback: yt-dlp
  if (ytdlpBin) {
    try {
      const info = await new Promise((resolve, reject) => {
        const p = spawn(ytdlpBin, ['--dump-json', '--no-playlist', url]);
        let out = '', err = '';
        p.stdout.on('data', d => out += d);
        p.stderr.on('data', d => err += d);
        p.on('close', c => { if (c !== 0) reject(new Error(err.slice(0,200))); else try { resolve(JSON.parse(out)); } catch(e) { reject(e); } });
        setTimeout(() => { p.kill(); reject(new Error('timeout')); }, 30000);
      });
      const fmts = info.formats || [];
      const combined = fmts.filter(f => f.vcodec!=='none'&&f.acodec!=='none'&&f.height)
        .map(f => ({ k: f.format_id, label: `${f.height}p`, size: f.filesize?Math.round(f.filesize/1048576)+'MB':'~', type:'combined', source:'ytdlp' }))
        .sort((a,b)=>parseInt(b.label)-parseInt(a.label))
        .filter((f,i,a)=>a.findIndex(x=>x.label===f.label)===i).slice(0,5);
      const audioOnly = fmts.filter(f=>f.vcodec==='none'&&f.acodec!=='none')
        .map(f=>({ k:f.format_id, label:f.abr?Math.round(f.abr)+'kbps':f.ext, size:f.filesize?Math.round(f.filesize/1048576)+'MB':'~', type:'audio', source:'ytdlp' })).slice(0,3);
      const videoOnly = fmts.filter(f=>f.vcodec!=='none'&&f.acodec==='none'&&f.height)
        .map(f=>({ k:f.format_id, label:`${f.height}p (sem áudio)`, size:f.filesize?Math.round(f.filesize/1048576)+'MB':'~', type:'video', source:'ytdlp' }))
        .sort((a,b)=>parseInt(b.label)-parseInt(a.label))
        .filter((f,i,a)=>a.findIndex(x=>x.label===f.label)===i).slice(0,3);
      return res.json({ title: info.title||'', vid:'', combined, audioOnly, videoOnly, source:'ytdlp' });
    } catch(e) { console.error('[download-info ytdlp]', e.message); }
  }

  // 3. Fallback: ytdl-core (YouTube)
  const videoId = extractVideoId(url);
  if (videoId && ytdl) {
    try {
      const info = await ytdl.getBasicInfo(`https://www.youtube.com/watch?v=${videoId}`);
      const combined = ytdl.filterFormats(info.formats, f=>f.hasVideo&&f.hasAudio)
        .map(f=>({ k:String(f.itag), label:f.qualityLabel, size:f.contentLength?Math.round(Number(f.contentLength)/1048576)+'MB':'~', type:'combined', source:'ytdl' }))
        .filter(f=>f.label).sort((a,b)=>parseInt(b.label)-parseInt(a.label))
        .filter((f,i,a)=>a.findIndex(x=>x.label===f.label)===i).slice(0,5);
      const audioOnly = ytdl.filterFormats(info.formats, f=>!f.hasVideo&&f.hasAudio)
        .map(f=>({ k:String(f.itag), label:(f.audioBitrate||'?')+'kbps', size:'~', type:'audio', source:'ytdl' })).slice(0,3);
      const videoOnly = ytdl.filterFormats(info.formats, f=>f.hasVideo&&!f.hasAudio)
        .map(f=>({ k:String(f.itag), label:(f.qualityLabel||'?')+' (sem áudio)', size:'~', type:'video', source:'ytdl' }))
        .filter(f=>f.label).slice(0,3);
      return res.json({ title:info.videoDetails?.title||'', vid:videoId, combined, audioOnly, videoOnly, source:'ytdl' });
    } catch(e) { console.error('[download-info ytdl]', e.message); }
  }

  res.status(503).json({ blocked: true, error: 'Não foi possível obter os formatos do vídeo.' });
});

// ═══════════════════════════════════════════════════════════════════════
// /api/video-link — converte e retorna URL de download
// ═══════════════════════════════════════════════════════════════════════
app.get('/api/video-link', async (req, res) => {
  const { vid, k, source, url } = req.query;
  if (!k) return res.status(400).json({ error: 'Parâmetros inválidos' });

  // yt5s
  if (source === 'yt5s' && vid) {
    try {
      const dlUrl = await yt5sPollConvert(vid, k);
      return res.json({ url: dlUrl });
    } catch(e) { console.error('[video-link yt5s]', e.message); }
  }

  // yt-dlp
  if ((source === 'ytdlp' || !source) && ytdlpBin && url) {
    try {
      const dlUrl = await new Promise((resolve, reject) => {
        const p = spawn(ytdlpBin, ['--get-url', '-f', k, '--no-playlist', url]);
        let out = '', err = '';
        p.stdout.on('data', d => out += d);
        p.stderr.on('data', d => err += d);
        p.on('close', c => { if (c !== 0) reject(new Error(err.trim().slice(0,200))); else resolve(out.trim().split('\n')[0]); });
        setTimeout(() => { p.kill(); reject(new Error('timeout')); }, 30000);
      });
      if (dlUrl) return res.json({ url: dlUrl });
    } catch(e) { console.error('[video-link ytdlp]', e.message); }
  }

  // ytdl-core
  if (url) {
    const videoId = extractVideoId(url);
    if (videoId && ytdl) {
      try {
        const info = await ytdl.getInfo(`https://www.youtube.com/watch?v=${videoId}`);
        const format = info.formats.find(f => String(f.itag) === k) ||
          ytdl.chooseFormat(info.formats, { quality: 'highest', filter: f => f.hasVideo && f.hasAudio });
        if (format?.url) return res.json({ url: format.url });
      } catch(e) { console.error('[video-link ytdl]', e.message); }
    }
  }

  res.status(500).json({ error: 'Não foi possível obter o link de download.' });
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
