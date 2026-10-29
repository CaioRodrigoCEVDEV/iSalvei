'use strict';

const crypto = require('crypto');
const fs = require('fs');

const { appError } = require('./errors');
const { normalizeInstagramCookies } = require('./instagram-session');

const VIEWPORT = Object.freeze({ width: 430, height: 860 });
const LOGIN_URL = 'https://www.instagram.com/accounts/login/';
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const FRAME_INTERVAL_MS = 400;
const COOKIE_INTERVAL_MS = 1200;
const CLAIM_TIMEOUT_MS = 60 * 1000;

const ALLOWED_KEYS = new Set([
  'Enter', 'Backspace', 'Tab', 'Escape', 'Delete',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Home', 'End', 'PageUp', 'PageDown', ' ',
]);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function exists(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch (error) {
    return false;
  }
}

function findBrowserPath(explicit) {
  // Um caminho configurado explicitamente não cai em auto-detecção: erro de
  // configuração deve aparecer no health/log em vez de usar outro binário.
  const configured = String(explicit || process.env.IG_BROWSER_PATH || '').trim();
  if (configured) return exists(configured) ? configured : null;

  const candidates = [
    process.env.CHROME_PATH,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/opt/google/chrome/chrome',
  ].filter(Boolean);

  return candidates.find(exists) || null;
}

function browserUnavailable(message) {
  return appError(
    503,
    'BROWSER_UNAVAILABLE',
    message || 'O login assistido está indisponível neste servidor. Use a opção de colar cookies manualmente.'
  );
}

/**
 * Mantém um Chromium headless por vez e transmite a tela real do Instagram.
 * A senha nunca é lida pelo backend: o usuário digita na página oficial e só
 * os cookies resultantes são capturados. Tudo é descartado ao final.
 */
