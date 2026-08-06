FROM node:20-slim

# yt-dlp[default] instala com o "grupo de dependências padrão", que inclui os
# scripts EJS (solucionador do desafio "n challenge" do YouTube) já embutidos —
# diferente de "pip install yt-dlp" puro ou do binário standalone via curl,
# que deixam esses scripts de fora.
#
# Deno é o runtime JS de maior prioridade que o yt-dlp detecta automaticamente
# pra rodar os scripts EJS — mais isolado que o Node (sandbox, sem acesso a
# filesystem/rede por padrão) e é o caminho mais testado em produção.
RUN apt-get update && apt-get install -y \
      python3 python3-pip ffmpeg curl ca-certificates unzip \
      --no-install-recommends \
  && rm -rf /var/lib/apt/lists/* \
  && pip3 install --break-system-packages --no-cache-dir -U "yt-dlp[default]" \
  && yt-dlp --version \
  && curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh \
  && deno --version

# evita o self-update check do yt-dlp contra a API do GitHub (rate-limit no IP
# compartilhado do Render, só gerava erro inofensivo no log)
ENV YTDL_NO_UPDATE=1

WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
