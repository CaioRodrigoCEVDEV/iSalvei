'use strict';

const { appError } = require('./errors');

/**
 * Plataformas suportadas. A allowlist é intencionalmente fechada: o backend não
 * tenta extrair URLs arbitrárias. Domínios de compartilhamento curtos também
 * são aceitos e passam por validação de redirect antes do download.
 */
const PLATFORMS = Object.freeze([
  {
    id: 'youtube',
    name: 'YouTube',
    supported: true,
    hosts: ['youtube.com', 'youtu.be', 'youtube-nocookie.com'],
    shortHosts: ['youtu.be'],
    formatStyle: 'merge',
    youtube: true,
  },
  {
    id: 'instagram',
    name: 'Instagram',
    supported: true,
    hosts: ['instagram.com', 'instagr.am'],
    shortHosts: ['instagr.am', 'l.instagram.com'],
    formatStyle: 'progressive',
  },
  {
    id: 'tiktok',
    name: 'TikTok',
    supported: true,
    hosts: ['tiktok.com'],
    shortHosts: ['vm.tiktok.com', 'vt.tiktok.com'],
    formatStyle: 'progressive',
  },
  {
    id: 'facebook',
    name: 'Facebook',
    supported: true,
    hosts: ['facebook.com', 'fb.watch', 'fb.me', 'fb.com'],
    shortHosts: ['fb.watch', 'fb.me'],
    formatStyle: 'progressive',
  },
  {
    id: 'twitter',
    name: 'X/Twitter',
    supported: true,
    hosts: ['x.com', 'twitter.com', 't.co'],
    shortHosts: ['t.co'],
    formatStyle: 'progressive',
  },
  {
    id: 'kwai',
    name: 'Kwai',
    supported: false,
    hosts: ['kwai.com', 'kwai.app', 'kwai-video.com'],
    shortHosts: ['s.kwai.app'],
    formatStyle: 'progressive',
    unsupportedReason: 'O Kwai ainda não é suportado. Use YouTube, Instagram, TikTok, Facebook ou X/Twitter.',
  },
]);

const QUALITIES = Object.freeze(['best', '720', '480', 'audio']);
const VIDEO_TARGETS = Object.freeze({ best: 1080, 720: 720, 480: 480 });

const EXTRACTOR_PLATFORM = Object.freeze({
  youtube: 'youtube',
  instagram: 'instagram',
  tiktok: 'tiktok',
  facebook: 'facebook',
  twitter: 'twitter',
  kwai: 'kwai',
});

function normalizeHostname(hostname) {
  return String(hostname || '').trim().toLowerCase().replace(/\.+$/, '');
}

function hostMatches(hostname, domain) {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function detectPlatform(input) {
  let url;
  try {
    url = input instanceof URL ? input : new URL(String(input));
  } catch (error) {
    return null;
  }

  const hostname = normalizeHostname(url.hostname);
  if (!hostname) return null;

  for (const platform of PLATFORMS) {
    if (platform.hosts.some((domain) => hostMatches(hostname, domain))) {
      return platform;
    }
  }
  return null;
}

function getPlatformById(id) {
  return PLATFORMS.find((platform) => platform.id === id) || null;
}

function platformFromExtractor(extractorKey) {
  if (!extractorKey) return null;
  const key = String(extractorKey).toLowerCase();
  const id = Object.keys(EXTRACTOR_PLATFORM).find((candidate) => key.startsWith(candidate));
  return id ? getPlatformById(id) : null;
}

function isShortHost(hostname) {
  const host = normalizeHostname(hostname);
  return PLATFORMS.some((platform) => platform.shortHosts.some((short) => hostMatches(host, short)));
}

function normalizeQuality(value) {
  const quality = String(value == null || value === '' ? 'best' : value).trim().toLowerCase();
  if (!QUALITIES.includes(quality)) {
    throw appError(
      400,
      'INVALID_FORMAT',
      'Formato inválido. Use best, 720, 480 ou audio.'
    );
  }
  return quality;
}

function getTargetResolution(quality) {
  if (quality === 'audio') return null;
  return VIDEO_TARGETS[quality] || VIDEO_TARGETS.best;
}

function baseFormatSelector(platform, quality) {
  if (quality === 'audio') return 'bestaudio/best';
  if (!platform) return 'bv*+ba/b';
  if (platform.formatStyle === 'progressive') {
    // Evita escolher vídeo sem áudio em plataformas que normalmente entregam
    // MP4 progressivo; se não houver, cai para o merge genérico.
    return 'b[ext=mp4]/b/bv*+ba';
  }
  return 'bv*+ba/b';
}

function formatSort(quality) {
  if (quality === 'audio') return null;
  const target = getTargetResolution(quality);
  // "res" é o menor lado do vídeo, então funciona tanto para 1280x720 quanto
  // para 720x1280. O desempate prefere H.264/AAC para compatibilidade.
  return `res:${target},vcodec:h264,acodec:m4a`;
}

function selectionArgs(platform, quality) {
  const args = ['-f', baseFormatSelector(platform, quality)];
  const sort = formatSort(quality);
  if (sort) args.push('-S', sort);
  return args;
}

function commonArgs(platform, config) {
  const args = [
    '--ignore-config',
    '--no-playlist',
    '--no-warnings',
    '--no-progress',
    '--socket-timeout', '30',
  ];

  if (config.cookiesFile) {
    args.push('--cookies', config.cookiesFile);
  }

  if (platform && platform.id === 'youtube') {
    // yt-dlp 2026+ usa EJS para o YouTube; Node >= 22 é o runtime disponível na
    // imagem. Desabilitar Deno explicitamente evita depender de um binário que
    // não está instalado.
    args.push('--no-js-runtimes', '--js-runtimes', 'node');
  }

  if (platform && platform.id === 'instagram') {
    args.push('--extractor-retries', '3');
  }

  return args;
}

function buildMetadataArgs(url, platform, quality, config) {
  return [
    ...commonArgs(platform, config),
    '--dump-single-json',
    ...selectionArgs(platform, quality),
    String(url),
  ];
}

function buildDownloadArgs(url, platform, quality, config, outputTemplate) {
  const args = [
    ...commonArgs(platform, config),
    ...selectionArgs(platform, quality),
    '-o', outputTemplate,
    '--retries', '10',
    '--fragment-retries', '10',
    '--sleep-requests', '2',
    '--sleep-interval', '3',
    '--max-sleep-interval', '8',
  ];

  if (quality === 'audio') {
    args.push('-x', '--audio-format', 'm4a', '--audio-quality', '0');
  } else {
    args.push('--merge-output-format', 'mp4');
  }

  args.push(String(url));
  return args;
}

function unsupportedPlatformError(platform) {
  if (platform && !platform.supported) {
    return appError(422, 'UNSUPPORTED_PLATFORM', platform.unsupportedReason || `${platform.name} não é suportado.`);
  }
  return appError(
    422,
    'UNSUPPORTED_PLATFORM',
    'Plataforma não suportada. Use links do YouTube, Instagram, TikTok, Facebook ou X/Twitter.'
  );
}

module.exports = {
  PLATFORMS,
  QUALITIES,
  VIDEO_TARGETS,
  normalizeHostname,
  hostMatches,
  detectPlatform,
  getPlatformById,
  platformFromExtractor,
  isShortHost,
  normalizeQuality,
  getTargetResolution,
  baseFormatSelector,
  formatSort,
  selectionArgs,
  commonArgs,
  buildMetadataArgs,
  buildDownloadArgs,
  unsupportedPlatformError,
};
