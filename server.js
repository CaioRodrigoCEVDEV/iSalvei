
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
const YTDLP_TIMEOUT = Number(process.env.YTDLP_TIMEOUT || 240000);
const TMP_DIR = process.env.TMP_DIR || undefined;
const COOKIES_FILE = process.env.COOKIES_FILE || '';

// ==============================
// Serve static frontend/assets FIRST (very important)
// ==============================
app.use(express.static(path.join(__dirname, 'frontend')));

// parse json
app.use(express.json());
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
    return host.includes('instagram.com') || host.includes('x.com') || host.includes('twitter.com');
  } catch (e) {
    return false;
  }
}

// ==============================
// Download helper using yt-dlp (spawns process and writes into tmp dir)
// ==============================
async function downloadToTemp(url, formatArg) {
  const { path: tmpPath, cleanup } = await tmp.file({ postfix: '.tmp', discardDescriptor: true, dir: TMP_DIR });
  const tmpDir = path.dirname(tmpPath);
  const outTemplate = path.join(tmpDir, '%(id)s.%(ext)s');

  const args = [
    url,
    '--no-playlist',
    '-f', formatArg || 'bestvideo+bestaudio/best',
    '-o', outTemplate,
    '--restrict-filenames',
    '--no-warnings',
    '--no-call-home'
  ];
  if (COOKIES_FILE) args.push('--cookies', COOKIES_FILE);

  return new Promise((resolve, reject) => {
   //local 
    const child = spawn('yt-dlp', args);
   
   //no servidor
   //const child = spawn('/usr/local/bin/yt-dlp', args);

    let stderr = '';
    child.stderr.on('data', d => stderr += d.toString());
    child.on('error', err => reject(new Error('Failed to start yt-dlp: ' + err.message)));
    child.on('close', code => {
      if (code !== 0) return reject(new Error('yt-dlp exited with code ' + code + ' - ' + stderr.slice(0,300)));
      try {
        const files = fs.readdirSync(tmpDir)
          .map(f => ({ f, m: fs.statSync(path.join(tmpDir,f)).mtimeMs }))
          .sort((a,b) => b.m - a.m);
        if (!files.length) return reject(new Error('No file produced by yt-dlp'));
        const filePath = path.join(tmpDir, files[0].f);
        resolve({ filePath, cleanup: () => {
          try { fs.unlinkSync(filePath); } catch(_) {}
          try { fs.unlinkSync(tmpPath); } catch(_) {}
        }});
      } catch (err) { reject(err); }
    });

    // safety timeout
    setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (e) {}
    }, YTDLP_TIMEOUT);
  });
}

// ==============================
// Routes
// ==============================

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
