'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadConfig, parseInteger, parseBoolean } = require('../lib/config');

test('envs numéricas inválidas não desativam limites', () => {
  const config = loadConfig({
    MAX_VIDEO_DURATION: 'abc',
    MAX_FILE_SIZE: 'NaN',
    YTDLP_TIMEOUT: '-1',
    YTDLP_MAX_ATTEMPTS: '0',
    RATE_LIMIT_MAX: 'x',
  });

  assert.equal(config.maxVideoDuration, 600);
  assert.equal(config.maxFileSize, 100 * 1024 * 1024);
  assert.equal(config.ytdlpTimeout, 240000);
  assert.equal(config.ytdlpMaxAttempts, 5);
  assert.equal(config.rateLimitMax, 10);
});

test('parseInteger respeita min/max e default', () => {
  assert.equal(parseInteger('10', 5, 1, 20), 10);
  assert.equal(parseInteger('0', 5, 1, 20), 5);
  assert.equal(parseInteger('', 5, 1, 20), 5);
  assert.equal(parseInteger('abc', 5, 1, 20), 5);
});

test('parseBoolean aceita formatos comuns', () => {
  assert.equal(parseBoolean('true'), true);
  assert.equal(parseBoolean('1'), true);
  assert.equal(parseBoolean('false'), false);
  assert.equal(parseBoolean('anything', true), true);
});

test('trust proxy é desligado por default', () => {
  assert.equal(loadConfig({}).trustProxy, false);
  assert.equal(loadConfig({ TRUST_PROXY: 'true' }).trustProxy, 1);
});

test('path e cookies são resolvidos somente quando configurados', () => {
  const config = loadConfig({ TMP_DIR: '/tmp/isalvei', COOKIES_FILE: '/run/secrets/cookies.txt' });
  assert.equal(config.tmpDir, '/tmp/isalvei');
  assert.equal(config.cookiesFile, '/run/secrets/cookies.txt');
  assert.equal(loadConfig({}).tmpDir, '');
  assert.equal(loadConfig({}).cookiesFile, '');
});
