'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULTS = Object.freeze({
  port: 3000,
  apiPort: 3000,
  rateLimitMax: 10,
  rateLimitWindowMs: 60 * 1000,
  ytdlpTimeout: 240000,
  ytdlpMaxAttempts: 5,
  ytdlpInitialBackoff: 2000,
  ffmpegTimeout: 600000,
  jobTimeout: 900000,
  maxVideoDuration: 600,
  maxFileSize: 100 * 1024 * 1024,
  maxConcurrentDownloads: 2,
  queueTimeout: 30000,
  maxUrlLength: 2048,
  instagramSessionTtl: 12 * 60 * 60 * 1000,
  instagramImpersonate: 'chrome',
  instagramLoginEnabled: true,
  instagramLoginTtl: 5 * 60 * 1000,
  instagramLoginMaxSessions: 2,
  instagramLoginNavigationTimeout: 45000,
  instagramLoginRateMax: 5,
  instagramLoginRateWindowMs: 10 * 60 * 1000,
  instagramBrowserPath: '',
});

function parseInteger(value, fallback, min, max) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const parsed = Number.parseInt(String(value).trim(), 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function parseList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function resolveConfiguredPath(value) {
  const trimmed = String(value || '').trim();
  return trimmed ? path.resolve(trimmed) : '';
}

/**
 * Lê e valida a configuração. Valores inválidos nunca viram NaN: voltam ao
 * default, para que limites de duração/tamanho não sejam desativados por
 * acidente.
 */
function loadConfig(env = process.env) {
  const config = {
    port: parseInteger(env.PORT, DEFAULTS.port, 1, 65535),
    apiPort: parseInteger(env.API_PORT || env.PORT, DEFAULTS.apiPort, 1, 65535),
    rateLimitMax: parseInteger(env.RATE_LIMIT_MAX, DEFAULTS.rateLimitMax, 1, 100000),
    rateLimitWindowMs: parseInteger(env.RATE_LIMIT_WINDOW_MS, DEFAULTS.rateLimitWindowMs, 1000, 24 * 60 * 60 * 1000),
    ytdlpTimeout: parseInteger(env.YTDLP_TIMEOUT, DEFAULTS.ytdlpTimeout, 1000, 30 * 60 * 1000),
    ytdlpMaxAttempts: parseInteger(env.YTDLP_MAX_ATTEMPTS, DEFAULTS.ytdlpMaxAttempts, 1, 10),
    ytdlpInitialBackoff: parseInteger(env.YTDLP_INITIAL_BACKOFF, DEFAULTS.ytdlpInitialBackoff, 0, 60000),
    ffmpegTimeout: parseInteger(env.FFMPEG_TIMEOUT, DEFAULTS.ffmpegTimeout, 1000, 60 * 60 * 1000),
    jobTimeout: parseInteger(env.JOB_TIMEOUT, DEFAULTS.jobTimeout, 1000, 60 * 60 * 1000),
    maxVideoDuration: parseInteger(env.MAX_VIDEO_DURATION, DEFAULTS.maxVideoDuration, 1, 24 * 60 * 60),
    maxFileSize: parseInteger(env.MAX_FILE_SIZE, DEFAULTS.maxFileSize, 1024, 4 * 1024 * 1024 * 1024),
    maxConcurrentDownloads: parseInteger(env.MAX_CONCURRENT_DOWNLOADS, DEFAULTS.maxConcurrentDownloads, 1, 20),
    queueTimeout: parseInteger(env.DOWNLOAD_QUEUE_TIMEOUT, DEFAULTS.queueTimeout, 0, 5 * 60 * 1000),
    maxUrlLength: parseInteger(env.MAX_URL_LENGTH, DEFAULTS.maxUrlLength, 32, 16384),
    // Sessão anônima do Instagram: o yt-dlp só consegue extrair Reels públicos
    // quando imita o fingerprint TLS/HTTP de um navegador (curl-cffi).
    instagramImpersonate: String(env.IG_IMPERSONATE === undefined ? DEFAULTS.instagramImpersonate : env.IG_IMPERSONATE).trim(),
    // TTL das sessões de usuário (cookies colados no app). Mantido em memória.
    instagramSessionTtl: parseInteger(env.IG_SESSION_TTL, DEFAULTS.instagramSessionTtl, 60 * 1000, 7 * 24 * 60 * 60 * 1000),
    // Login assistido: Chromium headless exibindo a página real do Instagram.
    instagramLoginEnabled: parseBoolean(env.IG_LOGIN_ENABLED, DEFAULTS.instagramLoginEnabled),
    instagramLoginTtl: parseInteger(env.IG_LOGIN_TTL, DEFAULTS.instagramLoginTtl, 60 * 1000, 30 * 60 * 1000),
    instagramLoginMaxSessions: parseInteger(env.IG_LOGIN_MAX_SESSIONS, DEFAULTS.instagramLoginMaxSessions, 1, 10),
    instagramLoginNavigationTimeout: parseInteger(env.IG_LOGIN_NAVIGATION_TIMEOUT, DEFAULTS.instagramLoginNavigationTimeout, 10000, 120000),
    instagramLoginRateMax: parseInteger(env.IG_LOGIN_RATE_MAX, DEFAULTS.instagramLoginRateMax, 1, 1000),
    instagramLoginRateWindowMs: parseInteger(env.IG_LOGIN_RATE_WINDOW_MS, DEFAULTS.instagramLoginRateWindowMs, 60 * 1000, 24 * 60 * 60 * 1000),
    instagramBrowserPath: String(env.IG_BROWSER_PATH || DEFAULTS.instagramBrowserPath).trim(),
    tmpDir: resolveConfiguredPath(env.TMP_DIR),
    cookiesFile: resolveConfiguredPath(env.COOKIES_FILE),
    ytdlpPath: String(env.YTDLP_PATH || 'yt-dlp').trim() || 'yt-dlp',
    ffmpegPath: String(env.FFMPEG_PATH || 'ffmpeg').trim() || 'ffmpeg',
    ffprobePath: String(env.FFPROBE_PATH || 'ffprobe').trim() || 'ffprobe',
    blockedHosts: parseList(env.BLOCKED_HOSTS),
    trustProxy: parseBoolean(env.TRUST_PROXY, false) ? 1 : false,
    nodeEnv: String(env.NODE_ENV || 'development'),
    logLevel: String(env.LOG_LEVEL || 'info').toLowerCase(),
  };

  return config;
}

function ensureRuntimeDirs(config) {
  if (!config.tmpDir) return;
  fs.mkdirSync(config.tmpDir, { recursive: true, mode: 0o700 });
}

/**
 * Retorna avisos de configuração sem derrubar o processo. O /health expõe o
 * estado; o log de inicialização mostra os avisos.
 */
function getConfigWarnings(config) {
  const warnings = [];

  if (config.tmpDir) {
    try {
      ensureRuntimeDirs(config);
      fs.accessSync(config.tmpDir, fs.constants.W_OK);
    } catch (error) {
      warnings.push(`TMP_DIR não é gravável: ${config.tmpDir}`);
    }
  }

  if (config.cookiesFile) {
    try {
      fs.accessSync(config.cookiesFile, fs.constants.R_OK);
    } catch (error) {
      warnings.push('COOKIES_FILE configurado, mas o arquivo não é legível.');
    }
  }

  if (config.maxVideoDuration <= 0) warnings.push('MAX_VIDEO_DURATION inválido; usando default.');
  if (config.maxFileSize <= 0) warnings.push('MAX_FILE_SIZE inválido; usando default.');

  return warnings;
}

module.exports = {
  DEFAULTS,
  loadConfig,
  ensureRuntimeDirs,
  getConfigWarnings,
  parseInteger,
  parseBoolean,
  parseList,
};
