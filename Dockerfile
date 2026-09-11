FROM brainicism/bgutil-ytdlp-pot-provider:2.0.0

USER root

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
  && pip3 install --break-system-packages --no-cache-dir -U --pre "yt-dlp[default]" \
  && pip3 install --break-system-packages --no-cache-dir -U "bgutil-ytdlp-pot-provider==2.0.0" "curl_cffi==0.15.0" \
  && yt-dlp --version \
  && curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh \
  && deno --version

# evita o self-update check do yt-dlp contra a API do GitHub (rate-limit no IP
# compartilhado do Render, só gerava erro inofensivo no log)
ENV YTDL_NO_UPDATE=1

WORKDIR /ars
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN node -e "if(Number(process.versions.node.split('.')[0])<22)process.exit(1)" \
  && npm install --global pnpm@11.19.0 --ignore-scripts \
  && pnpm install --prod --frozen-lockfile --ignore-scripts
COPY workflow/requirements.txt ./workflow/requirements.txt
RUN pip3 install --break-system-packages --no-cache-dir -r workflow/requirements.txt
ENV WF_PYTHON=/usr/bin/python3 WF_FFMPEG_PATH=/usr/bin/ffmpeg WF_FFPROBE_PATH=/usr/bin/ffprobe
COPY . .
EXPOSE 3000
EXPOSE 4416

# O provedor local 2.x gera automaticamente os PO Tokens exigidos pelo YouTube;
# o servidor Express continua sendo o processo principal do container.
ENTRYPOINT []
CMD ["sh", "-c", "node /app/build/main.js --port 4416 & exec node server.js"]
