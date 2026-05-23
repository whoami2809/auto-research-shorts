const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Carrega youtubei.js (é ESM, precisa de import dinâmico)
let ytClient = null;
async function getYtClient() {
  if (!ytClient) {
    const { Innertube } = await import('youtubei.js');
    ytClient = await Innertube.create({
      lang: 'en',
      location: 'US',
      retrieve_player: false,
    });
  }
  return ytClient;
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

// Info do vídeo via oEmbed (já funciona, mantém)
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

// Transcrição via youtubei.js
app.get('/api/transcript', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL obrigatória' });
  const videoId = extractVideoId(url);
  if (!videoId) return res.status(400).json({ error: 'Link inválido' });

  try {
    const yt = await getYtClient();

    let info;
    try {
      info = await yt.getInfo(videoId);
    } catch (e) {
      console.log('[yt] getInfo erro:', e.message);
      return res.status(500).json({ error: 'Falha ao obter info do vídeo: ' + e.message });
    }

    let transcriptData;
    try {
      transcriptData = await info.getTranscript();
    } catch (e) {
      console.log('[yt] getTranscript erro:', e.message);
      return res.status(404).json({ error: 'Sem transcrição disponível: ' + e.message });
    }

    // Tenta vários caminhos pra encontrar os segmentos (a estrutura pode variar entre versões da lib)
    const segments =
      transcriptData?.transcript?.content?.body?.initial_segments ||
      transcriptData?.content?.body?.initial_segments ||
      transcriptData?.initial_segments ||
      [];

    if (!segments.length) {
      return res.status(404).json({
        error: 'Transcrição retornou vazia.',
        debug: 'keys=' + Object.keys(transcriptData || {}).join(','),
      });
    }

    const texts = [];
    for (const seg of segments) {
      let t = '';
      if (seg?.snippet?.text) t = seg.snippet.text;
      else if (seg?.snippet?.runs) t = seg.snippet.runs.map((r) => r.text || '').join('');
      else if (typeof seg?.text === 'string') t = seg.text;
      t = t.trim();
      if (t) texts.push(t);
    }

    if (!texts.length) {
      return res.status(404).json({ error: 'Segmentos sem texto extraível.' });
    }

    const transcript = texts.join(' ').replace(/\s+/g, ' ').trim();
    res.json({
      transcript,
      language: transcriptData?.selectedLanguage || 'auto',
      method: 'youtubei.js',
    });
  } catch (e) {
    console.error('[transcript] erro:', e);
    res.status(500).json({ error: 'Erro: ' + (e.message || 'desconhecido') });
  }
});

app.listen(PORT, () => console.log(`Servidor na porta ${PORT}`));
