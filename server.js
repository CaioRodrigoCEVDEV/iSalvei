require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const tmp = require('tmp-promise');
const rateLimit = require('express-rate-limit');

const app = express();

// ==============================
// Config
// ==============================
const PORT = process.env.PORT || 3000;
const API_PORT = process.env.API_PORT || process.env.PORT || 3000;
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 10);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60 * 1000);
const YTDLP_TIMEOUT = Number(process.env.YTDLP_TIMEOUT || 120000); // timeout por tentativa (ms)
const YTDLP_MAX_ATTEMPTS = Number(process.env.YTDLP_MAX_ATTEMPTS || 5);
const YTDLP_INITIAL_BACKOFF = Number(process.env.YTDLP_INITIAL_BACKOFF || 2000); // ms
const TMP_DIR = process.env.TMP_DIR || undefined;
const COOKIES_FILE = process.env.COOKIES_FILE || '';
const YTDLP_PATH = process.env.YTDLP_PATH || 'yt-dlp'; // use '/usr/local/bin/yt-dlp' no servidor se precisar
const BLOCKED_HOSTS = (process.env.BLOCKED_HOSTS || '').split(',').map(h => h.trim().toLowerCase()).filter(Boolean);
const MAX_VIDEO_DURATION = Number(process.env.MAX_VIDEO_DURATION || 600); // segundos (padrão: 10 min)
const MAX_FILE_SIZE = Number(process.env.MAX_FILE_SIZE || 100 * 1024 * 1024); // bytes (padrão: 100MB)

// ==============================
// Serve static frontend/assets FIRST (very important)
// ==============================
// Redirect /index.html to root to keep URL limpa
app.get('/index.html', (req, res) => res.redirect(301, '/'));

app.use(express.static(path.join(__dirname, 'frontend')));

// parse json
app.use(express.json());

// Se você está atrás de um reverse proxy (nginx, cloudflare, etc.), manter 1
app.set('trust proxy', 1);

// ==============================
// Rate limiter: apply ONLY to API / download routes
// ==============================
const apiLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Rate limit exceeded. Tente novamente em alguns instantes.' }
});

// ==============================
// Helper: validate URLs
// ==============================
function isPrivateHost(hostname) {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (BLOCKED_HOSTS.some(blocked => host === blocked || host.endsWith(`.${blocked}`))) return true;

  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    const parts = host.split('.').map(Number);
    if (parts.some(part => part < 0 || part > 255)) return true;
    const [a, b] = parts;
    return a === 10 || a === 127 || a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168);
  }

  if (host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')) return true;
  return false;
}

function isAllowedUrl(u) {
  try {
    const parsed = new URL(u);
    return ['http:', 'https:'].includes(parsed.protocol) && !isPrivateHost(parsed.hostname);
  } catch (e) {
    return false;
  }
}

function mapFormatToYtDlp(format, url) {
  const isInstagram = url && /instagram\.com/i.test(url);
  const mp4Fallback = '[ext=mp4]/';

  // Instagram: preferir MP4 com H.264 para compatibilidade com WhatsApp
  if (isInstagram) {
    switch (String(format || 'best')) {
      case '720': return `bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=720]+bestaudio/best[height<=720]${mp4Fallback}best`;
      case '480': return `bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=480]+bestaudio/best[height<=480]${mp4Fallback}best`;
      case 'audio': return 'bestaudio/best';
      case 'best':
      default: return `bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio${mp4Fallback}best`;
    }
  }

  switch (String(format || 'best')) {
    case '720': return `bestvideo[height<=720]+bestaudio/best[height<=720]/best`;
    case '480': return `bestvideo[height<=480]+bestaudio/best[height<=480]/best`;
    case 'audio': return 'bestaudio/best';
    case 'best':
    default: return `bestvideo+bestaudio/best`;
  }
}

