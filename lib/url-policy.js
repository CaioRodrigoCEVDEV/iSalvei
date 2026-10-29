'use strict';

const dns = require('dns');
const net = require('net');
const ipaddr = require('ipaddr.js');

const { appError } = require('./errors');
const {
  detectPlatform,
  normalizeHostname,
  hostMatches,
  unsupportedPlatformError,
} = require('./platforms');

const DEFAULT_RESOLVER = dns.promises.lookup.bind(dns.promises);
const DEFAULT_FETCH = typeof fetch === 'function' ? fetch : null;

const DENY_V4_CIDRS = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.88.99.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4',
].map((cidr) => ipaddr.parseCIDR(cidr));

const DENY_V6_CIDRS = [
  '::/128',
  '::1/128',
  '64:ff9b::/96',
  '2001:db8::/32',
  'fc00::/7',
  'fe80::/10',
  'ff00::/8',
].map((cidr) => ipaddr.parseCIDR(cidr));

const REDIRECT_PATHS = [
  '/redirect',
  '/url',
  '/l.php',
  '/l/',
];

const REDIRECT_QUERY_PARAMS = ['q', 'u', 'url', 'target', 'next', 'redirect'];

function stripIpv6Brackets(hostname) {
  const host = String(hostname || '');
  if (host.startsWith('[') && host.endsWith(']')) return host.slice(1, -1);
  return host;
}

function isBlockedAddress(address) {
  let parsed;
  try {
    parsed = ipaddr.parse(stripIpv6Brackets(address));
  } catch (error) {
    return true;
  }

  if (parsed.kind() === 'ipv6' && parsed.isIPv4MappedAddress()) {
    parsed = parsed.toIPv4Address();
  }

  if (parsed.kind() === 'ipv4') {
    if (DENY_V4_CIDRS.some((cidr) => parsed.match(cidr))) return true;
  } else if (DENY_V6_CIDRS.some((cidr) => parsed.match(cidr))) {
    return true;
  }

  // Qualquer faixa que o ipaddr não classifique como unicast (loopback,
  // link-local, multicast, reservado etc.) também é bloqueada.
  return parsed.range() !== 'unicast';
}

async function resolveAddresses(hostname, resolver = DEFAULT_RESOLVER) {
  const host = stripIpv6Brackets(normalizeHostname(hostname));
  if (net.isIP(host)) return [{ address: host, family: net.isIP(host) }];

  try {
    const records = await resolver(host, { all: true, verbatim: true });
    if (!Array.isArray(records) || records.length === 0) {
      throw new Error('empty DNS result');
    }
    return records;
  } catch (error) {
    throw appError(400, 'URL_UNRESOLVABLE', 'Não foi possível resolver o domínio informado.');
  }
}

async function assertPublicResolution(hostname, resolver = DEFAULT_RESOLVER) {
  const records = await resolveAddresses(hostname, resolver);
  for (const record of records) {
    if (isBlockedAddress(record.address)) {
      throw appError(400, 'URL_NOT_ALLOWED', 'URL inválida ou bloqueada. Use apenas links públicos das plataformas suportadas.');
    }
  }
  return records;
}

function isRedirectPath(url) {
  const pathname = url.pathname.toLowerCase();
  return REDIRECT_PATHS.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function absoluteQueryTargets(url) {
  const targets = [];
  for (const key of REDIRECT_QUERY_PARAMS) {
    const values = url.searchParams.getAll(key);
    for (const value of values) {
      if (/^https?:\/\//i.test(value)) targets.push(value);
    }
  }
  return targets;
}

function checkOpenRedirect(url, platform, resolver) {
  const host = normalizeHostname(url.hostname);
  const isInstagramWrapper = hostMatches(host, 'l.instagram.com');
  if (!isRedirectPath(url) && !isInstagramWrapper) return;
  const targets = absoluteQueryTargets(url);
  if (targets.length === 0) return;

  for (const target of targets) {
    let targetUrl;
    try {
      targetUrl = new URL(target);
    } catch (error) {
      throw appError(400, 'URL_NOT_ALLOWED', 'URL inválida ou bloqueada.');
    }
    const targetPlatform = detectPlatform(targetUrl);
    if (!targetPlatform || !targetPlatform.supported || targetPlatform.id !== platform.id) {
      throw appError(400, 'URL_NOT_ALLOWED', 'Redirecionamento para um destino não permitido.');
    }
    // O host do destino será validado novamente pela resolução DNS no fluxo
    // principal; aqui só garantimos que pertence à mesma plataforma.
    void resolver;
  }
}

function buildAbortSignal(timeoutMs, externalSignal) {
  if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    if (!externalSignal) return { signal: timeoutSignal, cleanup: () => {} };
    if (AbortSignal.any) {
      return { signal: AbortSignal.any([externalSignal, timeoutSignal]), cleanup: () => {} };
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('redirect timeout')), timeoutMs);
  const onAbort = () => controller.abort(externalSignal && externalSignal.reason);
  if (externalSignal) {
    if (externalSignal.aborted) onAbort();
    else externalSignal.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      if (externalSignal) externalSignal.removeEventListener('abort', onAbort);
    },
  };
}

