FROM node:20-slim
RUN apt-get update && apt-get install -y python3 python3-pip ffmpeg curl \
  # instala o yt-dlp via pip (não o binário standalone) + o pacote yt-dlp-ejs,
  # que embute os scripts solucionadores do desafio "n challenge" na imagem —
  # assim não precisamos buscar nada do GitHub em tempo de execução (o que
  # estava falhando por rate-limit de IP compartilhado do Render)
  && pip3 install --break-system-packages --no-cache-dir -U yt-dlp yt-dlp-ejs \
  && rm -rf /var/lib/apt/lists/*
# evita o self-update check do yt-dlp contra a API do GitHub (que também sofre
# rate-limit no IP compartilhado do Render e só gera erro inofensivo no log)
ENV YTDL_NO_UPDATE=1
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
