'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyYtDlpFailure } = require('../lib/classify');
const { sanitizeLog } = require('../lib/errors');
const { detectPlatform } = require('../lib/platforms');

const youtube = detectPlatform('https://youtube.com/watch?v=abc');
const instagram = detectPlatform('https://instagram.com/reel/abc/');
const tiktok = detectPlatform('https://tiktok.com/@a/video/1');
const facebook = detectPlatform('https://facebook.com/watch/?v=1');

test('YouTube indisponível vira 404 não retryable', () => {
  const error = classifyYtDlpFailure('ERROR: [youtube] aaaaaaaaaaa: This video is unavailable', { platform: youtube });
  assert.equal(error.statusCode, 404);
  assert.equal(error.code, 'NOT_AVAILABLE');
  assert.equal(error.retryable, false);
});

test('Instagram com sessão inválida e JSON quebrado vira AUTH_REQUIRED', () => {
  const error = classifyYtDlpFailure(
    'ERROR: [Instagram] abc: Failed to parse JSON (caused by JSONDecodeError("Expecting value in \'\'")); please report this issue',
    { platform: instagram, hasCookies: true }
  );
  assert.equal(error.statusCode, 403);
  assert.equal(error.code, 'AUTH_REQUIRED');
  assert.match(error.message, /sessão do Instagram/);
});

test('Instagram login/empty media vira 403 e não retryable', () => {
  const messages = [
    'ERROR: [Instagram] abc: Requested content is not available, rate-limit reached or login required. Use --cookies-from-browser or --cookies for the authentication.',
    'ERROR: [Instagram] abc: Instagram sent an empty media response. Check if this post is accessible in your browser without being logged-in.',
  ];
  for (const message of messages) {
    const error = classifyYtDlpFailure(message, { platform: instagram });
    assert.equal(error.statusCode, 403);
    assert.equal(error.code, 'AUTH_REQUIRED');
    assert.equal(error.retryable, false);
  }
});

test('TikTok IP bloqueado vira 403 geográfico', () => {
  const error = classifyYtDlpFailure('ERROR: [TikTok] 1: Your IP address is blocked from accessing this post', { platform: tiktok });
  assert.equal(error.statusCode, 403);
  assert.equal(error.code, 'GEO_BLOCKED');
});

test('Facebook cannot parse vira 502 claro', () => {
  const error = classifyYtDlpFailure('ERROR: [facebook] 1: Cannot parse data; please report this issue', { platform: facebook });
  assert.equal(error.statusCode, 502);
  assert.equal(error.code, 'UPSTREAM_PARSE');
  assert.match(error.message, /Não foi possível interpretar/);
});

test('rate limit real vira 429 retryable', () => {
  const error = classifyYtDlpFailure('ERROR: HTTP Error 429: Too Many Requests', { platform: instagram });
  assert.equal(error.statusCode, 429);
  assert.equal(error.code, 'PLATFORM_RATE_LIMITED');
  assert.equal(error.retryable, true);
  assert.equal(error.retryAfter, 60);
});

test('ffmpeg ausente vira 503', () => {
  const error = classifyYtDlpFailure('ERROR: You have requested merging of multiple formats but ffmpeg is not installed', { platform: youtube });
  assert.equal(error.statusCode, 503);
  assert.equal(error.code, 'DEPENDENCY_MISSING');
});

test('conteúdo privado, DRM, live e geo têm códigos próprios', () => {
  assert.equal(classifyYtDlpFailure('This video is private').code, 'AUTH_REQUIRED');
  assert.equal(classifyYtDlpFailure('ERROR: This video is DRM protected').code, 'DRM_PROTECTED');
  assert.equal(classifyYtDlpFailure('ERROR: This live event will begin in 2 hours').code, 'LIVE_NOT_SUPPORTED');
  assert.equal(classifyYtDlpFailure('ERROR: The uploader has not made this video available in your country').code, 'GEO_BLOCKED');
});

test('erro desconhecido vira 502 retryable', () => {
  const error = classifyYtDlpFailure('ERROR: something unexpected happened');
  assert.equal(error.statusCode, 502);
  assert.equal(error.code, 'UPSTREAM_ERROR');
  assert.equal(error.retryable, true);
});

test('sanitizeLog remove URLs, cookies e chaves', () => {
  const output = sanitizeLog('GET https://cdn.example/video?token=abc --cookies /run/secrets/cookies.txt api_key=1234567890abcdef 1234567890abcdef1234567890abcdef');
  assert.ok(!output.includes('https://'));
  assert.ok(!output.includes('/run/secrets'));
  assert.ok(!output.includes('1234567890abcdef'));
  assert.match(output, /\[url\]/);
  assert.match(output, /\[redacted\]/);
});