async function resolveRedirectChain(initialUrl, platform, options = {}) {
  const {
    resolver = DEFAULT_RESOLVER,
    fetchImpl = DEFAULT_FETCH,
    signal,
    maxHops = 4,
    timeoutMs = 7000,
  } = options;

  if (!fetchImpl) return initialUrl;

  let current = initialUrl;
  for (let hop = 0; hop <= maxHops; hop++) {
    let response;
    const abort = buildAbortSignal(timeoutMs, signal);
    try {
      response = await fetchImpl(current, {
        method: 'GET',
        redirect: 'manual',
        signal: abort.signal,
        headers: {
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      });
    } catch (error) {
      if (signal && signal.aborted) throw signal.reason || appError(499, 'ABORTED', 'Download cancelado.');
      // Links curtos são operados pela própria plataforma. Se a sonda for
      // bloqueada, seguimos com o host curto allowlisted; para t.co não há
      // como garantir o destino, então falhamos fechado.
      if (platform.id === 'twitter' && /(^|\.)t\.co$/i.test(current.hostname)) {
        throw appError(400, 'URL_UNRESOLVABLE', 'Não foi possível validar o redirecionamento do link curto.');
      }
      return current;
    } finally {
      abort.cleanup();
    }

    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      // Não precisamos do corpo para decidir o destino.
      try { response.body?.cancel(); } catch (error) {}
      if (hop === maxHops) {
        throw appError(400, 'URL_REDIRECT_LOOP', 'Muitos redirecionamentos na URL.');
      }
      let next;
      try {
        next = new URL(location, current);
      } catch (error) {
        throw appError(400, 'URL_NOT_ALLOWED', 'Redirecionamento inválido.');
      }
      const nextPlatform = detectPlatform(next);
      if (!nextPlatform || !nextPlatform.supported || nextPlatform.id !== platform.id) {
        throw appError(400, 'URL_NOT_ALLOWED', 'Redirecionamento para um destino não permitido.');
      }
      await assertPublicResolution(next.hostname, resolver);
      current = next;
      continue;
    }

    try { response.body?.cancel(); } catch (error) {}
    return current;
  }

  return current;
}

/**
 * Valida uma URL de download e devolve a URL final, a plataforma e o host.
 * É assíncrona porque resolve DNS e, para links curtos, valida redirecionamentos.
 */
async function resolveSafeUrl(rawUrl, options = {}) {
  const {
    config,
    resolver = DEFAULT_RESOLVER,
    fetchImpl = DEFAULT_FETCH,
    signal,
  } = options;

  if (typeof rawUrl !== 'string') {
    throw appError(400, 'URL_REQUIRED', 'Parâmetro "url" obrigatório.');
  }

  const urlText = rawUrl.trim();
  if (!urlText) throw appError(400, 'URL_REQUIRED', 'Parâmetro "url" obrigatório.');
  if (urlText.length > (config?.maxUrlLength || 2048)) {
    throw appError(400, 'URL_TOO_LONG', 'URL muito longa.');
  }
  if (/[\u0000-\u001f\u007f]/.test(urlText)) {
    throw appError(400, 'URL_NOT_ALLOWED', 'URL contém caracteres inválidos.');
  }

  let url;
  try {
    url = new URL(urlText);
  } catch (error) {
    throw appError(400, 'URL_NOT_ALLOWED', 'URL inválida.');
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw appError(400, 'URL_NOT_ALLOWED', 'Use apenas URLs HTTP(S).');
  }
  if (url.username || url.password) {
    throw appError(400, 'URL_NOT_ALLOWED', 'URLs com credenciais não são permitidas.');
  }

  const host = stripIpv6Brackets(normalizeHostname(url.hostname));
  if (net.isIP(host)) {
    throw appError(400, 'URL_NOT_ALLOWED', 'URLs com endereço IP não são permitidas.');
  }

  if (config?.blockedHosts?.length) {
    if (config.blockedHosts.some((blocked) => hostMatches(host, blocked))) {
      throw appError(400, 'URL_NOT_ALLOWED', 'URL inválida ou bloqueada.');
    }
  }

  const platform = detectPlatform(url);
  if (!platform) throw unsupportedPlatformError(null);
  if (!platform.supported) throw unsupportedPlatformError(platform);

  if (url.port && !['80', '443'].includes(url.port)) {
    throw appError(400, 'URL_NOT_ALLOWED', 'Porta não permitida.');
  }

  checkOpenRedirect(url, platform, resolver);
  await assertPublicResolution(host, resolver);

  // Links curtos operados pela própria plataforma (youtu.be, instagr.am,
  // vm.tiktok.com, fb.watch etc.) não precisam de sonda HTTP: o yt-dlp resolve
  // o redirect e o host já está na allowlist. A exceção é t.co, que pode
  // apontar para qualquer destino, e o wrapper l.instagram.com?u=...
  const needsRedirectValidation = hostMatches(host, 't.co') || hostMatches(host, 'l.instagram.com');
  const finalUrl = needsRedirectValidation
    ? await resolveRedirectChain(url, platform, { resolver, fetchImpl, signal })
    : url;

  const finalHost = stripIpv6Brackets(normalizeHostname(finalUrl.hostname));
  const finalPlatform = detectPlatform(finalUrl);
  if (!finalPlatform || finalPlatform.id !== platform.id) {
    throw appError(400, 'URL_NOT_ALLOWED', 'Redirecionamento para um destino não permitido.');
  }

  return {
    url: finalUrl,
    platform: finalPlatform,
    host: finalHost,
    originalUrl: url,
  };
}

module.exports = {
  DEFAULT_RESOLVER,
  isBlockedAddress,
  resolveAddresses,
  assertPublicResolution,
  resolveSafeUrl,
  resolveRedirectChain,
  stripIpv6Brackets,
};
