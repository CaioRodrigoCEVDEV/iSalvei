require('dotenv').config();

const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const { loadConfig } = require('./lib/config');
const { createDownloader } = require('./lib/downloader');
const {
  createDownloadHandler,
  createHealthHandler,
} = require('./lib/http');

const DB_PATH = process.env.API_DB_PATH || path.join(__dirname, 'data', 'api.db');

function openDatabase(dbPath = DB_PATH) {
  if (dbPath !== ':memory:') {
    const dataDir = path.dirname(dbPath);
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  }

  const db = new Database(dbPath);
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
  return db;
}

function createApiApp(options = {}) {
  const config = options.config || loadConfig();
  const downloader = options.downloader || createDownloader(config);
  const db = options.db || openDatabase(options.dbPath || DB_PATH);

  const app = express();
  app.set('trust proxy', config.trustProxy);
  app.use(express.json({ limit: '128kb' }));
  app.use(express.static(path.join(__dirname, 'frontend')));

  const healthHandler = createHealthHandler({ downloader });
  app.get('/health', healthHandler);

  function createApiKey(quota = 10) {
    const key = crypto.randomUUID().replace(/-/g, '');
    db.prepare('INSERT INTO api_keys (api_key, created_at, quota_per_minute) VALUES (?, ?, ?)')
      .run(key, Date.now(), quota);
    return key;
  }

  function findApiKey(key) {
    if (!key) return null;
    return db.prepare('SELECT * FROM api_keys WHERE api_key = ?').get(key);
  }

  function checkRateLimit(key) {
    const windowStart = Date.now() - 60_000;
    const countRow = db.prepare('SELECT COUNT(*) as c FROM requests WHERE api_key = ? AND timestamp > ?')
      .get(key, windowStart);
    const keyRow = findApiKey(key);
    const quota = keyRow ? keyRow.quota_per_minute : 0;
    if (countRow.c >= quota) return false;
    db.prepare('INSERT INTO requests (api_key, timestamp) VALUES (?, ?)').run(key, Date.now());
    return true;
  }

  function requireApiKey(req, res, next) {
    const key = req.get('x-api-key') ||
      req.query.key ||
      (req.headers.authorization && req.headers.authorization.replace(/^Bearer\s+/i, ''));
    if (!key) return res.status(401).json({ error: 'API key required. Provide in X-API-KEY header.' });
    const keyRow = findApiKey(key);
    if (!keyRow) return res.status(401).json({ error: 'Invalid API key' });
    if (!checkRateLimit(key)) {
      res.setHeader('Retry-After', '60');
      return res.status(429).json({ error: 'Rate limit exceeded' });
    }
    req.apiKey = keyRow;
    next();
  }

  app.post('/api/register', (req, res) => {
    const requestedQuota = Number(req.body && req.body.quota);
    const quota = Number.isFinite(requestedQuota)
      ? Math.min(1000, Math.max(1, Math.floor(requestedQuota)))
      : 10;
    const key = createApiKey(quota);
    res.json({ api_key: key, quota_per_minute: quota });
  });

  const downloadHandler = createDownloadHandler({ config, downloader });
  app.get('/api/download', requireApiKey, downloadHandler);

  return { app, config, downloader, db };
}

if (require.main === module) {
  const { app, config, downloader } = createApiApp();
  const server = app.listen(config.apiPort, async () => {
    console.log('API server running on port', config.apiPort);
    try {
      const health = await downloader.checkHealth();
      if (!health.ok) console.warn('[startup] Dependências incompletas:', health.checks);
    } catch (error) {
      console.warn('[startup] Não foi possível verificar dependências:', error.message);
    }
  });

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;

    const finish = () => process.exit(0);
    server.close(finish);
    server.closeIdleConnections?.();
    const force = setTimeout(() => {
      server.closeAllConnections?.();
      finish();
    }, 5000);
    force.unref?.();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = { createApiApp, openDatabase };
