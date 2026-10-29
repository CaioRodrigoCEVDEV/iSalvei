'use strict';

const crypto = require('crypto');

const { appError } = require('./errors');
const { sendError } = require('./http');
const { sessionCookieHeader, isSecureRequest } = require('./instagram-session');

function requestIdFor(req) {
  return req.get?.('x-request-id') || crypto.randomUUID();
}

function isSameOrigin(req) {
  const origin = req.get?.('origin');
  if (!origin) return true;
  try {
    return new URL(origin).host === req.get('host');
  } catch (error) {
    return false;
  }
}

/**
 * Rotas do login assistido. O navegador remoto controla apenas a página do
 * Instagram; nenhum dado de formulário é persistido ou registrado em log.
 */
function createInstagramLoginHandlers({ manager, sessionStore, config, logger = console }) {
  const ttlMs = sessionStore.ttlMs || config?.instagramSessionTtl || 12 * 60 * 60 * 1000;

  return {
    async start(req, res) {
      const requestId = requestIdFor(req);
      res.setHeader('X-Request-Id', requestId);
      res.setHeader('Cache-Control', 'no-store');
      try {
        if (!isSameOrigin(req)) {
          throw appError(403, 'CSRF_REJECTED', 'Origem da requisição não permitida.');
        }
        const session = await manager.start({ ip: req.ip });
        return res.status(201).json(session);
      } catch (error) {
        return sendError(res, error, { requestId, logger });
      }
    },

    async input(req, res) {
      const requestId = requestIdFor(req);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Request-Id', requestId);
      try {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const result = await manager.input(req.params.id, body, req.ip);
        return res.json(result);
      } catch (error) {
        return sendError(res, error, { requestId, logger });
      }
    },

    stream(req, res) {
      const requestId = requestIdFor(req);
      res.setHeader('X-Request-Id', requestId);
      try {
        manager.subscribe(req.params.id, req.ip, res);
      } catch (error) {
        if (!res.headersSent) sendError(res, error, { requestId, logger });
        else {
          try { res.end(); } catch (cleanupError) {}
        }
      }
    },

    claim(req, res) {
      const requestId = requestIdFor(req);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Request-Id', requestId);
      try {
        const cookieText = manager.claim(req.params.id, req.ip);
        const session = sessionStore.create(cookieText);

        res.setHeader('Set-Cookie', sessionCookieHeader(session.token, {
          maxAge: ttlMs / 1000,
          secure: isSecureRequest(req),
        }));
        return res.json({ connected: true, expiresAt: session.expiresAt });
      } catch (error) {
        return sendError(res, error, { requestId, logger });
      }
    },

    cancel(req, res) {
      const requestId = requestIdFor(req);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Request-Id', requestId);
      try {
        manager.cancel(req.params.id, req.ip);
        return res.json({ connected: false });
      } catch (error) {
        return sendError(res, error, { requestId, logger });
      }
    },
  };
}

module.exports = { createInstagramLoginHandlers };
