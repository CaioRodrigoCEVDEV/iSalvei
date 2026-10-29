require('dotenv').config();

const express = require('express');
const fs = require('fs');
const path = require('path');
const rateLimit = require('express-rate-limit');

const { loadConfig } = require('./lib/config');
const { createDownloader } = require('./lib/downloader');
const { createDownloadHandler, createHealthHandler } = require('./lib/http');
const { PLATFORMS } = require('./lib/platforms');

function createApp(options = {}) {
  const config = options.config || loadConfig();
  const downloader = options.downloader || createDownloader(config);
  const app = express();

  app.set('trust proxy', config.trustProxy);

  // Serve static frontend/assets first (mantém o comportamento atual).
  app.get('/index.html', (req, res) => res.redirect(301, '/'));
  app.use(express.static(path.join(__dirname, 'frontend')));
  app.use(express.json());

  const apiLimiter = rateLimit({
    windowMs: config.rateLimitWindowMs,
    max: config.rateLimitMax,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res, next, limiterOptions) => {
      const reset = req.rateLimit && req.rateLimit.resetTime;
      if (reset instanceof Date) {
        res.setHeader('Retry-After', String(Math.max(1, Math.ceil((reset.getTime() - Date.now()) / 1000))));
      }
      res.status(limiterOptions?.statusCode || 429).json({
        error: 'Muitas requisições. Tente novamente em alguns instantes.',
        code: 'RATE_LIMITED',
      });
    },
  });

  const downloadHandler = createDownloadHandler({ config, downloader });
  const healthHandler = createHealthHandler({ downloader });

  app.get('/sw.js', (req, res) => res.sendFile(path.join(__dirname, 'frontend', 'sw.js')));
  app.get('/manifest.json', (req, res) => res.sendFile(path.join(__dirname, 'manifest.json')));
  app.get('/health', healthHandler);

  app.get('/api', (req, res) => {
    res.json({
      message: 'Downloader API (v3)',
      formats: ['best', '720', '480', 'audio'],
      platforms: PLATFORMS.filter((platform) => platform.supported).map((platform) => platform.name),
      endpoints: {
        download: '/api/download?url=...&format=best|720|480|audio (GET, rate limited)',
        health: '/health',
      },
    });
  });

  app.get('/download', apiLimiter, downloadHandler);
  app.get('/api/download', apiLimiter, downloadHandler);

  app.get('/', (req, res) => {
    const index = path.join(__dirname, 'frontend', 'index.html');
    if (fs.existsSync(index)) return res.sendFile(index);
    res.status(404).send('Not found');
  });

  return { app, config, downloader };
}

if (require.main === module) {
  const { app, config, downloader } = createApp();
  const server = app.listen(config.port, async () => {
    console.log(`Server running on port ${config.port}`);
    try {
      const health = await downloader.checkHealth();
      if (!health.ok) {
        console.warn('[startup] Dependências incompletas:', health.checks);
      }
    } catch (error) {
      console.warn('[startup] Não foi possível verificar dependências:', error.message);
    }
  });

  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = { createApp };
