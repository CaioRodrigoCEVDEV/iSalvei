FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y python3 python3-pip ffmpeg curl ca-certificates build-essential             && pip3 install yt-dlp             && apt-get clean && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json* ./
RUN apt-get update && apt-get install -y nodejs npm && npm ci --only=production || npm install --production
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