function createLoginManager(options = {}) {
  const config = options.config || {};
  const logger = options.logger || console;
  const ttlMs = Math.max(60 * 1000, Number(config.instagramLoginTtl) || 5 * 60 * 1000);
  const maxSessions = Math.max(1, Number(config.instagramLoginMaxSessions) || 2);
  const navigationTimeout = Math.max(10000, Number(config.instagramLoginNavigationTimeout) || 45000);
  const browserPath = findBrowserPath(config.instagramBrowserPath);
  const normalizeCookies = options.normalizeCookies || normalizeInstagramCookies;
  const launchBrowser = typeof options.launchBrowser === 'function' ? options.launchBrowser : null;

  if (config.instagramLoginEnabled !== false && !browserPath && !launchBrowser) {
    logger.warn?.('[instagram-login] Chromium não encontrado; o login assistido ficará indisponível. Configure IG_BROWSER_PATH.');
  }

  const sessions = new Map();
  let browserPromise = null;
  let browser = null;
  let idleTimer = null;
  let closing = false;

  function broadcast(session, payload) {
    const line = `data: ${JSON.stringify(payload)}\n\n`;
    for (const res of session.subscribers) {
      try {
        res.write(line);
      } catch (error) {
        session.subscribers.delete(res);
      }
    }
  }

  function activeLoginCount() {
    let count = 0;
    for (const session of sessions.values()) {
      if (session.status === 'starting' || session.status === 'login') count++;
    }
    return count;
  }

  async function getBrowser() {
    if (closing) throw browserUnavailable('O servidor está sendo encerrado.');
    if (!launchBrowser && !browserPath) throw browserUnavailable('Chromium não está instalado no servidor. Configure IG_BROWSER_PATH.');
    if (browser && browser.isConnected()) return browser;
    if (browserPromise) return browserPromise;

    browserPromise = (async () => {
      let launched;
      if (launchBrowser) {
        launched = await launchBrowser();
      } else {
        let chromium;
        try {
          ({ chromium } = require('playwright-core'));
        } catch (error) {
          throw browserUnavailable('A dependência playwright-core não está instalada.');
        }

        launched = await chromium.launch({
          executablePath: browserPath,
          headless: true,
          timeout: 30000,
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-blink-features=AutomationControlled',
          ],
        });
      }
      browser = launched;
      launched.on?.('disconnected', () => {
        browser = null;
        browserPromise = null;
      });
      return launched;
    })().catch((error) => {
      browserPromise = null;
      browser = null;
      logger.error?.(`[instagram-login] falha ao iniciar Chromium: ${error.message}`);
      throw browserUnavailable();
    });

    return browserPromise;
  }

  function scheduleBrowserShutdown() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(async () => {
      idleTimer = null;
      if (sessions.size > 0 || !browser) return;
      const instance = browser;
      browser = null;
      browserPromise = null;
      try { await instance.close(); } catch (error) {}
    }, 30000);
    idleTimer.unref?.();
  }

  function stopLoops(session) {
    session.running = false;
    if (session.frameTimer) clearInterval(session.frameTimer);
    if (session.cookieTimer) clearInterval(session.cookieTimer);
    if (session.heartbeatTimer) clearInterval(session.heartbeatTimer);
    session.frameTimer = null;
    session.cookieTimer = null;
    session.heartbeatTimer = null;
  }

  async function closeSession(session, reason) {
    if (!session || session.closed) return;
    session.closed = true;
    session.status = 'closed';
    stopLoops(session);
    if (session.expiresTimer) clearTimeout(session.expiresTimer);
    if (session.claimTimer) clearTimeout(session.claimTimer);
    session.expiresTimer = null;
    session.claimTimer = null;

    broadcast(session, { type: 'closed', reason: reason || 'closed' });
    for (const res of session.subscribers) {
      try { res.end(); } catch (error) {}
    }
    session.subscribers.clear();

    try { await session.context?.close(); } catch (error) {}
    sessions.delete(session.id);
    scheduleBrowserShutdown();
  }

  async function captureCookies(session) {
    try {
      const cookies = await session.context.cookies('https://www.instagram.com');
      const sessionCookie = cookies.find((cookie) => cookie.name === 'sessionid' && cookie.value);
      const userIdCookie = cookies.find((cookie) => cookie.name === 'ds_user_id' && cookie.value);
      // Exige também ds_user_id: em etapas intermediárias (2FA/checkpoint) o
      // Instagram pode criar um sessionid temporário que não serve para baixar.
      if (!sessionCookie || !userIdCookie) return false;

      const header = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
      const normalized = normalizeCookies(header);

      session.cookieText = normalized.text;
      session.status = 'connected';
      session.running = false;
      stopLoops(session);
      broadcast(session, { type: 'connected' });

      // Libera o Chromium imediatamente; a sessão fica apenas em memória até
      // o frontend reivindicar os cookies.
      try { await session.context.close(); } catch (error) {}
      session.claimTimer = setTimeout(() => closeSession(session, 'claim-timeout'), CLAIM_TIMEOUT_MS);
      session.claimTimer.unref?.();
      return true;
    } catch (error) {
      return false;
    }
  }

  function startLoops(session) {
    session.running = true;

    session.frameTimer = setInterval(async () => {
      if (!session.running || session.frameBusy) return;
      session.frameBusy = true;
      try {
        const buffer = await session.page.screenshot({ type: 'jpeg', quality: 55, timeout: 5000 });
        const hash = crypto.createHash('sha1').update(buffer).digest('hex');
        if (hash === session.frameHash) return;
        session.frameHash = hash;
        session.frame = buffer.toString('base64');
        broadcast(session, {
          type: 'frame',
          image: session.frame,
          width: VIEWPORT.width,
          height: VIEWPORT.height,
        });
      } catch (error) {
        // Página fechando/navegando: o próximo ciclo tenta novamente.
      } finally {
        session.frameBusy = false;
      }
    }, FRAME_INTERVAL_MS);

    session.cookieTimer = setInterval(async () => {
      if (!session.running || session.cookieBusy) return;
      session.cookieBusy = true;
      try {
        await captureCookies(session);
      } finally {
        session.cookieBusy = false;
      }
    }, COOKIE_INTERVAL_MS);

    session.heartbeatTimer = setInterval(() => {
      for (const res of session.subscribers) {
        try { res.write(': ping\n\n'); } catch (error) { session.subscribers.delete(res); }
      }
    }, 15000);

    session.frameTimer.unref?.();
    session.cookieTimer.unref?.();
    session.heartbeatTimer.unref?.();
  }

  async function start({ ip } = {}) {
    if (config.instagramLoginEnabled === false) {
      throw browserUnavailable('O login assistido está desativado neste servidor. Use a opção de colar cookies manualmente.');
    }
    if (activeLoginCount() >= maxSessions) {
      throw appError(503, 'LOGIN_BUSY', 'Muitas conexões de login em andamento. Aguarde um minuto.', {
        retryAfter: 15,
      });
    }

    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }

    const instance = await getBrowser();
    const id = crypto.randomBytes(24).toString('hex');
    let context;
    let page;

    try {
      context = await instance.newContext({
        viewport: VIEWPORT,
        locale: 'pt-BR',
        timezoneId: 'America/Sao_Paulo',
        userAgent: USER_AGENT,
      });
      await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      });
      page = await context.newPage();
      page.setDefaultTimeout(15000);

      const session = {
        id,
        ip: ip || '',
        context,
        page,
        status: 'starting',
        createdAt: Date.now(),
        expiresAt: Date.now() + ttlMs,
        subscribers: new Set(),
        frame: null,
        frameHash: null,
        cookieText: null,
        running: false,
        closed: false,
        frameBusy: false,
        cookieBusy: false,
        frameTimer: null,
        cookieTimer: null,
        heartbeatTimer: null,
        expiresTimer: null,
        claimTimer: null,
      };

      sessions.set(id, session);
      session.expiresTimer = setTimeout(() => closeSession(session, 'expired'), ttlMs);
      session.expiresTimer.unref?.();

      // "Entrar com o Facebook" e desafios podem abrir popups; a transmissão
      // passa a acompanhar a página mais recente.
      context.on?.('page', (popup) => {
        if (popup === page) return;
        session.page = popup;
        try { popup.setDefaultTimeout(15000); } catch (error) {}
        popup.on('close', () => {
          if (session.page === popup) session.page = page;
        });
      });

      await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: navigationTimeout });

      session.status = 'login';
      startLoops(session);

      return {
        id,
        expiresAt: session.expiresAt,
        width: VIEWPORT.width,
        height: VIEWPORT.height,
      };
    } catch (error) {
      const session = sessions.get(id);
      if (session) await closeSession(session, 'error');
      else {
        try { await context?.close(); } catch (cleanupError) {}
      }
      logger.error?.(`[instagram-login] falha ao abrir login: ${error.message}`);
      throw appError(503, 'BROWSER_ERROR', 'Não foi possível abrir a página de login do Instagram. Tente novamente.');
    }
  }

  function requireSession(id, ip) {
    const session = sessions.get(id);
    if (!session || session.closed) {
      throw appError(404, 'LOGIN_SESSION_NOT_FOUND', 'Sessão de login expirada. Abra novamente.');
    }
    if (session.ip && ip && session.ip !== ip) {
      throw appError(403, 'LOGIN_SESSION_FORBIDDEN', 'Sessão de login não pertence a esta conexão.');
    }
    return session;
  }

  async function input(id, event = {}, ip) {
    const session = requireSession(id, ip);
    if (session.status !== 'login') {
      throw appError(409, 'LOGIN_NOT_READY', 'A tela de login ainda não está pronta.');
    }

    const now = Date.now();
    session.inputWindow = (session.inputWindow || []).filter((timestamp) => now - timestamp < 1000);
    if (session.inputWindow.length >= 30) {
      throw appError(429, 'LOGIN_INPUT_RATE_LIMITED', 'Muitas ações. Aguarde um instante.');
    }
    session.inputWindow.push(now);

    try {
      if (event.type === 'click') {
        const x = Number(event.x);
        const y = Number(event.y);
        if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > VIEWPORT.width || y > VIEWPORT.height) {
          throw appError(400, 'INVALID_INPUT', 'Coordenada inválida.');
        }
        await session.page.mouse.click(x, y);
      } else if (event.type === 'type') {
        const text = String(event.text || '');
        if (!text) return { ok: true };
        if (text.length > 256) throw appError(400, 'INVALID_INPUT', 'Texto muito longo.');
        await session.page.keyboard.type(text, { delay: 25 });
      } else if (event.type === 'key') {
        const key = String(event.key || '');
        if (!ALLOWED_KEYS.has(key)) throw appError(400, 'INVALID_INPUT', 'Tecla não permitida.');
        await session.page.keyboard.press(key === ' ' ? 'Space' : key);
      } else if (event.type === 'scroll') {
        const x = Math.min(VIEWPORT.width - 1, Math.max(0, Number(event.x) || VIEWPORT.width / 2));
        const y = Math.min(VIEWPORT.height - 1, Math.max(0, Number(event.y) || VIEWPORT.height / 2));
        const deltaY = Math.min(3000, Math.max(-3000, Number(event.deltaY) || 0));
        await session.page.mouse.move(x, y);
        await session.page.mouse.wheel(0, deltaY);
      } else {
        throw appError(400, 'INVALID_INPUT', 'Evento inválido.');
      }
      return { ok: true };
    } catch (error) {
      if (error.statusCode) throw error;
      logger.warn?.(`[instagram-login] falha ao encaminhar evento: ${error.message}`);
      throw appError(409, 'LOGIN_PAGE_UNAVAILABLE', 'A página de login não está mais disponível.');
    }
  }

  function subscribe(id, ip, res) {
    const session = requireSession(id, ip);

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-store');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    try { res.socket?.setNoDelay(true); } catch (error) {}

    res.write('retry: 2000\n\n');
    session.subscribers.add(res);

    if (session.frame) {
      res.write(`data: ${JSON.stringify({
        type: 'frame',
        image: session.frame,
        width: VIEWPORT.width,
        height: VIEWPORT.height,
      })}\n\n`);
    }
    if (session.status === 'connected') {
      res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
    } else {
      res.write(`data: ${JSON.stringify({ type: 'ready' })}\n\n`);
    }

    res.on('close', () => {
      session.subscribers.delete(res);
    });

    return () => {
      session.subscribers.delete(res);
    };
  }

  function claim(id, ip) {
    const session = requireSession(id, ip);
    if (session.status !== 'connected' || !session.cookieText) {
      throw appError(409, 'LOGIN_PENDING', 'O login ainda não foi concluído.');
    }
    const cookieText = session.cookieText;
    closeSession(session, 'claimed');
    return cookieText;
  }

  function cancel(id, ip) {
    const session = sessions.get(id);
    if (!session) return false;
    if (session.ip && ip && session.ip !== ip) {
      throw appError(403, 'LOGIN_SESSION_FORBIDDEN', 'Sessão de login não pertence a esta conexão.');
    }
    closeSession(session, 'cancelled');
    return true;
  }

  async function close() {
    closing = true;
    if (idleTimer) clearTimeout(idleTimer);
    const pending = Array.from(sessions.values());
    await Promise.all(pending.map((session) => closeSession(session, 'shutdown')));
    const instance = browser;
    browser = null;
    browserPromise = null;
    if (instance) {
      try { await instance.close(); } catch (error) {}
    }
  }

  return {
    start,
    subscribe,
    input,
    claim,
    cancel,
    close,
    get browserPath() { return browserPath; },
    get enabled() { return config.instagramLoginEnabled !== false; },
    get activeSessions() { return sessions.size; },
    _internal: { findBrowserPath, activeLoginCount },
  };
}

module.exports = {
  VIEWPORT,
  LOGIN_URL,
  createLoginManager,
  findBrowserPath,
};
