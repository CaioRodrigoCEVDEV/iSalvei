'use strict';

const crypto = require('crypto');
const fs = require('fs');

const { appError, isAppError, sanitizeLog } = require('./errors');
const { normalizeQuality } = require('./platforms');
const { contentDisposition } = require('./media');
const {
  SESSION_COOKIE,
  parseCookieHeader,
  normalizeInstagramCookies,
  isSecureRequest,
  sessionCookieHeader,
} = require('./instagram-session');

function requestIdFor(req) {
  return req.get?.('x-request-id') || crypto.randomUUID();
}

function sendError(res, error, { requestId, logger, platform }) {
  const appErr = isAppError(error)
    ? error
    : appError(500, 'INTERNAL_ERROR', 'Erro interno ao processar o vídeo.');

  if (res.headersSent) {
    try { res.destroy(); } catch (_) {}
    return;
  }

  if (appErr.retryAfter) {
    res.setHeader('Retry-After', String(appErr.retryAfter));
  }
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  const status = appErr.statusCode || 500;
  const message = appErr.expose || status < 500
    ? appErr.message
    : 'Erro interno ao processar o vídeo.';

  if (status >= 500) {
    const details = sanitizeLog(appErr.details || '');
    logger?.error?.(`[download ${requestId}] ${platform || '-'} ${appErr.code}${details ? ` :: ${details}` : ''}`);
  }

  const payload = {
    error: message,
    code: appErr.code,
    requestId,
  };

  // O frontend usa este sinal para oferecer a conexão da conta do Instagram.
  if (appErr.code === 'AUTH_REQUIRED') payload.loginRequired = true;

  res.status(status).json(payload);
}

function readCookie(req, name) {
  const entries = parseCookieHeader(req.get?.('cookie') || '');
  const match = entries.find((entry) => entry.name === name);
  return match ? match.value : null;
}

/**
 * Rotas para conectar a conta do Instagram sem armazenar senha.
 * O usuário cola o sessionid/cookies exportados; o servidor mantém apenas em
 * memória e usa o arquivo temporário durante o download.
 */
function createInstagramSessionHandlers({ store, config, logger = console }) {
  const ttlMs = store.ttlMs || config?.instagramSessionTtl || 12 * 60 * 60 * 1000;

  return {
    status(req, res) {
      const session = store.get(readCookie(req, SESSION_COOKIE));
      res.setHeader('Cache-Control', 'no-store');
      if (!session) return res.json({ connected: false });
      return res.json({ connected: true, expiresAt: session.expiresAt });
    },

    create(req, res) {
      const requestId = requestIdFor(req);
      try {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const cookies = normalizeInstagramCookies(body.cookies);

        // Rotaciona o token: uma sessão antiga não continua válida após
        // conectar outra conta.
        store.remove(readCookie(req, SESSION_COOKIE));

        const session = store.create(cookies.text);

        res.setHeader('Set-Cookie', sessionCookieHeader(session.token, {
          maxAge: ttlMs / 1000,
          secure: isSecureRequest(req),
        }));
        res.setHeader('Cache-Control', 'no-store');
        return res.json({
          connected: true,
          expiresAt: session.expiresAt,
          userId: cookies.userId,
        });
      } catch (error) {
        logger.warn?.(`[instagram ${requestId}] falha ao conectar sessão: ${sanitizeLog(error.message)}`);
        return sendError(res, error, { requestId, logger });
      }
    },

    remove(req, res) {
      store.remove(readCookie(req, SESSION_COOKIE));
      res.setHeader('Set-Cookie', sessionCookieHeader('', { maxAge: 0, secure: isSecureRequest(req) }));
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ connected: false });
    },
  };
}

/**
 * Handler HTTP compartilhado por server.js e api_server.js. Mantém o mesmo
 * contrato de download, limites, headers e limpeza nos dois processos.
 */
