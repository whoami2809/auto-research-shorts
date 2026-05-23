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

// Método 1: Innertube API (API interna do YouTube, mais confiável)
async function getCaptionTracksViaInnertube(videoId) {
  const body = {
    videoId,
    context: {
      client: {
        clientName: 'WEB',
        clientVersion: '2.20240101.01.00',
        hl: 'en',
        gl: 'US',
      },
    },
  };
  const r = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Innertube HTTP ${r.status}`);
  const data = await r.json();
  const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!tracks || !tracks.length) throw new Error('Innertube sem captionTracks');
  return tracks;
}

// Método 2: scraping HTML (fallback)
async function getCaptionTracksViaHtml(videoId) {
  const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  const html = await pageRes.text();
  const m = html.match(/"captionTracks":\s*(\[[\s\S]*?\])/);
  if (!m) throw new Error('HTML sem captionTracks');
  return JSON.parse(m[1]);
}

// Info do vídeo via oEmbed
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

// Transcrição
app.get('/api/transcript', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL obrigatória' });
  const videoId = extractVideoId(url);
  if (!videoId) return res.status(400).json({ error: 'Link inválido' });

  let tracks = null;
  let methodUsed = '';
  const errors = [];

  try {
    tracks = await getCaptionTracksViaInnertube(videoId);
    methodUsed = 'innertube';
  } catch (e) {
    errors.push('Innertube: ' + e.message);
    console.log('[transcript]', e.message);
  }

  if (!tracks) {
    try {
      tracks = await getCaptionTracksViaHtml(videoId);
      methodUsed = 'html';
    } catch (e) {
      errors.push('HTML: ' + e.message);
      console.log('[transcript]', e.message);
    }
  }

  if (!tracks || !tracks.length) {
    return res.status(404).json({
      error: 'Não foi possível encontrar legendas. ' + errors.join(' | '),
    });
  }

  const track =
    tracks.find((c) => c.languageCode === 'en') ||
    tracks.find((c) => c.languageCode === 'pt' || c.languageCode === 'pt-BR') ||
    tracks[0];

  if (!track || !track.baseUrl) {
    return res.status(404).json({ error: 'Track de legenda sem URL.' });
  }

  let captionUrl = track.baseUrl;
  if (!/[?&]fmt=/.test(captionUrl)) captionUrl += '&fmt=srv3';

  try {
    const xmlRes = await fetch(captionUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    });
    if (!xmlRes.ok) {
      return res.status(500).json({ error: `Erro ao baixar legendas (HTTP ${xmlRes.status}).` });
    }
    const xml = await xmlRes.text();

    const texts = [];
    let m;

    const pRegex = /<p\b[^>]*>([\s\S]*?)<\/p>/g;
    while ((m = pRegex.exec(xml)) !== null) {
      const inner = m[1].replace(/<[^>]+>/g, ' ');
      const clean = decodeEntities(inner).replace(/\s+/g, ' ').trim();
      if (clean) texts.push(clean);
    }

    if (!texts.length) {
      const tRegex = /<text\b[^>]*>([\s\S]*?)<\/text>/g;
      while ((m = tRegex.exec(xml)) !== null) {
        const inner = m[1].replace(/<[^>]+>/g, '');
        const clean = decodeEntities(inner).replace(/\s+/g, ' ').trim();
        if (clean) texts.push(clean);
      }
    }

    if (!texts.length) {
      return res.status(500).json({ error: 'XML das legendas veio vazio ou em formato desconhecido.' });
    }

    const transcript = texts.join(' ').replace(/\s+/g, ' ').trim();
    res.json({
      transcript,
      language: track.languageCode,
      languageName: track.name?.simpleText || track.name?.runs?.[0]?.text || '',
      method: methodUsed,
    });
  } catch (e) {
    console.error('[transcript] erro final:', e);
    res.status(500).json({ error: 'Erro ao buscar transcrição: ' + e.message });
  }
});

app.listen(PORT, () => console.log(`Servidor na porta ${PORT}`));
