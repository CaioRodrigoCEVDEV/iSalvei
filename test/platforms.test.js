'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  detectPlatform,
  isShortHost,
  normalizeQuality,
  getTargetResolution,
  buildMetadataArgs,
  buildDownloadArgs,
  formatSort,
  baseFormatSelector,
} = require('../lib/platforms');
const { loadConfig } = require('../lib/config');

const config = loadConfig({ COOKIES_FILE: '/tmp/cookies.txt' });

test('detecta plataformas convencionais e links curtos', () => {
  const cases = [
    ['https://www.youtube.com/watch?v=abc', 'youtube'],
    ['https://youtu.be/abc', 'youtube'],
    ['https://www.youtube.com/shorts/abc', 'youtube'],
    ['https://m.youtube.com/watch?v=abc', 'youtube'],
    ['https://www.youtube-nocookie.com/embed/abc', 'youtube'],
    ['https://www.instagram.com/reel/abc/', 'instagram'],
    ['https://instagr.am/p/abc/', 'instagram'],
    ['https://www.tiktok.com/@user/video/123', 'tiktok'],
    ['https://vm.tiktok.com/abc', 'tiktok'],
    ['https://vt.tiktok.com/abc', 'tiktok'],
    ['https://www.facebook.com/watch/?v=123', 'facebook'],
    ['https://fb.watch/abc/', 'facebook'],
    ['https://fb.me/abc', 'facebook'],
    ['https://x.com/user/status/123', 'twitter'],
    ['https://twitter.com/user/status/123', 'twitter'],
    ['https://www.kwai.com/@user/video/123', 'kwai'],
  ];

  for (const [url, expected] of cases) {
    assert.equal(detectPlatform(url)?.id, expected, url);
  }
});

test('não detecta lookalikes, IPs ou hosts desconhecidos', () => {
  const urls = [
    'https://youtube.com.evil.com/watch?v=abc',
    'https://evilyoutube.com/watch?v=abc',
    'https://www.youtube.com@evil.com/watch?v=abc',
    'https://127.0.0.1/',
    'https://[::1]/',
    'https://example.com/video',
  ];
  for (const url of urls) {
    assert.equal(detectPlatform(url), null, url);
  }
});

test('links curtos são identificados', () => {
  for (const host of ['youtu.be', 'instagr.am', 'vm.tiktok.com', 'fb.watch', 't.co']) {
    assert.equal(isShortHost(host), true, host);
  }
  assert.equal(isShortHost('youtube.com'), false);
});

test('normaliza qualidade e rejeita valores desconhecidos', () => {
  assert.equal(normalizeQuality(undefined), 'best');
  assert.equal(normalizeQuality('720'), '720');
  assert.equal(normalizeQuality('audio'), 'audio');
  assert.throws(() => normalizeQuality('1080'), (error) => error.statusCode === 400 && error.code === 'INVALID_FORMAT');
});

test('alvo usa o menor lado e best é 1080', () => {
  assert.equal(getTargetResolution('best'), 1080);
  assert.equal(getTargetResolution('720'), 720);
  assert.equal(getTargetResolution('480'), 480);
  assert.equal(getTargetResolution('audio'), null);
});

test('sort de qualidade prioriza resolução e H.264/AAC', () => {
  assert.equal(formatSort('best'), 'res:1080,vcodec:h264,acodec:m4a');
  assert.equal(formatSort('720'), 'res:720,vcodec:h264,acodec:m4a');
  assert.equal(formatSort('480'), 'res:480,vcodec:h264,acodec:m4a');
  assert.equal(formatSort('audio'), null);
});

test('Facebook/TikTok/Instagram usam formato progressivo antes do merge', () => {
  const platform = detectPlatform('https://www.tiktok.com/@a/video/1');
  assert.equal(baseFormatSelector(platform, 'best'), 'b[ext=mp4]/b/bv*+ba');
  assert.equal(baseFormatSelector(detectPlatform('https://youtu.be/a'), 'best'), 'bv*+ba/b');
});

test('metadata args não contêm a flag antiga do YouTube e incluem runtime Node', () => {
  const platform = detectPlatform('https://www.youtube.com/watch?v=abc');
  const args = buildMetadataArgs('https://www.youtube.com/watch?v=abc', platform, '720', config);
  const joined = args.join(' ');

  assert.ok(args.includes('--ignore-config'));
  assert.ok(args.includes('--no-js-runtimes'));
  assert.ok(args.includes('node'));
  assert.ok(args.includes('res:720,vcodec:h264,acodec:m4a'));
  assert.ok(!joined.includes('player-client'));
  assert.ok(args.includes('--cookies'));
  assert.equal(args.at(-1), 'https://www.youtube.com/watch?v=abc');
});

test('download args de áudio extraem m4a e usam merge mp4 no vídeo', () => {
  const platform = detectPlatform('https://www.instagram.com/reel/a/');
  const audio = buildDownloadArgs('https://www.instagram.com/reel/a/', platform, 'audio', config, '/tmp/%(id)s.%(ext)s');
  assert.ok(audio.includes('-x'));
  assert.ok(audio.includes('m4a'));
  assert.ok(audio.includes('--audio-quality'));

  const video = buildDownloadArgs('https://www.instagram.com/reel/a/', platform, 'best', config, '/tmp/%(id)s.%(ext)s');
  assert.ok(video.includes('--merge-output-format'));
  assert.ok(video.includes('mp4'));
  assert.ok(!video.includes('-x'));
});
