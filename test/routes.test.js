'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');

const { makeConfig, makeTempDir } = require('./helpers');
const { createApp } = require('../server');
const { createApiApp } = require('../api_server');
const { appError } = require('../lib/errors');

function fakeDownloader(filePath, options = {}) {
  let cleanupCalls = 0;
  return {
    calls: [],
    get cleanupCalls() { return cleanupCalls; },
    async prepare(url, quality, opts = {}) {
      this.calls.push({
        url,
        quality,
        requestId: opts.requestId,
        instagramCookies: opts.instagramCookies,
      });
      if (options.error) throw options.error;
      if (options.waitMs) await new Promise((resolve) => setTimeout(resolve, options.waitMs));
      return {
        url,
        platform: { id: 'youtube', name: 'YouTube', supported: true },
        filePath,
        size: fs.statSync(filePath).size,
        filename: 'Vídeo de teste.mp4',
        contentType: 'video/mp4',
        cleanup: () => { cleanupCalls++; },
      };
    },
    async checkHealth() {
      return options.health || { ok: true, checks: { ytdlp: true, ffmpeg: true, ffprobe: true, tmp: true, cookies: 'not_configured' } };
    },
  };
}

async function listen(app) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { server, base: `http://127.0.0.1:${port}` };
}

function tempMedia(t, content = 'fake video bytes') {
  const dir = makeTempDir('isalvei-route-');
  const file = path.join(dir, 'video.mp4');
  fs.writeFileSync(file, content);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return file;
}

test('GET /api/download retorna headers corretos e limpa o arquivo', async (t) => {
  const file = tempMedia(t);
  const downloader = fakeDownloader(file);
  const { app } = createApp({ config: makeConfig({ RATE_LIMIT_MAX: '100' }), downloader });
  const { server, base } = await listen(app);
  t.after(() => server.close());

  const response = await fetch(`${base}/api/download?url=${encodeURIComponent('https://www.youtube.com/watch?v=abc')}&format=720`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'video/mp4');
  assert.match(response.headers.get('content-disposition'), /attachment/);
  assert.equal(response.headers.get('content-length'), String(fs.statSync(file).size));
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(await response.text(), 'fake video bytes');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(downloader.cleanupCalls, 1);
});

test('formato inválido retorna 400 sem chamar o downloader', async (t) => {
  const file = tempMedia(t);
  const downloader = fakeDownloader(file);
  const { app } = createApp({ config: makeConfig(), downloader });
  const { server, base } = await listen(app);
  t.after(() => server.close());

  const response = await fetch(`${base}/api/download?url=https%3A%2F%2Fyoutube.com%2Fwatch%3Fv%3Dabc&format=1080`);
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.code, 'INVALID_FORMAT');
  assert.equal(downloader.calls.length, 0);
});

test('erro de aplicação não vaza details', async (t) => {
  const file = tempMedia(t);
  const downloader = fakeDownloader(file, { error: appError(403, 'AUTH_REQUIRED', 'Conteúdo privado.', { details: 'secret stderr https://cdn.example/token' }) });
  const { app } = createApp({ config: makeConfig(), downloader });
  const { server, base } = await listen(app);
  t.after(() => server.close());

  const response = await fetch(`${base}/api/download?url=https%3A%2F%2Fyoutube.com%2Fwatch%3Fv%3Dabc`);
  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.code, 'AUTH_REQUIRED');
  assert.equal(body.details, undefined);
  assert.ok(body.requestId);
});

test('rate limit retorna 429 e Retry-After', async (t) => {
  const file = tempMedia(t);
  const downloader = fakeDownloader(file);
  const { app } = createApp({ config: makeConfig({ RATE_LIMIT_MAX: '1', RATE_LIMIT_WINDOW_MS: '60000' }), downloader });
  const { server, base } = await listen(app);
  t.after(() => server.close());

  const url = `${base}/api/download?url=https%3A%2F%2Fyoutube.com%2Fwatch%3Fv%3Dabc`;
  const first = await fetch(url);
  assert.equal(first.status, 200);
  await first.text();
  const second = await fetch(url);
  assert.equal(second.status, 429);
  assert.ok(second.headers.get('retry-after'));
});

test('health reflete o estado do downloader', async (t) => {
  const file = tempMedia(t);
  const healthy = fakeDownloader(file);
  const app1 = createApp({ config: makeConfig(), downloader: healthy }).app;
  const server1 = await listen(app1);
  t.after(() => server1.server.close());
  const ok = await fetch(`${server1.base}/health`);
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).ok, true);

  const unhealthy = fakeDownloader(file, { health: { ok: false, checks: { ytdlp: false } } });
  const app2 = createApp({ config: makeConfig(), downloader: unhealthy }).app;
  const server2 = await listen(app2);
  t.after(() => server2.server.close());
  const bad = await fetch(`${server2.base}/health`);
  assert.equal(bad.status, 503);
  assert.equal((await bad.json()).ok, false);
});

