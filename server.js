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
  } catch(e) {
    res.json({ videoId, title: '', channel: '' });
  }
});

// Transcrição via página do YouTube (scraping das legendas automáticas)
app.get('/api/transcript', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL obrigatória' });
  const videoId = extractVideoId(url);
  if (!videoId) return res.status(400).json({ error: 'Link inválido' });

  try {
    // Busca a página do vídeo
    const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      }
    });

    const html = await pageRes.text();

    // Extrai URL das legendas do JSON embutido na página
    const captionMatch = html.match(/"captionTracks":\s*(\[.*?\])/);
    if (!captionMatch) {
      return res.status(404).json({ error: 'Transcrição não disponível para este vídeo.' });
    }

    const captions = JSON.parse(captionMatch[1]);
    if (!captions.length) {
      return res.status(404).json({ error: 'Nenhuma legenda encontrada.' });
    }

    // Prefere inglês, senão pega a primeira disponível
    const track = captions.find(c => c.languageCode === 'en') || captions[0];
    const captionUrl = track.baseUrl;

    // Busca o XML das legendas
    const xmlRes = await fetch(captionUrl);
    const xml = await xmlRes.text();

    // Extrai o texto do XML
    const texts = [];
    const regex = /<text[^>]*>(.*?)<\/text>/g;
    let match;
    while ((match = regex.exec(xml)) !== null) {
      const text = match[1]
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/<[^>]+>/g, '')
        .trim();
      if (text) texts.push(text);
    }

    if (!texts.length) {
      return res.status(404).json({ error: 'Não foi possível extrair o texto das legendas.' });
    }

    const transcript = texts.join(' ').replace(/\s+/g, ' ').trim();
    res.json({ transcript, language: track.languageCode, languageName: track.name?.simpleText || '' });

  } catch(e) {
    console.error('Erro transcrição:', e.message);
    res.status(500).json({ error: 'Erro ao buscar transcrição: ' + e.message });
  }
});

app.listen(PORT, () => console.log(`Servidor na porta ${PORT}`));
