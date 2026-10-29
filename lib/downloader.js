'use strict';

const fs = require('fs');
const path = require('path');
const tmp = require('tmp-promise');

const { appError } = require('./errors');
const { classifyYtDlpFailure } = require('./classify');
const { runProcess, sleep } = require('./process');
const { resolveSafeUrl } = require('./url-policy');
const {
  buildMetadataArgs,
  buildDownloadArgs,
  normalizeQuality,
  getTargetResolution,
  platformFromExtractor,
} = require('./platforms');
const {
  allowedExtensionsFor,
  probeMedia,
  extractMediaInfo,
  validateMedia,
  normalizeMedia,
  mimeTypeFor,
  safeFilename,
} = require('./media');
const { ensureRuntimeDirs, getConfigWarnings } = require('./config');

tmp.setGracefulCleanup();

class Semaphore {
  constructor(max) {
    this.max = Math.max(1, Number(max) || 1);
    this.active = 0;
    this.waiters = [];
  }

  async acquire(timeoutMs = 30000, signal) {
    if (signal && signal.aborted) {
      throw signal.reason instanceof Error ? signal.reason : appError(499, 'ABORTED', 'Download cancelado.');
    }

    if (this.active < this.max) {
      this.active++;
      return this._releaseFactory();
    }

    if (timeoutMs === 0) {
      throw appError(503, 'SERVER_BUSY', 'O servidor está ocupado. Tente novamente em instantes.', { retryAfter: 15 });
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const waiter = {
        resolve: (value) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(value);
        },
        reject: (error) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        },
      };

      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        waiter.reject(appError(503, 'SERVER_BUSY', 'O servidor está ocupado. Tente novamente em instantes.', { retryAfter: 15 }));
      }, timeoutMs);

      const onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        waiter.reject(signal.reason instanceof Error ? signal.reason : appError(499, 'ABORTED', 'Download cancelado.'));
      };

      const cleanup = () => {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
      };

      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  _releaseFactory() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
      const next = this.waiters.shift();
      if (next) {
        this.active++;
        next.resolve(this._releaseFactory());
      }
    };
  }
}

function parseMetadataOutput(stdout) {
  const text = String(stdout || '').trim();
  if (!text) throw new Error('empty output');

  try {
    return JSON.parse(text);
  } catch (error) {
    // Alguns extratores emitem linhas de log antes do JSON; procura a última
    // linha que começa com "{".
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index--) {
      if (!lines[index].startsWith('{')) continue;
      try {
        return JSON.parse(lines[index]);
      } catch (_) {
        // Continua tentando.
      }
    }
    throw error;
  }
}

function estimateSize(metadata, quality) {
  const formats = Array.isArray(metadata.formats) ? metadata.formats : [];
  const requested = Array.isArray(metadata.requested_formats) ? metadata.requested_formats : [];

  if (requested.length) {
    const total = requested.reduce((sum, format) => sum + (Number(format.filesize || format.filesize_approx) || 0), 0);
    if (total > 0) return total;
  }

  const direct = Number(metadata.filesize || metadata.filesize_approx);
  if (direct > 0) return direct;

  const candidates = formats.filter((format) => {
    if (quality === 'audio') return format.acodec && format.acodec !== 'none';
    return format.vcodec && format.vcodec !== 'none';
  });

  const sizes = candidates
    .map((format) => Number(format.filesize || format.filesize_approx) || 0)
    .filter((size) => size > 0);

  return sizes.length ? Math.max(...sizes) : 0;
}

