require('dotenv').config();

const express = require('express');
const fs = require('fs');
const path = require('path');
const rateLimit = require('express-rate-limit');

const { loadConfig } = require('./lib/config');
const { createDownloader } = require('./lib/downloader');
const {
  createDownloadHandler,
  createHealthHandler,
  createInstagramSessionHandlers,
} = require('./lib/http');
const { createSessionStore } = require('./lib/instagram-session');
const { createLoginManager } = require('./lib/instagram-login');
const { createInstagramLoginHandlers } = require('./lib/instagram-login-http');
const { PLATFORMS } = require('./lib/platforms');

function createApp(options = {}) {
  const config = options.config || loadConfig();
  const downloader = options.downloader || createDownloader(config);
  const sessionStore = options.sessionStore || createSessionStore({ ttlMs: config.instagramSessionTtl });
  const loginManager = options.loginManager || createLoginManager({ config });
  const app = express();

  app.set('trust proxy', config.trustProxy);

  // Serve static frontend/assets first (mantém o comportamento atual).
  app.get('/index.html', (req, res) => res.redirect(301, '/'));
  app.use(express.static(path.join(__dirname, 'frontend')));
  app.use(express.json({ limit: '128kb' }));

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

  const loginLimiter = rateLimit({
    windowMs: config.instagramLoginRateWindowMs,
    max: config.instagramLoginRateMax,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res, next, limiterOptions) => {
      const reset = req.rateLimit && req.rateLimit.resetTime;
      if (reset instanceof Date) {
        res.setHeader('Retry-After', String(Math.max(1, Math.ceil((reset.getTime() - Date.now()) / 1000))));
      }
      res.status(limiterOptions?.statusCode || 429).json({
        error: 'Muitas tentativas de login. Aguarde alguns minutos.',
        code: 'LOGIN_RATE_LIMITED',
      });
    },
  });

  const downloadHandler = createDownloadHandler({ config, downloader, sessionStore });
  const healthHandler = createHealthHandler({ downloader, loginManager });
  const instagramHandlers = createInstagramSessionHandlers({ store: sessionStore, config });
  const instagramLoginHandlers = createInstagramLoginHandlers({
    manager: loginManager,
    sessionStore,
    config,
  });

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

  // Sessão opcional da conta do Instagram (cookies somente em memória).
  app.get('/api/instagram/session', instagramHandlers.status);
  app.post('/api/instagram/session', apiLimiter, instagramHandlers.create);
  app.delete('/api/instagram/session', instagramHandlers.remove);

  // Login assistido em navegador remoto (tela real do Instagram).
  app.post('/api/instagram/login', loginLimiter, instagramLoginHandlers.start);
  app.get('/api/instagram/login/:id/stream', instagramLoginHandlers.stream);
  app.post('/api/instagram/login/:id/input', instagramLoginHandlers.input);
  app.post('/api/instagram/login/:id/claim', instagramLoginHandlers.claim);
  app.delete('/api/instagram/login/:id', instagramLoginHandlers.cancel);

  app.get('/download', apiLimiter, downloadHandler);
  app.get('/api/download', apiLimiter, downloadHandler);

  app.get('/', (req, res) => {
    const index = path.join(__dirname, 'frontend', 'index.html');
    if (fs.existsSync(index)) return res.sendFile(index);
    res.status(404).send('Not found');
  });

  return { app, config, downloader, sessionStore, loginManager };
}

if (require.main === module) {
  const { app, config, downloader, loginManager } = createApp();
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
    if (config.instagramLoginEnabled) {
      if (loginManager.browserPath) console.log(`[instagram-login] Chromium: ${loginManager.browserPath}`);
      else console.warn('[instagram-login] Chromium não encontrado; login assistido desativado.');
    }
  });

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;

    const finish = () => {
      Promise.resolve()
        .then(() => loginManager.close())
        .catch(() => {})
        .finally(() => process.exit(0));
    };

    server.close(finish);
    // Fecha o Chromium e encerra os SSE imediatamente.
    Promise.resolve().then(() => loginManager.close()).catch(() => {});
    // SSE de login pode manter conexões abertas; encerra após o grace period.
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

module.exports = { createApp };
