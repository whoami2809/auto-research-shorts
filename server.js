const express = require('express');
const cors = require('cors');
const { YoutubeTranscript } = require('youtube-transcript');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ── Extrair ID do YouTube ──────────────────────────────────
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

// ── Rota: buscar título e canal ───────────────────────────
app.get('/api/info', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL obrigatória' });

  const videoId = extractVideoId(url);
  if (!videoId) return res.status(400).json({ error: 'Link inválido' });

  try {
    const oembedRes = await fetch(
      `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`
    );
    if (!oembedRes.ok) throw new Error('oEmbed falhou');
    const data = await oembedRes.json();
    res.json({
      videoId,
      title: data.title || '',
      channel: data.author_name || '',
      thumbnail: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
    });
  } catch (e) {
    res.json({ videoId, title: '', channel: '', thumbnail: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg` });
  }
});

// ── Rota: buscar transcrição ──────────────────────────────
app.get('/api/transcript', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL obrigatória' });

  const videoId = extractVideoId(url);
  if (!videoId) return res.status(400).json({ error: 'Link inválido' });

  try {
    // Tenta buscar em inglês primeiro, depois qualquer idioma
    let transcript;
    try {
      transcript = await YoutubeTranscript.fetchTranscript(videoId, { lang: 'en' });
    } catch {
      transcript = await YoutubeTranscript.fetchTranscript(videoId);
    }

    const text = transcript.map(s => s.text).join(' ').replace(/\s+/g, ' ').trim();
    res.json({ transcript: text, segments: transcript });
  } catch (e) {
    res.status(404).json({
      error: 'Transcrição não encontrada. O vídeo pode não ter legendas automáticas ativadas.',
    });
  }
});

app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
