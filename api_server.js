
require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const tmp = require('tmp-promise');
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');

const DB_PATH = process.env.API_DB_PATH || path.join(__dirname, 'data', 'api.db');
const PORT = process.env.API_PORT || process.env.PORT || 3000;
const YTDLP_TIMEOUT = Number(process.env.YTDLP_TIMEOUT || 120000);
const TMP_DIR = process.env.TMP_DIR || undefined;
const COOKIES_FILE = process.env.COOKIES_FILE || '';
const YTDLP_PATH = process.env.YTDLP_PATH || 'yt-dlp';
const BLOCKED_HOSTS = (process.env.BLOCKED_HOSTS || '').split(',').map(h => h.trim().toLowerCase()).filter(Boolean);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'frontend')));

// db
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY,
    api_key TEXT UNIQUE,
    created_at INTEGER,
    quota_per_minute INTEGER DEFAULT 10
  );
  CREATE TABLE IF NOT EXISTS requests (
    id INTEGER PRIMARY KEY,
    api_key TEXT,
    timestamp INTEGER
  );
`);

// helper functions
function mapFormatToYtDlp(format){
  // friendly format names to yt-dlp format selectors
  switch(String(format)){
    case '720': return 'bestvideo[height<=720]+bestaudio/best[height<=720]/best';
    case '480': return 'bestvideo[height<=480]+bestaudio/best[height<=480]/best';
    case 'audio': return 'bestaudio/best';
    default: return 'bestvideo+bestaudio/best';
  }
}

function createApiKey(quota=10){
  const key = uuidv4().replace(/-/g,'');
  const stmt = db.prepare('INSERT INTO api_keys (api_key, created_at, quota_per_minute) VALUES (?, ?, ?)');
  stmt.run(key, Date.now(), quota);
  return key;
}

function findApiKey(key){
  if(!key) return null;
  const row = db.prepare('SELECT * FROM api_keys WHERE api_key = ?').get(key);
  return row;
}

function checkRateLimit(key){
  const windowStart = Date.now() - 60_000;
  const countRow = db.prepare('SELECT COUNT(*) as c FROM requests WHERE api_key = ? AND timestamp > ?').get(key, windowStart);
  const keyRow = findApiKey(key);
  const quota = keyRow ? keyRow.quota_per_minute : 0;
  if (countRow.c >= quota) return false;
  db.prepare('INSERT INTO requests (api_key, timestamp) VALUES (?, ?)').run(key, Date.now());
  return true;
}

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

function isAllowedUrl(u){
  try {
    const parsed = new URL(u);
    return ['http:', 'https:'].includes(parsed.protocol) && !isPrivateHost(parsed.hostname);
  } catch(e){
    return false;
  }
}

async function downloadToTemp(url, format){
  const { path: tmpPath, cleanup } = await tmp.file({ postfix: '.tmp', discardDescriptor: true, dir: TMP_DIR });
  const tmpDir = path.dirname(tmpPath);
  const outTemplate = path.join(tmpDir, '%(id)s.%(ext)s');

  const fmt = mapFormatToYtDlp(format);

  const args = [
    url,
    '--no-playlist',
    '-f', fmt,
    '-o', outTemplate,
    '--restrict-filenames',
    '--no-warnings',
    '--no-progress',
    '--retries', '10',
    '--fragment-retries', '10',
    '--sleep-requests', '2',
    '--sleep-interval', '3',
    '--max-sleep-interval', '8'
  ];
  if (COOKIES_FILE) args.push('--cookies', COOKIES_FILE);

  return new Promise((resolve, reject) => {
    const child = spawn(YTDLP_PATH, args);
    let stderr = '';
    child.stderr.on('data', d => stderr += d.toString());
    child.on('error', err => reject(new Error('Failed to start yt-dlp: ' + err.message)));
    child.on('close', code => {
      if (code !== 0) return reject(new Error('yt-dlp exited with code ' + code + ' - ' + stderr.slice(0,300)));
      try {
        const files = fs.readdirSync(tmpDir).map(f => ({ f, m: fs.statSync(path.join(tmpDir,f)).mtimeMs })).sort((a,b) => b.m - a.m);
        if(!files.length) return reject(new Error('No file produced by yt-dlp'));
        const filePath = path.join(tmpDir, files[0].f);
        resolve({ filePath, cleanup: () => { try{ fs.unlinkSync(filePath);}catch(_){}; try{ fs.unlinkSync(tmpPath);}catch(_){} }});
      } catch(err) { reject(err); }
    });
    setTimeout(() => { try{ child.kill('SIGKILL'); }catch(e){} }, YTDLP_TIMEOUT);
  });
}

// middleware for api key
function requireApiKey(req, res, next){
  const key = req.get('x-api-key') || req.query.key || (req.headers['authorization'] && req.headers['authorization'].replace('Bearer ',''));
  if(!key) return res.status(401).json({ error: 'API key required. Provide in X-API-KEY header or ?key=...' });
  const keyRow = findApiKey(key);
  if(!keyRow) return res.status(401).json({ error: 'Invalid API key' });
  if(!checkRateLimit(key)) return res.status(429).json({ error: 'Rate limit exceeded' });
  req.apiKey = keyRow;
  next();
}

// register
app.post('/api/register', (req, res) => {
  const quota = Number(req.body.quota) || 10;
  const key = createApiKey(quota);
  res.json({ api_key: key, quota_per_minute: quota });
});

app.get('/api/download', requireApiKey, async (req, res) => {
  const url = req.query.url;
  const format = req.query.format;
  if(!url) return res.status(400).json({ error: 'url param required' });
  if(!isAllowedUrl(url)) return res.status(400).json({ error: 'URL inválida ou bloqueada. Use uma URL pública HTTP(S).' });

  try {
    const { filePath, cleanup } = await downloadToTemp(url, format);
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(filePath)}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
    stream.on('close', () => { try{ cleanup(); }catch(_){} });
    stream.on('error', (err) => { try{ cleanup(); }catch(_){}; console.error(err); if(!res.headersSent) res.status(500).json({ error: 'Stream error' }); });
  } catch(err){
    console.error('Download error', err);
    res.status(500).json({ error: 'Failed to download', details: err.message });
  }
});

app.listen(PORT, () => console.log('API server running on port', PORT));