// ==============================
// Video metadata extraction
// ==============================
async function getVideoMetadata(url, formatArg) {
  const args = [
    url,
    '--dump-json',
    '--no-playlist',
    '-f', mapFormatToYtDlp(formatArg, url),
    '--no-warnings',
  ];

  if (COOKIES_FILE) {
    args.push('--cookies', COOKIES_FILE);
  }

  if (/instagram\.com/i.test(url)) {
    args.push('--add-header', 'User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36');
  }

  if (/youtube\.com/i.test(url)) {
    args.push('--extractor-args', 'youtube:player-client=web,android');
  }

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(YTDLP_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', err => reject(new Error('Failed to start yt-dlp: ' + err.message)));
    child.on('close', code => {
      if (code !== 0) {
        reject(new Error('Falha ao obter metadados do vídeo. ' + stderr.slice(0, 300)));
        return;
      }
      try {
        const firstLine = stdout.split('\n')[0];
        const metadata = JSON.parse(firstLine);
        resolve(metadata);
      } catch (err) {
        reject(new Error('Failed to parse metadata JSON: ' + err.message));
      }
    });
    setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} }, YTDLP_TIMEOUT);
  });
}

// ==============================
// Video validation
// ==============================
function validateVideo(metadata) {
  const duration = metadata.duration;
  if (duration && duration > MAX_VIDEO_DURATION) {
    const minutes = Math.floor(MAX_VIDEO_DURATION / 60);
    throw new Error(`Vídeo muito longo. Limite máximo: ${minutes} minutos.`);
  }

  let fileSize = metadata.filesize || metadata.filesize_approx;

  if (!fileSize && metadata.requested_formats) {
    fileSize = metadata.requested_formats.reduce((sum, f) => sum + (f.filesize || f.filesize_approx || 0), 0);
  }

  if (!fileSize && metadata.formats && metadata.formats.length > 0) {
    const last = metadata.formats[metadata.formats.length - 1];
    fileSize = last.filesize || last.filesize_approx;
  }

  if (fileSize && fileSize > MAX_FILE_SIZE) {
    const sizeMB = Math.round(MAX_FILE_SIZE / (1024 * 1024));
    throw new Error(`Arquivo muito grande para download. Limite máximo: ${sizeMB}MB.`);
  }
}

