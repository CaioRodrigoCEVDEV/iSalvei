FROM node:22-bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive

# Versão do yt-dlp fixada no build. Se vazio, instala a última disponível.
# O script scripts/deploy.sh sempre passa uma versão exata para builds de produção.
ARG YTDLP_VERSION=2026.10.26

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-venv python3-pip ffmpeg curl ca-certificates \
      build-essential \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/yt-dlp \
    && /opt/yt-dlp/bin/pip install --no-cache-dir --upgrade pip \
    && if [ -n "$YTDLP_VERSION" ]; then \
         /opt/yt-dlp/bin/pip install --no-cache-dir "yt-dlp[default,curl-cffi]==${YTDLP_VERSION}"; \
       else \
         /opt/yt-dlp/bin/pip install --no-cache-dir --upgrade "yt-dlp[default,curl-cffi]"; \
       fi \
    && ln -sf /opt/yt-dlp/bin/yt-dlp /usr/local/bin/yt-dlp \
    && yt-dlp --version

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY . .

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=15s --start-period=30s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT:-3000}/health" || exit 1

CMD ["node", "server.js"]