function createDownloadHandler({ config, downloader, logger = console, sessionStore = null }) {
  return async function downloadHandler(req, res) {
    const requestId = requestIdFor(req);
    res.setHeader('X-Request-Id', requestId);

    let platform = null;
    let released = false;
    let cleanupPrepared = null;
    const abortController = new AbortController();

    const onResponseClose = () => {
      if (!res.writableEnded) {
        abortController.abort(appError(499, 'ABORTED', 'Download cancelado.'));
      }
    };
    res.on('close', onResponseClose);

    try {
      const rawUrl = req.query.url;
      const rawFormat = req.query.format;

      if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
        throw appError(400, 'URL_REQUIRED', 'Parâmetro "url" obrigatório.');
      }
      if (rawFormat !== undefined && typeof rawFormat !== 'string') {
        throw appError(400, 'INVALID_FORMAT', 'Parâmetro "format" inválido.');
      }

      const quality = normalizeQuality(rawFormat);
      const instagramSession = sessionStore
        ? sessionStore.get(readCookie(req, SESSION_COOKIE))
        : null;

      const result = await downloader.prepare(rawUrl, quality, {
        signal: abortController.signal,
        requestId,
        instagramCookies: instagramSession ? instagramSession.cookieText : null,
      });
      platform = result?.platform?.id || null;

      const cleanup = () => {
        if (released) return;
        released = true;
        try {
          Promise.resolve(result?.cleanup?.()).catch(() => {});
        } catch (_) {}
      };
      cleanupPrepared = cleanup;

      if (!result || !result.filePath || !fs.existsSync(result.filePath)) {
        throw appError(502, 'NO_OUTPUT', 'O arquivo preparado não foi encontrado.');
      }

      const stat = fs.statSync(result.filePath);
      if (!stat.isFile() || stat.size === 0) {
        throw appError(502, 'NO_OUTPUT', 'O arquivo preparado está vazio.');
      }
      if (stat.size > config.maxFileSize) {
        throw appError(413, 'FILE_TOO_LARGE', `Arquivo muito grande para download. Limite máximo: ${Math.round(config.maxFileSize / (1024 * 1024))}MB.`);
      }

      res.status(200);
      res.setHeader('Content-Type', result.contentType || 'application/octet-stream');
      res.setHeader('Content-Disposition', contentDisposition(result.filename || 'video.mp4'));
      res.setHeader('Content-Length', String(stat.size));
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');

      const stream = fs.createReadStream(result.filePath);
      stream.on('error', (error) => {
        logger?.error?.(`[download ${requestId}] stream ${sanitizeLog(error.message)}`);
        cleanup();
        if (!res.headersSent) {
          sendError(res, appError(500, 'STREAM_ERROR', 'Falha ao enviar o arquivo.'), { requestId, logger, platform });
        } else {
          try { res.destroy(); } catch (_) {}
        }
      });
      res.on('finish', cleanup);
      res.on('close', () => {
        try { stream.destroy(); } catch (_) {}
        cleanup();
      });
      stream.pipe(res);
    } catch (error) {
      if (cleanupPrepared) cleanupPrepared();
      if (error && error.code === 'ABORTED') {
        // Cliente desconectou; não há resposta útil e não é um erro de servidor.
        if (!res.destroyed) {
          try { res.destroy(); } catch (_) {}
        }
        return;
      }
      sendError(res, error, { requestId, logger, platform });
    } finally {
      res.removeListener('close', onResponseClose);
    }
  };
}

function createHealthHandler({ downloader, loginManager = null }) {
  return async function healthHandler(req, res) {
    try {
      const result = await downloader.checkHealth();
      const checks = { ...result.checks };

      if (loginManager) {
        if (!loginManager.enabled) checks.instagramLogin = 'disabled';
        else checks.instagramLogin = loginManager.browserPath ? 'ready' : 'unavailable';
      }

      res.status(result.ok ? 200 : 503).json({ ok: result.ok, checks });
    } catch (error) {
      res.status(503).json({ ok: false, checks: {} });
    }
  };
}

module.exports = {
  createDownloadHandler,
  createHealthHandler,
  createInstagramSessionHandlers,
  readCookie,
  sendError,
};
