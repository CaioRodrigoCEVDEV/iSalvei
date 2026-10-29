'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeInstagramCookies,
  createSessionStore,
  parseCookieHeader,
} = require('../lib/instagram-session');

test('sessionid puro vira cookies.txt com csrftoken e ds_user_id', () => {
  const result = normalizeInstagramCookies('123456%3AabcdefGHIJKL');

  assert.match(result.text, /^# Netscape HTTP Cookie File/);
  assert.match(result.text, /\.instagram\.com\tTRUE\t\/\tTRUE\t0\tsessionid\t123456%3AabcdefGHIJKL/);
  assert.match(result.text, /\tcsrftoken\t/);
  assert.match(result.text, /\tds_user_id\t123456/);
  assert.equal(result.userId, '123456');
});

test('header Cookie mantém os cookies informados', () => {
  const result = normalizeInstagramCookies('sessionid=987%3Axyz; csrftoken=csrf123; ds_user_id=987');

  assert.match(result.text, /\tsessionid\t987%3Axyz/);
  assert.match(result.text, /\tcsrftoken\tcsrf123/);
  assert.match(result.text, /\tds_user_id\t987/);
});

test('cookies.txt remove domínios que não são do Instagram', () => {
  const input = [
    '# Netscape HTTP Cookie File',
    '#HttpOnly_.instagram.com\tTRUE\t/\tTRUE\t0\tsessionid\t111%3Aabc',
    '.evil.com\tTRUE\t/\tTRUE\t0\tsessionid\tstolen',
    '.instagram.com\tTRUE\t/\tTRUE\t0\tcsrftoken\tcsrf',
  ].join('\n');

  const result = normalizeInstagramCookies(input);
  assert.match(result.text, /\.instagram\.com\tTRUE\t\/\tTRUE\t0\tsessionid\t111%3Aabc/);
  assert.doesNotMatch(result.text, /evil\.com/);
});

test('rejeita entrada sem sessionid e entrada vazia', () => {
  assert.throws(() => normalizeInstagramCookies('csrftoken=abc'), (error) => (
    error.statusCode === 400 && error.code === 'INVALID_COOKIES'
  ));
  assert.throws(() => normalizeInstagramCookies('   '), (error) => error.code === 'INVALID_COOKIES');
});

test('parseCookieHeader ignora pares inválidos', () => {
  assert.deepEqual(parseCookieHeader('a=1; b=2; =x; c='), [
    { name: 'a', value: '1' },
    { name: 'b', value: '2' },
  ]);
});

test('store expira, remove e limita sessões', () => {
  let clock = 1000;
  const store = createSessionStore({ ttlMs: 60000, maxSessions: 2, now: () => clock });

  const first = store.create('cookie-1');
  assert.ok(store.get(first.token));
  assert.equal(store.get('invalido'), null);

  const second = store.create('cookie-2');
  store.create('cookie-3');
  assert.equal(store.size, 2);
  assert.equal(store.get(first.token), null);

  assert.equal(store.remove(second.token), true);
  assert.equal(store.get(second.token), null);

  clock += 61000;
  assert.equal(store.get(store.create('cookie-4').token).expiresAt > clock, true);
  clock += 61000;
  assert.equal(store.size, 0);
});