// ==============================
// Download helper using yt-dlp with retries/backoff
// ==============================
async function downloadToTemp(url, formatArg) {
  // cria arquivo temporário pra determinar diretório de saída
  const { path: tmpPath, cleanup: cleanupTmpFile } = await tmp.file({ postfix: '.tmp', discardDescriptor: true, dir: TMP_DIR });
  const tmpDir = path.dirname(tmpPath);
  const outTemplate = path.join(tmpDir, '%(title)s.%(ext)s');

  // args base (SEM --no-call-home)
  const baseArgs = [
    url,
    '--no-playlist',
    '-f', mapFormatToYtDlp(formatArg, url),
    '-o', outTemplate,
    '--restrict-filenames',
    '--no-warnings',
    '--no-progress',
    '--retries', '10',
    '--fragment-retries', '10',
    '--sleep-requests', '2',
    '--sleep-interval', '3',
    '--max-sleep-interval', '8',
    '--merge-output-format', 'mp4'
  ];

  if (COOKIES_FILE) {
    baseArgs.push('--cookies', COOKIES_FILE);
  }

  // Instagram: usar API pública por padrão (funciona para conteúdos públicos)
  if (/instagram\.com/i.test(url)) {
    baseArgs.push('--add-header', 'User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36');
  }

  // YouTube: usar extra-args para melhor compatibilidade
  if (/youtube\.com/i.test(url)) {
    baseArgs.push('--extractor-args', 'youtube:player-client=web,android');
  }

  let attempt = 0;
  let backoffMs = YTDLP_INITIAL_BACKOFF;

  // garante cleanup do tmpPath caso algo dê errado
  const cleanupAll = () => {
    try { fs.unlinkSync(tmpPath); } catch(_) {}
    try { cleanupTmpFile(); } catch(_) {}
  };

  while (attempt < YTDLP_MAX_ATTEMPTS) {
    attempt++;
    const args = [...baseArgs]; // clone
    console.log(`[yt-dlp] attempt ${attempt}/${YTDLP_MAX_ATTEMPTS}: ${YTDLP_PATH} ${args.join(' ')}`);

    const child = spawn(YTDLP_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    let stdout = '';
    let finished = false;

    child.stdout.on('data', d => { stdout += d.toString(); process.stdout.write(d); });
    child.stderr.on('data', d => { stderr += d.toString(); process.stderr.write(d); });

    const attemptTimeout = setTimeout(() => {
      if (!finished) {
        console.warn('[yt-dlp] attempt timeout reached, killing process');
        try { child.kill('SIGKILL'); } catch(e) {}
      }
    }, YTDLP_TIMEOUT);

    const exitCode = await new Promise((resolve) => {
      child.on('close', (code) => {
        finished = true;
        clearTimeout(attemptTimeout);
        resolve(code);
      });
      child.on('error', (err) => {
        finished = true;
        clearTimeout(attemptTimeout);
        console.error('[yt-dlp] spawn error', err);
        resolve(1);
      });
    });

    // diagnóstico
    const stderrLower = stderr.toLowerCase();
    const isDeprecatedFlag = /deprecated feature:.*--no-call-home/i.test(stderr);
    const isRateLimit = /rate[- ]?limi|too many requests|429\b|limit reached/i.test(stderrLower);
    const isNotAvailable = /requested content is not available/i.test(stderr) || /error: \[instagram\].*requested content is not available/i.test(stderrLower);
    const isPrivate = /private profile/i.test(stderrLower) || /This content is private/i.test(stderr);
    const is403or401 = /403|401/.test(stderr);

    if (isDeprecatedFlag) {
      // mensagem clara sobre remoção de flag --no-call-home
      cleanupAll();
      throw new Error('yt-dlp: deprecated flag --no-call-home detected in config/output. Remova essa flag das configs do yt-dlp.');
    }

    if (exitCode === 0) {
      // sucesso: encontra o arquivo mais recente no tmpDir
      try {
        const files = fs.readdirSync(tmpDir)
          .map(f => ({ f, m: fs.statSync(path.join(tmpDir,f)).mtimeMs }))
          .sort((a,b) => b.m - a.m);
        if (!files.length) {
          cleanupAll();
          throw new Error('No file produced by yt-dlp');
        }
        const filePath = path.join(tmpDir, files[0].f);
        // retornamos filePath e função cleanup para o caller
        return {
          filePath,
          cleanup: () => {
            try { fs.unlinkSync(filePath); } catch(_) {}
            cleanupAll();
          }
        };
      } catch (err) {
        cleanupAll();
        throw err;
      }
    }

    // Erros fatais que não fazem sentido continuar tentando
    if (isNotAvailable || isPrivate) {
      cleanupAll();
      throw new Error('Requested content is not available or is private. ' + stderr.slice(0,300));
    }

    // 401/403 provavelmente necessitam de autenticação (cookies/user)
    if (is403or401) {
      console.warn('[yt-dlp] servidor retornou 401/403 — verifique autenticação (cookies). Aborting retries.');
      cleanupAll();
      throw new Error('Authentication error (401/403). Use cookies or login for protected content. ' + stderr.slice(0,300));
    }

    // Se detectamos rate-limit -> backoff e retry
    if (isRateLimit) {
      console.warn(`[yt-dlp] detected rate-limit on attempt ${attempt}. stderr snippet: ${stderr.slice(0,200)}`);
      if (attempt >= YTDLP_MAX_ATTEMPTS) break;
      await sleep(backoffMs);
      backoffMs *= 2;
      continue;
    }

    // Outros erros: faz retry com backoff até o máximo
    console.warn(`[yt-dlp] attempt ${attempt} failed (exit ${exitCode}). stderr snippet: ${stderr.slice(0,200)}`);
    if (attempt >= YTDLP_MAX_ATTEMPTS) break;
    await sleep(backoffMs);
    backoffMs *= 2;
  }

  // se chegou aqui, falhou todas as tentativas
  cleanupAll();
  throw new Error('yt-dlp failed after max attempts');
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// ==============================
// Routes
// ==============================

app.get('/sw.js', (req, res) => {
  res.sendFile(__dirname + '/frontend/sw.js');
});

app.get('/manifest.json', (req, res) => {
  res.sendFile(__dirname + '/manifest.json');
});

// Simple health
app.get('/health', (req, res) => res.json({ ok: true }));

// API info
app.get('/api', (req, res) => {
  res.json({
    message: 'Downloader API (v2)',
    endpoints: {
      download: '/api/download?url=...&format=best|720|480|audio (GET, rate limited)',
      supportedUrls: 'URLs públicas HTTP(S) compatíveis com yt-dlp'
    }
  });
});

// Download route under /download (legacy) - protected by apiLimiter
app.get('/download', apiLimiter, async (req, res) => {
  const url = req.query.url;
  const format = req.query.format; // optional
  if (!url) return res.status(400).json({ error: 'query param "url" required' });
  if (!isAllowedUrl(url)) return res.status(400).json({ error: 'URL inválida ou bloqueada. Use uma URL pública HTTP(S).' });

  try {
    const metadata = await getVideoMetadata(url, format);
    validateVideo(metadata);
    const { filePath, cleanup } = await downloadToTemp(url, format);
    const ext = path.extname(filePath).toLowerCase();
    const contentType = ext === '.mp4' ? 'video/mp4' : ext === '.webm' ? 'video/webm' : ext === '.m4a' || ext === '.aac' ? 'audio/mp4' : 'application/octet-stream';
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(filePath)}"`);
    res.setHeader('Content-Type', contentType);
    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
    stream.on('close', () => { try{ cleanup(); } catch(_){} });
    stream.on('error', (err) => { try{ cleanup(); } catch(_){}; console.error('Stream error', err); if(!res.headersSent) res.status(500).json({ error: 'Stream error' }); });
  } catch (err) {
    console.error('Download error', err);
    const statusCode = err.message.includes('Vídeo muito longo') || err.message.includes('Arquivo muito grande') ? 400 : 500;
    res.status(statusCode).json({ error: err.message.includes('Vídeo muito longo') || err.message.includes('Arquivo muito grande') ? err.message : 'Failed to download', details: statusCode === 500 ? err.message : undefined });
  }
});

// API download route (namespaced) - also protected
app.get('/api/download', apiLimiter, async (req, res) => {
  const url = req.query.url;
  const format = req.query.format;
  if (!url) return res.status(400).json({ error: 'url param required' });
  if (!isAllowedUrl(url)) return res.status(400).json({ error: 'URL inválida ou bloqueada. Use uma URL pública HTTP(S).' });

  try {
    const metadata = await getVideoMetadata(url, format);
    validateVideo(metadata);
    const { filePath, cleanup } = await downloadToTemp(url, format);
    const ext = path.extname(filePath).toLowerCase();
    const contentType = ext === '.mp4' ? 'video/mp4' : ext === '.webm' ? 'video/webm' : ext === '.m4a' || ext === '.aac' ? 'audio/mp4' : 'application/octet-stream';
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(filePath)}"`);
    res.setHeader('Content-Type', contentType);
    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
    stream.on('close', () => { try{ cleanup(); } catch(_){} });
    stream.on('error', (err) => { try{ cleanup(); } catch(_){}; console.error('Stream error', err); if(!res.headersSent) res.status(500).json({ error: 'Stream error' }); });
  } catch (err) {
    console.error('Download error', err);
    const statusCode = err.message.includes('Vídeo muito longo') || err.message.includes('Arquivo muito grande') ? 400 : 500;
    res.status(statusCode).json({ error: err.message.includes('Vídeo muito longo') || err.message.includes('Arquivo muito grande') ? err.message : 'Failed to download', details: statusCode === 500 ? err.message : undefined });
  }
});

// Serve index.html for root if exists
app.get('/', (req, res) => {
  const idx = path.join(__dirname, 'frontend', 'index.html');
  if (fs.existsSync(idx)) return res.sendFile(idx);
  res.status(404).send('Not found');
});

// Start server
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