test('api_server usa o mesmo handler e a mesma validação de formato', async (t) => {
  const file = tempMedia(t);
  const downloader = fakeDownloader(file);
  const { app, db } = createApiApp({
    config: makeConfig(),
    downloader,
    dbPath: ':memory:',
  });
  const { server, base } = await listen(app);
  t.after(() => server.close());
  t.after(() => db.close());

  const register = await fetch(`${base}/api/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ quota: 5 }),
  });
  assert.equal(register.status, 200);
  const { api_key: apiKey } = await register.json();

  const missing = await fetch(`${base}/api/download?url=https%3A%2F%2Fyoutube.com%2Fwatch%3Fv%3Dabc`);
  assert.equal(missing.status, 401);

  const response = await fetch(`${base}/api/download?url=https%3A%2F%2Fyoutube.com%2Fwatch%3Fv%3Dabc&format=best`, {
    headers: { 'x-api-key': apiKey },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'video/mp4');
  assert.equal(await response.text(), 'fake video bytes');
});

test('rota legada /download usa o mesmo handler', async (t) => {
  const file = tempMedia(t);
  const downloader = fakeDownloader(file);
  const { app } = createApp({ config: makeConfig({ RATE_LIMIT_MAX: '100' }), downloader });
  const { server, base } = await listen(app);
  t.after(() => server.close());

  const response = await fetch(`${base}/download?url=${encodeURIComponent('https://www.youtube.com/watch?v=abc')}&format=best`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'video/mp4');
  assert.equal(await response.text(), 'fake video bytes');
});

test('sessão do Instagram conecta, usa no download e desconecta', async (t) => {
  const file = tempMedia(t);
  const downloader = fakeDownloader(file);
  const { app } = createApp({ config: makeConfig({ RATE_LIMIT_MAX: '100' }), downloader });
  const { server, base } = await listen(app);
  t.after(() => server.close());

  const before = await fetch(`${base}/api/instagram/session`);
  assert.equal((await before.json()).connected, false);

  const connect = await fetch(`${base}/api/instagram/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cookies: '123456%3Aabcdef' }),
  });
  assert.equal(connect.status, 200);
  const connected = await connect.json();
  assert.equal(connected.connected, true);
  assert.equal(connected.userId, '123456');

  const cookie = String(connect.headers.get('set-cookie')).split(';')[0];
  assert.match(cookie, /^isalvei_ig=[a-f0-9]{64}$/);
  assert.match(connect.headers.get('set-cookie'), /HttpOnly/);

  const status = await fetch(`${base}/api/instagram/session`, { headers: { cookie } });
  assert.equal((await status.json()).connected, true);

  const download = await fetch(
    `${base}/api/download?url=${encodeURIComponent('https://www.instagram.com/reel/abc/')}`,
    { headers: { cookie } }
  );
  assert.equal(download.status, 200);
  await download.text();

  assert.equal(downloader.calls.length, 1);
  assert.match(downloader.calls[0].instagramCookies, /\tsessionid\t123456%3Aabcdef/);

  const remove = await fetch(`${base}/api/instagram/session`, { method: 'DELETE', headers: { cookie } });
  assert.equal(remove.status, 200);
  assert.match(remove.headers.get('set-cookie'), /Max-Age=0/);

  const after = await fetch(`${base}/api/instagram/session`, { headers: { cookie } });
  assert.equal((await after.json()).connected, false);
});

test('sessão do Instagram rejeita cookies sem sessionid', async (t) => {
  const file = tempMedia(t);
  const downloader = fakeDownloader(file);
  const { app } = createApp({ config: makeConfig({ RATE_LIMIT_MAX: '100' }), downloader });
  const { server, base } = await listen(app);
  t.after(() => server.close());

  const response = await fetch(`${base}/api/instagram/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cookies: 'csrftoken=abc' }),
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'INVALID_COOKIES');
});

test('erro de autenticação sinaliza loginRequired', async (t) => {
  const file = tempMedia(t);
  const downloader = fakeDownloader(file, {
    error: appError(403, 'AUTH_REQUIRED', 'Conteúdo privado.'),
  });
  const { app } = createApp({ config: makeConfig({ RATE_LIMIT_MAX: '100' }), downloader });
  const { server, base } = await listen(app);
  t.after(() => server.close());

  const response = await fetch(`${base}/api/download?url=${encodeURIComponent('https://www.instagram.com/reel/abc/')}`);
  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.loginRequired, true);
});

test('erro 502 usa mensagem segura sem vazar stderr', async (t) => {
  const file = tempMedia(t);
  const downloader = fakeDownloader(file, { error: appError(502, 'UPSTREAM_PARSE', 'Não foi possível interpretar a página.', { details: 'secret stderr https://cdn.example/token' }) });
  const { app } = createApp({ config: makeConfig(), downloader });
  const { server, base } = await listen(app);
  t.after(() => server.close());

  const response = await fetch(`${base}/api/download?url=https%3A%2F%2Fyoutube.com%2Fwatch%3Fv%3Dabc`);
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.equal(body.error, 'Não foi possível interpretar a página.');
  assert.equal(body.details, undefined);
});
