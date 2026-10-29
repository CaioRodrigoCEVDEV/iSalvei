'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadConfig } = require('../lib/config');
const { createLoginManager, findBrowserPath } = require('../lib/instagram-login');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fakeRes() {
  const state = { text: '', ended: false };
  return {
    status() { return this; },
    setHeader() {},
    flushHeaders() {},
    write(chunk) { state.text += chunk; return true; },
    end() { state.ended = true; },
    on() {},
    socket: null,
    get text() { return state.text; },
    get ended() { return state.ended; },
  };
}

function fakeBrowser() {
  const calls = {
    gotos: [],
    contexts: 0,
    contextClosed: 0,
    browserClosed: 0,
    screenshots: 0,
    clicks: [],
    moves: [],
    wheels: [],
    typed: [],
    keys: [],
    cookieChecks: 0,
  };
  let cookieProvider = () => [];

  const page = {
    setDefaultTimeout() {},
    async goto(url) { calls.gotos.push(url); },
    async screenshot() {
      calls.screenshots++;
      return Buffer.from(`fake-frame-${calls.screenshots}`);
    },
    mouse: {
      async click(x, y) { calls.clicks.push([x, y]); },
      async move(x, y) { calls.moves.push([x, y]); },
      async wheel(dx, dy) { calls.wheels.push([dx, dy]); },
    },
    keyboard: {
      async type(text) { calls.typed.push(text); },
      async press(key) { calls.keys.push(key); },
    },
  };

  const context = {
    async addInitScript() {},
    async newPage() { return page; },
    async cookies() {
      calls.cookieChecks++;
      return cookieProvider();
    },
    async close() { calls.contextClosed++; },
  };

  const browser = {
    async newContext() { calls.contexts++; return context; },
    isConnected() { return calls.browserClosed === 0; },
    async close() { calls.browserClosed++; },
    on() {},
  };

  return {
    browser,
    page,
    context,
    calls,
    setCookies(provider) { cookieProvider = provider; },
  };
}

function makeManager(fake, overrides = {}) {
  return createLoginManager({
    config: loadConfig({
      IG_LOGIN_MAX_SESSIONS: '2',
      IG_LOGIN_TTL: '60000',
      ...overrides,
    }),
    launchBrowser: async () => fake.browser,
    logger: { warn() {}, error() {} },
  });
}

async function waitForClaim(manager, id, ip, timeoutMs = 4000) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      return manager.claim(id, ip);
    } catch (error) {
      lastError = error;
      if (error.code !== 'LOGIN_PENDING') throw error;
      await delay(200);
    }
  }
  throw lastError;
}

test('start transmite frames e encaminha clique, digitação e scroll', async () => {
  const fake = fakeBrowser();
  const manager = makeManager(fake);
  try {
    const session = await manager.start({ ip: '127.0.0.1' });
    assert.match(session.id, /^[a-f0-9]{48}$/);
    assert.deepEqual(fake.calls.gotos, ['https://www.instagram.com/accounts/login/']);

    const stream = fakeRes();
    manager.subscribe(session.id, '127.0.0.1', stream);
    assert.match(stream.text, /"type":"ready"/);

    await delay(900);
    assert.match(stream.text, /"type":"frame"/);
    assert.match(stream.text, /"image":"/);

    await manager.input(session.id, { type: 'click', x: 20, y: 30 }, '127.0.0.1');
    await manager.input(session.id, { type: 'type', text: 'teste' }, '127.0.0.1');
    await manager.input(session.id, { type: 'key', key: 'Enter' }, '127.0.0.1');
    await manager.input(session.id, { type: 'scroll', x: 10, y: 10, deltaY: 300 }, '127.0.0.1');

    assert.deepEqual(fake.calls.clicks, [[20, 30]]);
    assert.deepEqual(fake.calls.typed, ['teste']);
    assert.deepEqual(fake.calls.keys, ['Enter']);
    assert.deepEqual(fake.calls.wheels, [[0, 300]]);

    manager.cancel(session.id, '127.0.0.1');
    await delay(20);
    assert.equal(fake.calls.contextClosed, 1);
  } finally {
    await manager.close();
  }
});

test('detecta sessionid, emite connected e entrega os cookies no claim', async () => {
  const fake = fakeBrowser();
  fake.setCookies(() => [
    { name: 'csrftoken', value: 'csrf' },
    { name: 'sessionid', value: '123%3Aabc' },
    { name: 'ds_user_id', value: '123' },
  ]);
  const manager = makeManager(fake);
  try {
    const session = await manager.start({ ip: '127.0.0.1' });
    const stream = fakeRes();
    manager.subscribe(session.id, '127.0.0.1', stream);

    const cookieText = await waitForClaim(manager, session.id, '127.0.0.1');
    assert.match(cookieText, /\tsessionid\t123%3Aabc/);
    assert.match(cookieText, /\tcsrftoken\tcsrf/);
    assert.match(stream.text, /"type":"connected"/);
  } finally {
    await manager.close();
  }
});

test('valida entradas e status da sessão', async () => {
  const fake = fakeBrowser();
  const manager = makeManager(fake);
  try {
    const session = await manager.start({ ip: '127.0.0.1' });

    await assert.rejects(
      () => manager.input(session.id, { type: 'click', x: 9999, y: 10 }, '127.0.0.1'),
      (error) => error.code === 'INVALID_INPUT'
    );
    await assert.rejects(
      () => manager.input(session.id, { type: 'key', key: 'Control' }, '127.0.0.1'),
      (error) => error.code === 'INVALID_INPUT'
    );
    await assert.rejects(
      () => manager.input(session.id, { type: 'click', x: 1, y: 1 }, '10.0.0.2'),
      (error) => error.code === 'LOGIN_SESSION_FORBIDDEN'
    );
    assert.throws(
      () => manager.claim(session.id, '127.0.0.1'),
      (error) => error.code === 'LOGIN_PENDING'
    );
    assert.throws(
      () => manager.subscribe('inexistente', '127.0.0.1', fakeRes()),
      (error) => error.code === 'LOGIN_SESSION_NOT_FOUND'
    );
  } finally {
    await manager.close();
  }
});

test('respeita limite de sessões e desativação', async () => {
  const fake = fakeBrowser();
  const manager = makeManager(fake, { IG_LOGIN_MAX_SESSIONS: '1' });
  try {
    const first = await manager.start({ ip: '127.0.0.1' });
    await assert.rejects(
      () => manager.start({ ip: '127.0.0.1' }),
      (error) => error.code === 'LOGIN_BUSY'
    );
    manager.cancel(first.id, '127.0.0.1');
    await delay(20);
  } finally {
    await manager.close();
  }

  const disabled = makeManager(fake, { IG_LOGIN_ENABLED: 'false' });
  await assert.rejects(
    () => disabled.start({ ip: '127.0.0.1' }),
    (error) => error.code === 'BROWSER_UNAVAILABLE'
  );
  await disabled.close();
});

test('findBrowserPath aceita caminho explícito existente', () => {
  assert.equal(findBrowserPath('/bin/sh'), '/bin/sh');
  assert.equal(findBrowserPath('/caminho/que/nao/existe'), null);
  assert.equal(findBrowserPath(__filename), __filename);
});

test('close encerra o navegador e limpa sessões', async () => {
  const fake = fakeBrowser();
  const manager = makeManager(fake);
  await manager.start({ ip: '127.0.0.1' });
  assert.equal(manager.activeSessions, 1);
  await manager.close();
  assert.equal(manager.activeSessions, 0);
  assert.equal(fake.calls.browserClosed, 1);
});
