'use strict';

const { spawn } = require('child_process');
const { appError } = require('./errors');

/**
 * Executa um processo sem shell, com timeout, abort e limite de buffer.
 * Em Linux, o processo é criado em um grupo próprio para que ffmpeg/net-download
 * filhos também sejam encerrados no timeout.
 */
function runProcess(command, args, options = {}) {
  const {
    timeoutMs = 120000,
    maxBuffer = 16 * 1024 * 1024,
    signal,
    cwd,
    env,
  } = options;

  return new Promise((resolve, reject) => {
    let child;
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let timer = null;

    const cleanupListeners = () => {
      if (!signal) return;
      try {
        signal.removeEventListener('abort', onAbort);
      } catch (error) {
        // Ignora.
      }
    };

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      cleanupListeners();
      if (error) reject(error);
      else resolve(result);
    };

    const killTree = () => {
      if (!child || !child.pid) return;
      try {
        if (process.platform === 'win32') {
          child.kill('SIGKILL');
        } else {
          process.kill(-child.pid, 'SIGKILL');
        }
      } catch (error) {
        try { child.kill('SIGKILL'); } catch (_) {}
      }
    };

    const onAbort = () => {
      if (settled) return;
      aborted = true;
      killTree();
    };

    try {
      child = spawn(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        cwd,
        env: env || process.env,
      });
    } catch (error) {
      finish(appError(503, 'DEPENDENCY_START_FAILED', 'Não foi possível iniciar o processador de vídeo.', {
        details: `${command}: ${error.message}`,
      }));
      return;
    }

    child.stdout.on('data', (chunk) => {
      if (stdout.length < maxBuffer) stdout += chunk.toString();
      if (stdout.length >= maxBuffer) {
        killTree();
        finish(appError(502, 'UPSTREAM_OUTPUT_TOO_LARGE', 'Resposta do processador de vídeo muito grande.'));
      }
    });

    child.stderr.on('data', (chunk) => {
      if (stderr.length < maxBuffer) stderr += chunk.toString();
    });

    child.on('error', (error) => {
      const missing = error && error.code === 'ENOENT';
      finish(appError(
        503,
        missing ? 'DEPENDENCY_MISSING' : 'DEPENDENCY_START_FAILED',
        missing
          ? 'Dependência de vídeo não encontrada no servidor. Verifique yt-dlp/ffmpeg.'
          : 'Não foi possível iniciar o processador de vídeo.',
        { details: `${command}: ${error.message}` }
      ));
    });

    child.on('close', (code, childSignal) => {
      if (aborted) {
        const reason = signal && signal.reason instanceof Error
          ? signal.reason
          : appError(499, 'ABORTED', 'Download cancelado.');
        finish(reason);
        return;
      }
      if (timedOut) {
        finish(appError(504, 'TIMEOUT', 'O processamento demorou demais. Tente novamente.', { details: `${command} timeout after ${timeoutMs}ms` }));
        return;
      }
      finish(null, { code, signal: childSignal, stdout, stderr });
    });

    timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      killTree();
    }, timeoutMs);
    if (timer.unref) timer.unref();

    if (signal) {
      if (signal.aborted) {
        aborted = true;
        killTree();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }
  });
}

function sleep(ms, signal) {
  if (!ms || ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(appError(499, 'ABORTED', 'Download cancelado.'));
      return;
    }
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      reject(signal && signal.reason instanceof Error
        ? signal.reason
        : appError(499, 'ABORTED', 'Download cancelado.'));
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

module.exports = { runProcess, sleep };
