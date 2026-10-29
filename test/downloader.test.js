'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  FAKE_YTDLP,
  ensureExecutable,
  makeTempDir,
  makeVideo,
  canRunFfmpeg,
  makeConfig,
} = require('./helpers');
const { createDownloader, Semaphore, parseMetadataOutput } = require('../lib/downloader');
const { probeMedia, extractMediaInfo } = require('../lib/media');

ensureExecutable(FAKE_YTDLP);
const hasFfmpeg = canRunFfmpeg();

function setup(t, overrides = {}) {
  const base = makeTempDir('isalvei-downloader-');
  const fixture = path.join(base, 'fixture.mp4');
  if (!makeVideo(fixture, { width: 320, height: 240 })) {
    t.skip('ffmpeg indisponível');
    return null;
  }
  const tmpRoot = path.join(base, 'tmp');
  fs.mkdirSync(tmpRoot);
  const marker = path.join(base, 'marker.txt');
  const env = {
    ...process.env,
    FAKE_COPY_FROM: fixture,
    FAKE_MARKER: marker,
  };
  const config = makeConfig({
    TMP_DIR: tmpRoot,
    MAX_FILE_SIZE: String(100 * 1024 * 1024),
    ...overrides,
  });
  const downloader = createDownloader(config, {
    env,
    resolver: async () => [{ address: '93.184.216.34', family: 4 }],
    fetchImpl: async () => ({ status: 200, headers: { get: () => null }, body: { cancel() {} } }),
    logger: { warn() {}, error() {} },
  });
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { base, fixture, tmpRoot, marker, env, config, downloader };
}

test('prepare baixa, valida e limpa o diretório temporário', { skip: !hasFfmpeg }, async (t) => {
  const ctx = setup(t);
  if (!ctx) return;

  const result = await ctx.downloader.prepare('https://www.youtube.com/watch?v=abc', 'best', { requestId: 'success' });
  assert.ok(fs.existsSync(result.filePath));
  assert.equal(result.contentType, 'video/mp4');
  assert.equal(result.platform.id, 'youtube');
  assert.match(result.filename, /Fake video\.mp4$/);
  assert.ok(result.size > 0);

  const info = extractMediaInfo(await probeMedia(result.filePath, ctx.config), result.filePath);
  assert.equal(info.hasVideo, true);
  assert.equal(info.hasAudio, true);

  await result.cleanup();
  assert.deepEqual(fs.readdirSync(ctx.tmpRoot), []);
});

