'use strict';

const crypto = require('crypto');
const fs = require('fs');

const { AppError, appError, isAppError, sanitizeLog } = require('./errors');
const { normalizeQuality } = require('./platforms');
const { contentDisposition } = require('./media');

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

  res.status(status).json({
    error: message,
    code: appErr.code,
    requestId,
  });
}

/**
 * Handler HTTP compartilhado por server.js e api_server.js. Mantém o mesmo
 * contrato de download, limites, headers e limpeza nos dois processos.
 */
function createDownloadHandler({ config, downloader, logger = console }) {
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
      const result = await downloader.prepare(rawUrl, quality, {
        signal: abortController.signal,
        requestId,
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

function createHealthHandler({ downloader }) {
  return async function healthHandler(req, res) {
    try {
      const result = await downloader.checkHealth();
      res.status(result.ok ? 200 : 503).json({ ok: result.ok, checks: result.checks });
    } catch (error) {
      res.status(503).json({ ok: false, checks: {} });
    }
  };
}

module.exports = {
  createDownloadHandler,
  createHealthHandler,
  sendError,
};
