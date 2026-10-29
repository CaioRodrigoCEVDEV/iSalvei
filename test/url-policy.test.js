'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadConfig } = require('../lib/config');
const {
  isBlockedAddress,
  resolveSafeUrl,
  resolveRedirectChain,
} = require('../lib/url-policy');
const { detectPlatform } = require('../lib/platforms');

const config = loadConfig({});
const publicResolver = async () => [{ address: '93.184.216.34', family: 4 }];

function fakeResponse(status, location) {
  return {
    status,
    headers: { get: (name) => (name.toLowerCase() === 'location' ? location : null) },
    body: { cancel: () => {} },
  };
}

test('bloqueia faixas IPv4/IPv6 internas e reservadas', () => {
  const blocked = [
    '0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.169.254',
    '172.16.0.1', '192.168.1.1', '198.18.0.1', '198.51.100.1', '203.0.113.1',
    '224.0.0.1', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '2001:db8::1',
  ];
  for (const address of blocked) assert.equal(isBlockedAddress(address), true, address);
  assert.equal(isBlockedAddress('8.8.8.8'), false);
  assert.equal(isBlockedAddress('2606:4700::1111'), false);
});

test('aceita URLs convencionais e curtas das plataformas', async () => {
  const urls = [
    'https://www.youtube.com/watch?v=jNQXAC9IVRw',
    'https://youtu.be/jNQXAC9IVRw',
    'https://www.tiktok.com/@tiktok/video/6718335390845095173',
    'https://vm.tiktok.com/ZSrjTVXjN',
    'https://www.facebook.com/watch/?v=10153231379946729',
    'https://fb.watch/7zK5NDl3Dw/',
    'https://x.com/NASA/status/2105842656429432894',
  ];

  for (const raw of urls) {
    const result = await resolveSafeUrl(raw, {
      config,
      resolver: publicResolver,
      fetchImpl: async () => fakeResponse(200),
    });
    assert.equal(result.platform.supported, true, raw);
    assert.ok(result.host, raw);
  }
});

test('aceita host com ponto final e normaliza o host', async () => {
  const result = await resolveSafeUrl('https://www.youtube.com./watch?v=abc', {
    config,
    resolver: publicResolver,
  });
  assert.equal(result.host, 'www.youtube.com');
  assert.equal(result.platform.id, 'youtube');
});

test('bloqueia IPs literais, localhost, lookalikes, credenciais e portas', async () => {
  const cases = [
    'http://127.0.0.1/',
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://localhost./',
    'http://10.0.0.1.nip.io/',
    'https://youtube.com.evil.com/watch?v=abc',
    'https://evilyoutube.com/watch?v=abc',
    'https://www.youtube.com@evil.com/watch?v=abc',
    'https://www.youtube.com:8443/watch?v=abc',
    'ftp://www.youtube.com/watch?v=abc',
  ];

  for (const raw of cases) {
    await assert.rejects(
      () => resolveSafeUrl(raw, { config, resolver: publicResolver, fetchImpl: async () => fakeResponse(200) }),
      (error) => error.statusCode >= 400 && error.statusCode < 500,
      raw
    );
  }
});

test('rejeita DNS que resolve para endereço interno', async () => {
  const resolver = async () => [{ address: '127.0.0.1', family: 4 }];
  await assert.rejects(
    () => resolveSafeUrl('https://www.youtube.com/watch?v=abc', { config, resolver }),
    (error) => error.statusCode === 400 && error.code === 'URL_NOT_ALLOWED'
  );
});

test('Kwai retorna 422 com mensagem clara', async () => {
  await assert.rejects(
    () => resolveSafeUrl('https://www.kwai.com/@user/video/123', { config, resolver: publicResolver }),
    (error) => error.statusCode === 422 && error.code === 'UNSUPPORTED_PLATFORM' && /Kwai/.test(error.message)
  );
});

test('plataforma desconhecida retorna 422', async () => {
  await assert.rejects(
    () => resolveSafeUrl('https://example.com/video', { config, resolver: publicResolver }),
    (error) => error.statusCode === 422 && error.code === 'UNSUPPORTED_PLATFORM'
  );
});

test('bloqueia open redirect para endereço interno', async () => {
  const raw = 'https://www.youtube.com/redirect?q=http://169.254.169.254/';
  await assert.rejects(
    () => resolveSafeUrl(raw, { config, resolver: publicResolver }),
    (error) => error.statusCode === 400 && error.code === 'URL_NOT_ALLOWED'
  );
});

test('permite open redirect para a mesma plataforma', async () => {
  const raw = 'https://www.youtube.com/redirect?q=https://youtu.be/abc';
  const result = await resolveSafeUrl(raw, {
    config,
    resolver: publicResolver,
    fetchImpl: async () => fakeResponse(200),
  });
  assert.equal(result.platform.id, 'youtube');
});

test('valida a cadeia de redirects de link curto', async () => {
  const responses = [
    fakeResponse(302, 'https://www.youtube.com/watch?v=abc'),
    fakeResponse(200),
  ];
  const fetchImpl = async () => responses.shift();
  const result = await resolveRedirectChain(new URL('https://youtu.be/abc'), detectPlatform('https://youtu.be/abc'), {
    resolver: publicResolver,
    fetchImpl,
  });
  assert.equal(result.hostname, 'www.youtube.com');
});

test('rejeita redirect de t.co para fora da allowlist', async () => {
  const fetchImpl = async () => fakeResponse(302, 'http://169.254.169.254/');
  await assert.rejects(
    () => resolveSafeUrl('https://t.co/abc', {
      config,
      resolver: publicResolver,
      fetchImpl,
    }),
    (error) => error.statusCode === 400 && error.code === 'URL_NOT_ALLOWED'
  );
});

test('t.co falha fechado se a sonda de redirect falhar', async () => {
  await assert.rejects(
    () => resolveSafeUrl('https://t.co/abc', {
      config,
      resolver: publicResolver,
      fetchImpl: async () => { throw new Error('blocked'); },
    }),
    (error) => error.statusCode === 400
  );
});

test('bloqueia open redirect protocol-relative', async () => {
  const raw = 'https://www.youtube.com/redirect?q=//169.254.169.254/';
  await assert.rejects(
    () => resolveSafeUrl(raw, { config, resolver: publicResolver }),
    (error) => error.statusCode === 400 && error.code === 'URL_NOT_ALLOWED'
  );
});