function validateMetadata(metadata, { quality, config }) {
  if (!metadata || typeof metadata !== 'object') {
    throw appError(502, 'UPSTREAM_PARSE', 'A plataforma retornou metadados inválidos.');
  }

  if (metadata.is_live === true || ['is_live', 'is_upcoming'].includes(metadata.live_status)) {
    throw appError(422, 'LIVE_NOT_SUPPORTED', 'Transmissões ao vivo e estreias não são suportadas.');
  }

  if (metadata.has_drm === true) {
    throw appError(422, 'DRM_PROTECTED', 'Conteúdo protegido por DRM não pode ser baixado.');
  }

  const duration = Number(metadata.duration);
  if (Number.isFinite(duration) && duration > config.maxVideoDuration) {
    throw appError(400, 'VIDEO_TOO_LONG', `Vídeo muito longo. Limite máximo: ${Math.floor(config.maxVideoDuration / 60)} minutos.`);
  }

  if (quality !== 'audio') {
    const requested = Array.isArray(metadata.requested_formats) ? metadata.requested_formats : [];
    const formats = Array.isArray(metadata.formats) ? metadata.formats : [];
    const candidates = requested.length ? requested : formats;
    const videoExtensions = new Set(['mp4', 'webm', 'mkv', 'mov', 'm4v']);
    const explicitVideo = candidates.some((format) => format.vcodec && format.vcodec !== 'none') ||
      (metadata.vcodec && metadata.vcodec !== 'none');
    const unknownCodecButVideoExt = candidates.some((format) => (
      (!format.vcodec || format.vcodec === 'none') && videoExtensions.has(String(format.ext || '').toLowerCase())
    )) || videoExtensions.has(String(metadata.ext || '').toLowerCase());
    const explicitNonVideo = candidates.length > 0 && candidates.every((format) => (
      format.vcodec === 'none' && !videoExtensions.has(String(format.ext || '').toLowerCase())
    ));

    // Alguns extratores (Facebook, por exemplo) não informam vcodec/acodec no
    // JSON, embora entreguem MP4. Nesses casos deixamos o ffprobe validar depois
    // do download; só rejeitamos quando o metadado é explicitamente de imagem.
    const hasVideo = explicitVideo || (unknownCodecButVideoExt && !explicitNonVideo);

    if (!hasVideo) {
      throw appError(422, 'NO_VIDEO', 'O conteúdo não contém vídeo. Envie um link de vídeo/Reel/Short.');
    }
  }

  const estimatedSize = estimateSize(metadata, quality);
  if (estimatedSize > config.maxFileSize) {
    throw appError(413, 'FILE_TOO_LARGE', `Arquivo muito grande para download. Limite máximo: ${Math.round(config.maxFileSize / (1024 * 1024))}MB.`);
  }
}

function findOutputFile(tmpDir, quality) {
  const allowed = allowedExtensionsFor(quality);
  const entries = fs.readdirSync(tmpDir)
    .map((name) => {
      const filePath = path.join(tmpDir, name);
      let stat;
      try {
        stat = fs.statSync(filePath);
      } catch (error) {
        return null;
      }
      return { name, filePath, stat };
    })
    .filter(Boolean)
    .filter((entry) => entry.stat.isFile() && entry.stat.size > 0)
    .filter((entry) => !/\.(part|ytdl|temp|tmp)$/i.test(entry.name))
    .filter((entry) => allowed.has(path.extname(entry.name).toLowerCase()))
    .sort((a, b) => b.stat.size - a.stat.size);

  if (!entries.length) {
    throw appError(502, 'NO_OUTPUT', 'O yt-dlp não produziu um arquivo de mídia válido.');
  }

  return entries[0];
}

