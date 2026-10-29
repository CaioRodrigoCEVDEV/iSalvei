'use strict';

const crypto = require('crypto');

const { appError } = require('./errors');

const MAX_COOKIE_BYTES = 64 * 1024;
const SESSION_COOKIE = 'isalvei_ig';
const SESSION_TOKEN_PATTERN = /^[a-f0-9]{64}$/;

function isInstagramDomain(domain) {
  const normalized = String(domain || '')
    .replace(/^#HttpOnly_/i, '')
    .replace(/^\./, '')
    .trim()
    .toLowerCase();
  return normalized === 'instagram.com' || normalized.endsWith('.instagram.com');
}

function invalidCookies(message) {
  return appError(
    400,
    'INVALID_COOKIES',
    message || 'Cookies do Instagram inválidos. Cole o valor de sessionid ou o conteúdo de um cookies.txt do Instagram.'
  );
}

function parseCookieHeader(input) {
  const entries = [];
  for (const part of String(input || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;

    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!/^[\w!#$%&'*+\-.^`|~]+$/.test(name)) continue;
    if (!value || /[\r\n\t;]/.test(value)) continue;

    entries.push({ name, value });
  }
  return entries;
}

/**
 * Normaliza três formatos aceitos:
 * 1. cookies.txt Netscape (exportado por extensão);
 * 2. header Cookie (`sessionid=...; csrftoken=...`);
 * 3. apenas o valor de sessionid.
 *
 * Somente cookies de instagram.com são mantidos. O resultado é um cookies.txt
 * pronto para o yt-dlp, sem nunca ser gravado em disco de forma permanente.
 */
function normalizeInstagramCookies(input) {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) throw invalidCookies('Cole os cookies ou o sessionid da sua conta do Instagram.');
  if (raw.length > MAX_COOKIE_BYTES) throw invalidCookies('Os cookies enviados são grandes demais.');

  let entries = [];

  if (raw.includes('\t')) {
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const isHttpOnly = /^#HttpOnly_/i.test(trimmed);
      if (trimmed.startsWith('#') && !isHttpOnly) continue;

      const columns = trimmed.split('\t');
      if (columns.length < 7) continue;

      const domain = columns[0].replace(/^#HttpOnly_/i, '').trim();
      if (!isInstagramDomain(domain)) continue;

      const name = columns[5].trim();
      const value = columns[6].trim();
      if (!name || !value || /[\r\n\t;]/.test(name) || /[\r\n\t;]/.test(value)) continue;

      entries.push({
        domain,
        path: columns[2] || '/',
        secure: String(columns[3]).toUpperCase() === 'TRUE',
        expires: Number(columns[4]) || 0,
        name,
        value,
      });
    }
  } else {
    const pairs = parseCookieHeader(raw);
    if (pairs.length) {
      for (const { name, value } of pairs) {
        entries.push({ domain: '.instagram.com', path: '/', secure: true, expires: 0, name, value });
      }
    } else if (/^[^\s;]+$/.test(raw)) {
      entries.push({ domain: '.instagram.com', path: '/', secure: true, expires: 0, name: 'sessionid', value: raw });
    }
  }

  // Mantém apenas a última ocorrência de cada cookie (exportações podem repetir).
  const byName = new Map();
  for (const entry of entries) byName.set(entry.name, entry);
  entries = Array.from(byName.values());

  const session = entries.find((entry) => entry.name === 'sessionid');
  if (!session) throw invalidCookies('Não encontrei o cookie "sessionid" do Instagram.');

  if (!byName.has('csrftoken')) {
    entries.push({
      domain: '.instagram.com',
      path: '/',
      secure: true,
      expires: 0,
      name: 'csrftoken',
      value: crypto.randomBytes(16).toString('hex'),
    });
  }

  if (!byName.has('ds_user_id')) {
    const userId = session.value.split(/%3A|:/i)[0];
    if (/^\d+$/.test(userId)) {
      entries.push({
        domain: '.instagram.com',
        path: '/',
        secure: true,
        expires: 0,
        name: 'ds_user_id',
        value: userId,
      });
    }
  }

  const lines = [
    '# Netscape HTTP Cookie File',
    '# Gerado pelo iSalvei. Sessão mantida apenas em memória.',
  ];
  for (const entry of entries) {
    lines.push([
      entry.domain,
      'TRUE',
      entry.path || '/',
      entry.secure ? 'TRUE' : 'FALSE',
      entry.expires || 0,
      entry.name,
      entry.value,
    ].join('\t'));
  }

  return {
    text: `${lines.join('\n')}\n`,
    sessionId: session.value,
    userId: entries.find((entry) => entry.name === 'ds_user_id')?.value || null,
  };
}

function createSessionStore(options = {}) {
  const ttlMs = Math.max(60 * 1000, Number(options.ttlMs) || 12 * 60 * 60 * 1000);
  const maxSessions = Math.max(1, Number(options.maxSessions) || 1000);
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const sessions = new Map();

  function pruneExpired() {
    const timestamp = now();
    for (const [token, session] of sessions) {
      if (session.expiresAt <= timestamp) sessions.delete(token);
    }
  }

  return {
    ttlMs,
    cookieName: SESSION_COOKIE,
    create(cookieText) {
      pruneExpired();
      while (sessions.size >= maxSessions) {
        const oldest = sessions.keys().next().value;
        if (!oldest) break;
        sessions.delete(oldest);
      }
      const token = crypto.randomBytes(32).toString('hex');
      const session = {
        cookieText,
        createdAt: now(),
        expiresAt: now() + ttlMs,
      };
      sessions.set(token, session);
      return { token, expiresAt: session.expiresAt };
    },
    get(token) {
      if (!token || !SESSION_TOKEN_PATTERN.test(String(token))) return null;
      const session = sessions.get(token);
      if (!session) return null;
      if (session.expiresAt <= now()) {
        sessions.delete(token);
        return null;
      }
      return session;
    },
    remove(token) {
      if (!token) return false;
      return sessions.delete(token);
    },
    clear() {
      sessions.clear();
    },
    get size() {
      pruneExpired();
      return sessions.size;
    },
  };
}

module.exports = {
  MAX_COOKIE_BYTES,
  SESSION_COOKIE,
  SESSION_TOKEN_PATTERN,
  isInstagramDomain,
  parseCookieHeader,
  normalizeInstagramCookies,
  createSessionStore,
};
