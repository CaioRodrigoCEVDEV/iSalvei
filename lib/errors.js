'use strict';

/**
 * Erro de aplicação com status HTTP, código estável e mensagem segura para o
 * cliente. `details` é somente para log interno e nunca deve ser serializado.
 */
class AppError extends Error {
  constructor(message, statusCode = 500, code = 'INTERNAL_ERROR', options = {}) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.retryable = Boolean(options.retryable);
    this.retryAfter = options.retryAfter;
    this.details = options.details;
    this.expose = options.expose !== undefined ? Boolean(options.expose) : statusCode < 500;
    Error.captureStackTrace?.(this, AppError);
  }
}

function appError(statusCode, code, message, options = {}) {
  return new AppError(message, statusCode, code, options);
}

function isAppError(value) {
  return value instanceof AppError;
}

/**
 * Remove URLs, cookies, chaves e outros dados sensíveis de um trecho de log.
 * Mantém o texto curto e legível para diagnóstico.
 */
function sanitizeLog(value, maxLength = 600) {
  let text = String(value == null ? '' : value);

  text = text
    .replace(/--cookies(?:-from-browser)?(?:=|\s+)(?:"[^"]*"|'[^']*'|\S+)/gi, '--cookies [redacted]')
    .replace(/--add-header\s+(?:"[^"]*"|'[^']*'|\S+)/gi, '--add-header [redacted]')
    .replace(/\b(?:x-api-key|api[_-]?key|authorization|bearer|token|secret|password)\b\s*[:=]\s*["']?[^"'\s,;]+/gi, '$1=[redacted]')
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[url]')
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim();

  if (text.length > maxLength) text = text.slice(0, maxLength) + '…';
  return text;
}

module.exports = {
  AppError,
  appError,
  isAppError,
  sanitizeLog,
};