function createDownloader(config, dependencies = {}) {
  ensureRuntimeDirs(config);
  const logger = dependencies.logger || console;
  const processRunner = dependencies.runProcess || runProcess;
  const resolver = dependencies.resolver;
  const fetchImpl = dependencies.fetchImpl;
  const processEnv = dependencies.env;
  const semaphore = dependencies.semaphore || new Semaphore(config.maxConcurrentDownloads);

  let healthCache = null;
  let healthCheckedAt = 0;

  const configWarnings = getConfigWarnings(config);
  for (const warning of configWarnings) logger.warn?.(`[config] ${warning}`);

  async function executeYtDlp(args, { signal, label, requestId }) {
    const result = await processRunner(config.ytdlpPath, args, {
      timeoutMs: config.ytdlpTimeout,
      maxBuffer: 16 * 1024 * 1024,
      signal,
      env: processEnv,
    });

    if (result.code !== 0) {
      const classified = classifyYtDlpFailure(result.stderr, {
        platform: label?.platform,
        hasCookies: Boolean(config.cookiesFile),
      });
      classified.details = classified.details || result.stderr;
      throw classified;
    }

    return result;
  }

  async function getMetadata(url, platform, quality, signal, requestId) {
    let attempt = 0;
    let backoff = config.ytdlpInitialBackoff;
    let lastError;

    while (attempt < config.ytdlpMaxAttempts) {
      attempt++;
      try {
        const args = buildMetadataArgs(url, platform, quality, config);
        const result = await executeYtDlp(args, { signal, label: { platform }, requestId });
        return parseMetadataOutput(result.stdout);
      } catch (error) {
        lastError = error;
        if (error.code === 'ABORTED' || error.statusCode === 499) throw error;
        if (!error.retryable || attempt >= config.ytdlpMaxAttempts) throw error;
        logger.warn?.(`[download${requestId ? ` ${requestId}` : ''}] metadata ${platform.id} tentativa ${attempt}/${config.ytdlpMaxAttempts}: ${error.code}`);
        await sleep(backoff, signal);
        backoff *= 2;
      }
    }

    throw lastError || appError(502, 'UPSTREAM_ERROR', 'Não foi possível obter os metadados do vídeo.');
  }

  async function downloadToTemp(url, platform, quality, signal, requestId) {
    let attempt = 0;
    let backoff = config.ytdlpInitialBackoff;
    let lastError;

    while (attempt < config.ytdlpMaxAttempts) {
      attempt++;
      let temp;
      try {
        temp = await tmp.dir({
          unsafeCleanup: true,
          dir: config.tmpDir || undefined,
          mode: 0o700,
        });
      } catch (error) {
        throw appError(507, 'TMP_UNAVAILABLE', 'Não foi possível criar o diretório temporário.');
      }

      const cleanup = async () => {
        try {
          await temp.cleanup();
        } catch (error) {
          // O diretório pode já ter sido removido pelo graceful cleanup.
        }
      };

      try {
        const outputTemplate = path.join(temp.path, '%(id)s.%(ext)s');
        const args = buildDownloadArgs(url, platform, quality, config, outputTemplate);
        await executeYtDlp(args, { signal, label: { platform }, requestId });

        const output = findOutputFile(temp.path, quality);
        const probe = await probeMedia(output.filePath, config, signal);
        const info = extractMediaInfo(probe, output.filePath);
        validateMedia(info, {
          quality,
          maxVideoDuration: config.maxVideoDuration,
          maxFileSize: config.maxFileSize,
        });

        return {
          filePath: output.filePath,
          info,
          cleanup,
          tmpDir: temp.path,
        };
      } catch (error) {
        await cleanup();
        lastError = error;
        if (error.code === 'ABORTED' || error.statusCode === 499) throw error;
        if (!error.retryable || attempt >= config.ytdlpMaxAttempts) throw error;
        logger.warn?.(`[download${requestId ? ` ${requestId}` : ''}] ${platform.id} tentativa ${attempt}/${config.ytdlpMaxAttempts}: ${error.code}`);
        await sleep(backoff, signal);
        backoff *= 2;
      }
    }

    throw lastError || appError(502, 'UPSTREAM_ERROR', 'Não foi possível baixar o vídeo.');
  }

  async function prepare(rawUrl, qualityInput, options = {}) {
    const quality = normalizeQuality(qualityInput);
    const requestId = options.requestId;
    const externalSignal = options.signal;

    const resolved = await resolveSafeUrl(rawUrl, {
      config,
      resolver,
      fetchImpl,
      signal: externalSignal,
    });

    let metadataPlatform = resolved.platform;
    const release = await semaphore.acquire(config.queueTimeout, externalSignal);

    const jobController = new AbortController();
    let jobTimedOut = false;
    const jobTimer = setTimeout(() => {
      jobTimedOut = true;
      jobController.abort(appError(504, 'TIMEOUT', 'O processamento demorou demais. Tente novamente.'));
    }, config.jobTimeout);
    if (jobTimer.unref) jobTimer.unref();

    const onExternalAbort = () => {
      jobController.abort(
        externalSignal.reason instanceof Error
          ? externalSignal.reason
          : appError(499, 'ABORTED', 'Download cancelado.')
      );
    };
    if (externalSignal) {
      if (externalSignal.aborted) onExternalAbort();
      else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }

    let downloaded;
    try {
      const metadata = await getMetadata(resolved.url, metadataPlatform, quality, jobController.signal, requestId);
      const detected = platformFromExtractor(metadata.extractor_key || metadata.extractor);
      if (detected && detected.supported) metadataPlatform = detected;

      validateMetadata(metadata, { quality, config });

      downloaded = await downloadToTemp(resolved.url, metadataPlatform, quality, jobController.signal, requestId);

      const normalizedPath = await normalizeMedia(
        downloaded.filePath,
        downloaded.info,
        quality,
        config,
        jobController.signal
      );

      let info = downloaded.info;
      if (normalizedPath !== downloaded.filePath) {
        const probe = await probeMedia(normalizedPath, config, jobController.signal);
        info = extractMediaInfo(probe, normalizedPath);
        validateMedia(info, {
          quality,
          maxVideoDuration: config.maxVideoDuration,
          maxFileSize: config.maxFileSize,
        });
      }

      const ext = path.extname(normalizedPath).toLowerCase();
      const title = metadata.title || metadata.fulltitle || metadata.id || 'video';
      const filename = safeFilename(title, ext);
      const size = fs.statSync(normalizedPath).size;

      if (size > config.maxFileSize) {
        throw appError(413, 'FILE_TOO_LARGE', `Arquivo muito grande para download. Limite máximo: ${Math.round(config.maxFileSize / (1024 * 1024))}MB.`);
      }

      return {
        url: resolved.url.toString(),
        platform: metadataPlatform,
        metadata,
        filePath: normalizedPath,
        cleanup: downloaded.cleanup,
        size,
        filename,
        contentType: mimeTypeFor(info, quality),
        info,
        targetResolution: getTargetResolution(quality),
      };
    } catch (error) {
      if (downloaded) {
        try { await downloaded.cleanup(); } catch (_) {}
      }
      if (jobTimedOut) {
        throw appError(504, 'TIMEOUT', 'O processamento demorou demais. Tente novamente.');
      }
      throw error;
    } finally {
      clearTimeout(jobTimer);
      if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
      release();
    }
  }

  async function checkHealth() {
    const now = Date.now();
    if (healthCache && now - healthCheckedAt < 60000) return healthCache;

    const checks = {
      ytdlp: false,
      ffmpeg: false,
      ffprobe: false,
      tmp: true,
      cookies: config.cookiesFile ? 'unknown' : 'not_configured',
    };

    async function versionCheck(command, args) {
      try {
        const result = await processRunner(command, args, { timeoutMs: 10000, maxBuffer: 1024 * 1024, env: processEnv });
        return result.code === 0;
      } catch (error) {
        return false;
      }
    }

    checks.ytdlp = await versionCheck(config.ytdlpPath, ['--version']);
    checks.ffmpeg = await versionCheck(config.ffmpegPath, ['-version']);
    checks.ffprobe = await versionCheck(config.ffprobePath, ['-version']);

    if (config.tmpDir) {
      try {
        ensureRuntimeDirs(config);
        fs.accessSync(config.tmpDir, fs.constants.W_OK);
      } catch (error) {
        checks.tmp = false;
      }
    }

    if (config.cookiesFile) {
      try {
        fs.accessSync(config.cookiesFile, fs.constants.R_OK);
        checks.cookies = 'ok';
      } catch (error) {
        checks.cookies = 'missing';
      }
    }

    const ok = checks.ytdlp && checks.ffmpeg && checks.ffprobe && checks.tmp && checks.cookies !== 'missing';
    healthCache = { ok, checks };
    healthCheckedAt = now;
    return healthCache;
  }

  return {
    config,
    prepare,
    checkHealth,
    semaphore,
    _internal: {
      getMetadata,
      validateMetadata,
      downloadToTemp,
      estimateSize,
    },
  };
}

module.exports = {
  Semaphore,
  createDownloader,
  parseMetadataOutput,
  estimateSize,
  validateMetadata,
  findOutputFile,
};
