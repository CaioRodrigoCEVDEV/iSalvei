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
const YTDLP_TIMEOUT = Number(process.env.YTDLP_TIMEOUT || 240000); // timeout por tentativa (ms)
const YTDLP_MAX_ATTEMPTS = Number(process.env.YTDLP_MAX_ATTEMPTS || 5);
const YTDLP_INITIAL_BACKOFF = Number(process.env.YTDLP_INITIAL_BACKOFF || 2000); // ms
const TMP_DIR = process.env.TMP_DIR || undefined;
const COOKIES_FILE = process.env.COOKIES_FILE || '';
const YTDLP_PATH = process.env.YTDLP_PATH || 'yt-dlp'; // use '/usr/local/bin/yt-dlp' no servidor se precisar
const ALLOWED_HOSTS = ['instagram.com', 'x.com', 'twitter.com'];

// ==============================
// Serve static frontend/assets FIRST (very important)
// ==============================
app.use(express.static(path.join(__dirname, 'frontend')));

// parse json
app.use(express.json());

// Se você está atrás de um reverse proxy (nginx, cloudflare, etc.), manter 1
app.set('trust proxy', 1);

// ==============================
// Rate limiter: apply ONLY to API / download routes
// ==============================
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many requests, please try again later.'
});

// ==============================
// Helper: validate URLs
// ==============================
function isAllowedUrl(u) {
  try {
    const host = new URL(u).hostname.toLowerCase();
    return ALLOWED_HOSTS.some(h => host.includes(h));
  } catch (e) {
    return false;
  }
}

// ==============================
// Download helper using yt-dlp with retries/backoff
// ==============================
async function downloadToTemp(url, formatArg) {
  // cria arquivo temporário pra determinar diretório de saída
  const { path: tmpPath, cleanup: cleanupTmpFile } = await tmp.file({ postfix: '.tmp', discardDescriptor: true, dir: TMP_DIR });
  const tmpDir = path.dirname(tmpPath);
  const outTemplate = path.join(tmpDir, '%(id)s.%(ext)s');

  // args base (SEM --no-call-home)
  const baseArgs = [
    url,
    '--no-playlist',
    '-f', formatArg || 'bestvideo+bestaudio/best',
    '-o', outTemplate,
    '--restrict-filenames',
    '--no-warnings',
    '--no-progress',
    '--retries', '10',
    '--fragment-retries', '10',
    '--sleep-requests', '2',
    '--sleep-interval', '3'
  ];

  if (COOKIES_FILE) {
    baseArgs.push('--cookies', COOKIES_FILE);
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
  res.sendFile(__dirname + '/sw.js');
});

// Simple health
app.get('/health', (req, res) => res.json({ ok: true }));

// API info
app.get('/api', (req, res) => {
  res.json({
    message: 'Downloader API (v1)',
    endpoints: {
      download: '/api/download?url=... (GET, requires rate-limiter)'
    }
  });
});

// Download route under /download (legacy) - protected by apiLimiter
app.get('/download', apiLimiter, async (req, res) => {
  const url = req.query.url;
  const format = req.query.format; // optional
  if (!url) return res.status(400).json({ error: 'query param "url" required' });
  if (!isAllowedUrl(url)) return res.status(400).json({ error: 'URL not allowed' });

  try {
    const { filePath, cleanup } = await downloadToTemp(url, format);
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(filePath)}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
    stream.on('close', () => { try{ cleanup(); } catch(_){} });
    stream.on('error', (err) => { try{ cleanup(); } catch(_){}; console.error('Stream error', err); if(!res.headersSent) res.status(500).json({ error: 'Stream error' }); });
  } catch (err) {
    console.error('Download error', err);
    res.status(500).json({ error: 'Failed to download', details: err.message });
  }
});

// API download route (namespaced) - also protected
app.get('/api/download', apiLimiter, async (req, res) => {
  const url = req.query.url;
  const format = req.query.format;
  if (!url) return res.status(400).json({ error: 'url param required' });
  if (!isAllowedUrl(url)) return res.status(400).json({ error: 'URL not allowed' });

  try {
    const { filePath, cleanup } = await downloadToTemp(url, format);
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(filePath)}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
    stream.on('close', () => { try{ cleanup(); } catch(_){} });
    stream.on('error', (err) => { try{ cleanup(); } catch(_){}; console.error('Stream error', err); if(!res.headersSent) res.status(500).json({ error: 'Stream error' }); });
  } catch (err) {
    console.error('Download error', err);
    res.status(500).json({ error: 'Failed to download', details: err.message });
  }
});

// Serve index.html for root if exists
app.get('/', (req, res) => {
  const idx = path.join(__dirname, 'frontend', 'insta.html');
  if (fs.existsSync(idx)) return res.sendFile(idx);
  const idx2 = path.join(__dirname, 'frontend', 'index.html');
  if (fs.existsSync(idx2)) return res.sendFile(idx2);
  res.status(404).send('Not found');
});

// Start server
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