test('vídeo vertical 720x1280 não é reduzido em 720', { skip: !hasFfmpeg }, async (t) => {
  const dir = makeTempDir('isalvei-portrait-');
  const portrait = path.join(dir, 'portrait.mp4');
  if (!makeVideo(portrait, { width: 720, height: 1280 })) {
    fs.rmSync(dir, { recursive: true, force: true });
    t.skip('ffmpeg indisponível');
    return;
  }
  const tmpRoot = path.join(dir, 'tmp');
  fs.mkdirSync(tmpRoot);
  const config = makeConfig({ TMP_DIR: tmpRoot });
  const env = { ...process.env, FAKE_COPY_FROM: portrait };
  const downloader = createDownloader(config, {
    env,
    resolver: async () => [{ address: '93.184.216.34', family: 4 }],
    fetchImpl: async () => ({ status: 200, headers: { get: () => null }, body: { cancel() {} } }),
    logger: { warn() {}, error() {} },
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const result = await downloader.prepare('https://www.tiktok.com/@a/video/1', '720');
  const info = extractMediaInfo(await probeMedia(result.filePath, config), result.filePath);
  assert.equal(info.width, 720);
  assert.equal(info.height, 1280);
  await result.cleanup();
});

test('erro de autenticação não é repetido', { skip: !hasFfmpeg }, async (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  ctx.env.FAKE_EXIT = '1';
  ctx.env.FAKE_STDERR = 'ERROR: [youtube] abc: This video is private';

  const downloader = createDownloader(ctx.config, {
    env: ctx.env,
    resolver: async () => [{ address: '93.184.216.34', family: 4 }],
    fetchImpl: async () => ({ status: 200, headers: { get: () => null }, body: { cancel() {} } }),
    logger: { warn() {}, error() {} },
  });
  await assert.rejects(
    () => downloader.prepare('https://www.youtube.com/watch?v=abc', 'best'),
    (error) => error.statusCode === 403 && error.code === 'AUTH_REQUIRED'
  );

  const marker = fs.readFileSync(ctx.marker, 'utf8');
  assert.equal((marker.match(/metadata/g) || []).length, 1);
});

test('erro transitório faz retry e depois conclui', { skip: !hasFfmpeg }, async (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  ctx.env.FAKE_FAIL_ONCE = path.join(ctx.base, 'fail-once');

  const downloader = createDownloader(ctx.config, {
    env: ctx.env,
    resolver: async () => [{ address: '93.184.216.34', family: 4 }],
    fetchImpl: async () => ({ status: 200, headers: { get: () => null }, body: { cancel() {} } }),
    logger: { warn() {}, error() {} },
  });
  const result = await downloader.prepare('https://www.youtube.com/watch?v=abc', 'best');
  assert.ok(fs.existsSync(result.filePath));
  const marker = fs.readFileSync(ctx.marker, 'utf8');
  assert.equal((marker.match(/download/g) || []).length, 2);
  await result.cleanup();
});

test('timeout do job retorna 504 e limpa temporários', { skip: !hasFfmpeg }, async (t) => {
  const ctx = setup(t, { JOB_TIMEOUT: '200', YTDLP_TIMEOUT: '5000' });
  if (!ctx) return;
  ctx.env.FAKE_SLEEP = '5000';

  const downloader = createDownloader(ctx.config, {
    env: ctx.env,
    resolver: async () => [{ address: '93.184.216.34', family: 4 }],
    fetchImpl: async () => ({ status: 200, headers: { get: () => null }, body: { cancel() {} } }),
    logger: { warn() {}, error() {} },
  });
  await assert.rejects(
    () => downloader.prepare('https://www.youtube.com/watch?v=abc', 'best'),
    (error) => error.statusCode === 504
  );
  assert.deepEqual(fs.readdirSync(ctx.tmpRoot), []);
});

test('sem saída do yt-dlp retorna 502 e limpa temporários', { skip: !hasFfmpeg }, async (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  ctx.env.FAKE_NO_OUTPUT = '1';

  const downloader = createDownloader(ctx.config, {
    env: ctx.env,
    resolver: async () => [{ address: '93.184.216.34', family: 4 }],
    fetchImpl: async () => ({ status: 200, headers: { get: () => null }, body: { cancel() {} } }),
    logger: { warn() {}, error() {} },
  });
  await assert.rejects(
    () => downloader.prepare('https://www.youtube.com/watch?v=abc', 'best'),
    (error) => error.statusCode === 502 && error.code === 'NO_OUTPUT'
  );
  assert.deepEqual(fs.readdirSync(ctx.tmpRoot), []);
});

test('arquivo maior que o limite real retorna 413', { skip: !hasFfmpeg }, async (t) => {
  const ctx = setup(t, { MAX_FILE_SIZE: '1024' });
  if (!ctx) return;
  // Metadados pequenos passam pela checagem prévia; o arquivo real é maior.
  const large = path.join(ctx.base, 'large.mp4');
  assert.equal(makeVideo(large, { width: 1280, height: 720 }), true);
  ctx.env.FAKE_COPY_FROM = large;
  ctx.env.FAKE_METADATA = JSON.stringify({
    id: 'fake-id', title: 'Fake', duration: 1, ext: 'mp4', vcodec: 'h264', acodec: 'aac',
    filesize: 10, formats: [{ format_id: '1', ext: 'mp4', vcodec: 'h264', acodec: 'aac', filesize: 10 }],
  });

  const downloader = createDownloader(ctx.config, {
    env: ctx.env,
    resolver: async () => [{ address: '93.184.216.34', family: 4 }],
    fetchImpl: async () => ({ status: 200, headers: { get: () => null }, body: { cancel() {} } }),
    logger: { warn() {}, error() {} },
  });
  await assert.rejects(
    () => downloader.prepare('https://www.youtube.com/watch?v=abc', 'best'),
    (error) => error.statusCode === 413
  );
  assert.deepEqual(fs.readdirSync(ctx.tmpRoot), []);
});

test('metadados de imagem não tentam baixar vídeo', { skip: !hasFfmpeg }, async (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  ctx.env.FAKE_METADATA = JSON.stringify({
    id: 'img', title: 'Photo', duration: 0, ext: 'jpg',
    formats: [{ format_id: '1', ext: 'jpg', vcodec: 'none', acodec: 'none' }],
  });

  const downloader = createDownloader(ctx.config, {
    env: ctx.env,
    resolver: async () => [{ address: '93.184.216.34', family: 4 }],
    fetchImpl: async () => ({ status: 200, headers: { get: () => null }, body: { cancel() {} } }),
    logger: { warn() {}, error() {} },
  });
  await assert.rejects(
    () => downloader.prepare('https://www.youtube.com/watch?v=abc', 'best'),
    (error) => error.statusCode === 422 && error.code === 'NO_VIDEO'
  );
  assert.equal(fs.existsSync(ctx.marker) ? fs.readFileSync(ctx.marker, 'utf8').includes('download') : false, false);
});

test('semáforo rejeita quando a fila estoura', async () => {
  const semaphore = new Semaphore(1);
  const release = await semaphore.acquire(100);
  await assert.rejects(
    () => semaphore.acquire(10),
    (error) => error.statusCode === 503 && error.code === 'SERVER_BUSY'
  );
  release();
});

test('parseMetadataOutput aceita JSON com linhas de log', () => {
  assert.deepEqual(parseMetadataOutput('log\n{"id":"1"}\n'), { id: '1' });
  assert.throws(() => parseMetadataOutput('not json'));
});
