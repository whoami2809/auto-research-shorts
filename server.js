const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

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

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, c) => String.fromCharCode(parseInt(c, 10)));
}

const CLIENTS = {
  WEB: {
    clientName: 'WEB',
    clientVersion: '2.20240101.01.00',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  },
  ANDROID: {
    clientName: 'ANDROID',
    clientVersion: '19.09.37',
    androidSdkVersion: 30,
    ua: 'com.google.android.youtube/19.09.37 (Linux; U; Android 11) gzip',
  },
  IOS: {
    clientName: 'IOS',
    clientVersion: '19.09.3',
    deviceModel: 'iPhone14,3',
    ua: 'com.google.ios.youtube/19.09.3 (iPhone14,3; U; CPU iOS 15_6 like Mac OS X)',
  },
};

async function innertubePlayer(videoId, clientKey) {
  const c = CLIENTS[clientKey];
  const client = { clientName: c.clientName, clientVersion: c.clientVersion, hl: 'en', gl: 'US' };
  if (c.androidSdkVersion) client.androidSdkVersion = c.androidSdkVersion;
  if (c.deviceModel) client.deviceModel = c.deviceModel;

  const r = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': c.ua },
    body: JSON.stringify({ videoId, context: { client } }),
  });
  if (!r.ok) throw new Error(`Innertube ${clientKey} HTTP ${r.status}`);
  const data = await r.json();
  const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!tracks || !tracks.length) throw new Error(`Innertube ${clientKey} sem captionTracks`);
  return tracks;
}

function makeTranscriptParams(videoId) {
  const idBytes = Buffer.from(videoId, 'utf8');
  return Buffer.concat([Buffer.from([0x0a, idBytes.length]), idBytes]).toString('base64');
}

async function getTranscriptDirect(videoId) {
  const body = {
    context: { client: { clientName: 'WEB', clientVersion: '2.20240101.01.00', hl: 'en', gl: 'US' } },
    params: makeTranscriptParams(videoId),
  };
  const r = await fetch('https://www.youtube.com/youtubei/v1/get_transcript?prettyPrint=false', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': CLIENTS.WEB.ua },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`get_transcript HTTP ${r.status}`);
  const data = await r.json();

  const segments = data?.actions?.[0]?.updateEngagementPanelAction?.content
    ?.transcriptRenderer?.content?.transcriptSearchPanelRenderer?.body
    ?.transcriptSegmentListRenderer?.initialSegments;

  if (!segments || !segments.length) throw new Error('get_transcript sem segments');

  const texts = [];
  for (const seg of segments) {
    const snippet = seg?.transcriptSegmentRenderer?.snippet;
    if (!snippet) continue;
    let t = '';
    if (Array.isArray(snippet.runs)) t = snippet.runs.map(x => x.text || '').join('');
    else if (snippet.simpleText) t = snippet.simpleText;
    t = t.trim();
    if (t) texts.push(t);
  }
  if (!texts.length) throw new Error('get_transcript sem texto extraído');
  return texts.join(' ').replace(/\s+/g, ' ').trim();
}

async function htmlScrape(videoId) {
  const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
    headers: { 'User-Agent': CLIENTS.WEB.ua, 'Accept-Language': 'en-US,en;q=0.9' },
  });
  const html = await pageRes.text();
  const m = html.match(/"captionTracks":\s*(\[[\s\S]*?\])/);
  if (!m) throw new Error('HTML sem captionTracks');
  return JSON.parse(m[1]);
}

async function captionsToText(tracks) {
  const track =
    tracks.find(c => c.languageCode === 'en') ||
    tracks.find(c => c.languageCode === 'pt' || c.languageCode === 'pt-BR') ||
    tracks[0];
  if (!track || !track.baseUrl) throw new Error('Track sem URL');

  let url = track.baseUrl;
  if (!/[?&]fmt=/.test(url)) url += '&fmt=srv3';

  const xmlRes = await fetch(url, { headers: { 'User-Agent': CLIENTS.WEB.ua } });
  if (!xmlRes.ok) throw new Error(`baseUrl HTTP ${xmlRes.status}`);
  const xml = await xmlRes.text();

  const texts = [];
  let m;
  const pR = /<p\b[^>]*>([\s\S]*?)<\/p>/g;
  while ((m = pR.exec(xml)) !== null) {
    const inner = m[1].replace(/<[^>]+>/g, ' ');
    const clean = decodeEntities(inner).replace(/\s+/g, ' ').trim();
    if (clean) texts.push(clean);
  }
  if (!texts.length) {
    const tR = /<text\b[^>]*>([\s\S]*?)<\/text>/g;
    while ((m = tR.exec(xml)) !== null) {
      const inner = m[1].replace(/<[^>]+>/g, '');
      const clean = decodeEntities(inner).replace(/\s+/g, ' ').trim();
      if (clean) texts.push(clean);
    }
  }
  if (!texts.length) throw new Error('XML sem texto');

  return {
    transcript: texts.join(' ').replace(/\s+/g, ' ').trim(),
    language: track.languageCode,
    languageName: track.name?.simpleText || track.name?.runs?.[0]?.text || '',
  };
}

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
  } catch (e) {
    res.json({ videoId, title: '', channel: '' });
  }
});

app.get('/api/transcript', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL obrigatória' });
  const videoId = extractVideoId(url);
  if (!videoId) return res.status(400).json({ error: 'Link inválido' });

  const errors = [];

  // 1. get_transcript direto (funciona para a maioria dos Shorts)
  try {
    const transcript = await getTranscriptDirect(videoId);
    return res.json({ transcript, language: 'auto', languageName: 'auto', method: 'get_transcript' });
  } catch (e) { errors.push('[1] ' + e.message); console.log('[1]', e.message); }

  // 2. Innertube /player WEB
  try {
    const tracks = await innertubePlayer(videoId, 'WEB');
    const result = await captionsToText(tracks);
    return res.json({ ...result, method: 'innertube-web' });
  } catch (e) { errors.push('[2] ' + e.message); console.log('[2]', e.message); }

  // 3. Innertube /player ANDROID
  try {
    const tracks = await innertubePlayer(videoId, 'ANDROID');
    const result = await captionsToText(tracks);
    return res.json({ ...result, method: 'innertube-android' });
  } catch (e) { errors.push('[3] ' + e.message); console.log('[3]', e.message); }

  // 4. Innertube /player IOS
  try {
    const tracks = await innertubePlayer(videoId, 'IOS');
    const result = await captionsToText(tracks);
    return res.json({ ...result, method: 'innertube-ios' });
  } catch (e) { errors.push('[4] ' + e.message); console.log('[4]', e.message); }

  // 5. HTML scrape (último recurso)
  try {
    const tracks = await htmlScrape(videoId);
    const result = await captionsToText(tracks);
    return res.json({ ...result, method: 'html' });
  } catch (e) { errors.push('[5] ' + e.message); console.log('[5]', e.message); }

  return res.status(404).json({
    error: 'Nenhum método conseguiu legendas. ' + errors.join(' | '),
  });
});

app.listen(PORT, () => console.log(`Servidor na porta ${PORT}`));
