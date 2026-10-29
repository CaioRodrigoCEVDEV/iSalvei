#!/usr/bin/env node
'use strict';

/**
 * Verifica, usando a mesma configuração do backend (dotenv + PATH do processo),
 * se o yt-dlp, o FFmpeg e o ffprobe estão disponíveis e se o yt-dlp é
 * exatamente a versão esperada. Não imprime variáveis de ambiente nem
 * segredos.
 *
 * Uso:
 *   node scripts/runtime-check.js [--expect-ytdlp YYYY.MM.DD]
 *
 * Saída: JSON em stdout. Código de saída != 0 em caso de falha.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

try {
  // Carrega o .env do projeto sem sobrescrever variáveis já presentes no
  // ambiente do serviço (mesmo comportamento do dotenv no server.js).
  const dotenv = require('dotenv');
  const appDir = process.env.APP_DIR || path.resolve(__dirname, '..');
  dotenv.config({ path: path.resolve(appDir, '.env') });
} catch (_) {
  // dotenv é opcional para este verificador.
}

function resolveExecutable(command, searchPath) {
  if (!command) return null;
  if (command.includes(path.sep) || command.includes('/')) {
    const candidate = path.isAbsolute(command)
      ? command
      : path.resolve(process.cwd(), command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.realpathSync(candidate);
    } catch (_) {
      return candidate;
    }
  }
  const dirs = String(searchPath || '').split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = path.join(dir, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.realpathSync(candidate);
    } catch (_) {
      /* tenta o próximo diretório */
    }
  }
  return null;
}

function runVersion(exe, args) {
  const result = spawnSync(exe, args, {
    encoding: 'utf8',
    timeout: 20000,
    maxBuffer: 4 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) {
    return { ok: false, error: result.error.message };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      error: `exit ${result.status}: ${String(result.stderr || '').slice(0, 300).trim()}`,
    };
  }
  return { ok: true, stdout: String(result.stdout || '') };
}

function normalizeVersion(value) {
  return String(value)
    .trim()
    .replace(/^v/i, '')
    .split('.')
    .map((part) => String(Number(part)))
    .join('.');
}

function parseExpectedVersion(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--expect-ytdlp') {
      return argv[i + 1] || null;
    }
    if (argv[i].startsWith('--expect-ytdlp=')) {
      return argv[i].slice('--expect-ytdlp='.length) || null;
    }
  }
  return null;
}

function fail(message, details) {
  const payload = { ok: false, error: message, details: details || undefined };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  process.stderr.write(`[runtime-check] ${message}\n`);
  process.exit(1);
}

const expected = parseExpectedVersion(process.argv.slice(2));
const searchPath = process.env.PATH || '';
const ytdlpConfigured = process.env.YTDLP_PATH || 'yt-dlp';
const ffmpegConfigured = process.env.FFMPEG_PATH || 'ffmpeg';
const ffprobeConfigured = process.env.FFPROBE_PATH || 'ffprobe';

const ytdlpResolved = resolveExecutable(ytdlpConfigured, searchPath);
if (!ytdlpResolved) {
  fail('yt-dlp não encontrado', { configured: ytdlpConfigured, path: searchPath });
}

const ytdlpRun = runVersion(ytdlpResolved, ['--version']);
if (!ytdlpRun.ok) {
  fail('yt-dlp não executou corretamente', { resolved: ytdlpResolved, error: ytdlpRun.error });
}
const ytdlpVersion = String(ytdlpRun.stdout).split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0] || '';
if (!ytdlpVersion) {
  fail('yt-dlp não retornou versão', { resolved: ytdlpResolved });
}
if (expected && normalizeVersion(ytdlpVersion) !== normalizeVersion(expected)) {
  fail('Versão do yt-dlp difere da esperada', {
    expected,
    actual: ytdlpVersion,
    resolved: ytdlpResolved,
  });
}

const ffmpegResolved = resolveExecutable(ffmpegConfigured, searchPath);
if (!ffmpegResolved) {
  fail('FFmpeg não encontrado', { configured: ffmpegConfigured, path: searchPath });
}

const ffmpegRun = runVersion(ffmpegResolved, ['-version']);
if (!ffmpegRun.ok) {
  fail('FFmpeg não executou corretamente', { resolved: ffmpegResolved, error: ffmpegRun.error });
}
const ffmpegVersion = String(ffmpegRun.stdout).split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0] || '';
if (!ffmpegVersion) {
  fail('FFmpeg não retornou versão', { resolved: ffmpegResolved });
}

const ffprobeResolved = resolveExecutable(ffprobeConfigured, searchPath);
if (!ffprobeResolved) {
  fail('ffprobe não encontrado', { configured: ffprobeConfigured, path: searchPath });
}

const ffprobeRun = runVersion(ffprobeResolved, ['-version']);
if (!ffprobeRun.ok) {
  fail('ffprobe não executou corretamente', { resolved: ffprobeResolved, error: ffprobeRun.error });
}
const ffprobeVersion = String(ffprobeRun.stdout).split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0] || '';
if (!ffprobeVersion) {
  fail('ffprobe não retornou versão', { resolved: ffprobeResolved });
}

process.stdout.write(
  `${JSON.stringify({
    ok: true,
    node: process.version,
    cwd: process.cwd(),
    ytdlp: {
      configured: ytdlpConfigured,
      resolved: ytdlpResolved,
      version: ytdlpVersion,
    },
    ffmpeg: {
      configured: ffmpegConfigured,
      resolved: ffmpegResolved,
      version: ffmpegVersion,
    },
    ffprobe: {
      configured: ffprobeConfigured,
      resolved: ffprobeResolved,
      version: ffprobeVersion,
    },
  })}\n`,
);
