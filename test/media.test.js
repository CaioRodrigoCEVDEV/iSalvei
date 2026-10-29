'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { makeTempDir, makeVideo, canRunFfmpeg, makeConfig } = require('./helpers');
const {
  probeMedia,
  extractMediaInfo,
  normalizeMedia,
  normalizationPlan,
  targetDimensions,
  validateMedia,
  mimeTypeFor,
  safeFilename,
  contentDisposition,
} = require('../lib/media');

const hasFfmpeg = canRunFfmpeg();
const config = makeConfig();

test('targetDimensions usa o menor lado para vídeos verticais', () => {
  assert.deepEqual(targetDimensions(720, 1280, 720), null);
  assert.deepEqual(targetDimensions(720, 1280, 480), { width: 480, height: 854 });
  assert.deepEqual(targetDimensions(1920, 1080, 720), { width: 1280, height: 720 });
  assert.deepEqual(targetDimensions(1080, 1920, 720), { width: 720, height: 1280 });
  assert.deepEqual(targetDimensions(320, 240, 720), null);
});

test('plano não reencoda 720x1280 quando o alvo é 720', () => {
  const plan = normalizationPlan({
    width: 720, height: 1280, videoCodec: 'h264', audioCodec: 'aac', hasAudio: true, ext: '.mp4',
  }, '720');
  assert.equal(plan, null);
});

test('plano reencoda HEVC mesmo sem reduzir resolução', () => {
  const plan = normalizationPlan({
    width: 720, height: 1280, videoCodec: 'hevc', audioCodec: 'aac', hasAudio: true, ext: '.mp4',
  }, 'best');
  assert.ok(plan);
  assert.equal(plan.encodeVideo, true);
  assert.equal(plan.dimensions, null);
});

test('validateMedia rejeita imagem, duração e tamanho', () => {
  assert.throws(() => validateMedia({
    streamCount: 1, hasVideo: false, hasAudio: false, duration: 1, size: 10,
  }, { quality: 'best', maxVideoDuration: 600, maxFileSize: 1024 }), (error) => error.code === 'NO_VIDEO');

  assert.throws(() => validateMedia({
    streamCount: 2, hasVideo: true, hasAudio: true, duration: 602, size: 10,
  }, { quality: 'best', maxVideoDuration: 600, maxFileSize: 1024 }), (error) => error.code === 'VIDEO_TOO_LONG');

  assert.throws(() => validateMedia({
    streamCount: 2, hasVideo: true, hasAudio: true, duration: 10, size: 2048,
  }, { quality: 'best', maxVideoDuration: 600, maxFileSize: 1024 }), (error) => error.code === 'FILE_TOO_LARGE');
});

test('nome e Content-Disposition são seguros', () => {
  assert.equal(safeFilename('a/b:c*?"<>|', '.mp4'), 'a b c.mp4');
  const disposition = contentDisposition('Vídeo 🎬.mp4');
  assert.match(disposition, /^attachment; filename="/);
  assert.match(disposition, /filename\*=UTF-8''/);
  assert.ok(disposition.includes('%C3%AD'));
});

test('MIME reflete áudio e vídeo', () => {
  assert.equal(mimeTypeFor({ ext: '.m4a', hasVideo: false }, 'audio'), 'audio/mp4');
  assert.equal(mimeTypeFor({ ext: '.mp4', hasVideo: true }, '720'), 'video/mp4');
  assert.equal(mimeTypeFor({ ext: '.webm', hasVideo: true }, 'best'), 'video/webm');
});

test('normaliza vertical 720x1280 para 480x854 e mantém 720x1280 em 720', { skip: !hasFfmpeg }, async (t) => {
  const dir = makeTempDir('isalvei-media-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const portrait = path.join(dir, 'portrait.mp4');
  assert.equal(makeVideo(portrait, { width: 720, height: 1280 }), true);

  const info = extractMediaInfo(await probeMedia(portrait, config), portrait);
  assert.equal(info.width, 720);
  assert.equal(info.height, 1280);

  const same = await normalizeMedia(portrait, info, '720', config);
  assert.equal(same, portrait);

  const output = await normalizeMedia(portrait, info, '480', config);
  const outputInfo = extractMediaInfo(await probeMedia(output, config), output);
  assert.equal(outputInfo.width, 480);
  assert.equal(outputInfo.height, 854);
  assert.equal(outputInfo.videoCodec, 'h264');
  assert.equal(outputInfo.audioCodec, 'aac');
});

test('normaliza horizontal 1920x1080 para 720p', { skip: !hasFfmpeg }, async (t) => {
  const dir = makeTempDir('isalvei-media-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const landscape = path.join(dir, 'landscape.mp4');
  assert.equal(makeVideo(landscape, { width: 1920, height: 1080 }), true);

  const info = extractMediaInfo(await probeMedia(landscape, config), landscape);
  const output = await normalizeMedia(landscape, info, '720', config);
  const outputInfo = extractMediaInfo(await probeMedia(output, config), output);
  assert.equal(outputInfo.width, 1280);
  assert.equal(outputInfo.height, 720);
});

test('converte VP9 para H.264/AAC mantendo a resolução', { skip: !hasFfmpeg }, async (t) => {
  const dir = makeTempDir('isalvei-media-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const vp9 = path.join(dir, 'vp9.mp4');
  const created = makeVideo(vp9, { width: 720, height: 1280, videoCodec: 'libvpx-vp9' });
  if (!created) {
    t.skip('encoder libvpx-vp9 indisponível');
    return;
  }

  const info = extractMediaInfo(await probeMedia(vp9, config), vp9);
  assert.equal(info.videoCodec, 'vp9');
  const output = await normalizeMedia(vp9, info, '720', config);
  const outputInfo = extractMediaInfo(await probeMedia(output, config), output);
  assert.equal(outputInfo.videoCodec, 'h264');
  assert.equal(outputInfo.width, 720);
  assert.equal(outputInfo.height, 1280);
});
