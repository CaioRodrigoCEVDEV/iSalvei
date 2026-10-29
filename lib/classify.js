'use strict';

const { appError } = require('./errors');

function matches(text, pattern) {
  return pattern.test(text);
}

/**
 * Converte stderr do yt-dlp em um AppError com status e mensagem estáveis.
 * A ordem importa: autenticação do Instagram contém a palavra "rate-limit",
 * então precisa ser detectada antes de rate limit.
 */
function classifyYtDlpFailure(stderr, options = {}) {
  const text = String(stderr || '');
  const lower = text.toLowerCase();
  const platform = options.platform || null;
  const hasCookies = Boolean(options.hasCookies);
  const platformName = platform?.name || 'A plataforma';

  if (matches(lower, /deprecated feature:.*--no-call-home/)) {
    return appError(500, 'YTDLP_CONFIG', 'Configuração inválida do yt-dlp no servidor.', {
      details: text,
    });
  }

  if (matches(lower, /no space left|enospc|disk quota exceeded/)) {
    return appError(507, 'STORAGE_FULL', 'O servidor está sem espaço para preparar o arquivo.', {
      details: text,
    });
  }

  if (matches(lower, /ffmpeg (?:is )?not (?:found|installed)|ffprobe (?:is )?not (?:found|installed)|requested merging of multiple formats but ffmpeg/)) {
    return appError(503, 'DEPENDENCY_MISSING', 'O servidor não possui ffmpeg/ffprobe configurado corretamente.', {
      details: text,
    });
  }

  if (matches(lower, /file is larger than max-filesize|larger than max-filesize|exceeds the maximum file size/)) {
    return appError(413, 'FILE_TOO_LARGE', 'O arquivo excede o limite de tamanho permitido.');
  }

  // Uma sessão inválida do Instagram costuma virar HTML de login e o yt-dlp
  // falha ao interpretar o JSON em vez de dizer "login required".
  if (platform?.id === 'instagram' && matches(lower, /failed to parse json|login_required|checkpoint_required|challenge_required/)) {
    return appError(
      403,
      'AUTH_REQUIRED',
      hasCookies
        ? 'Sua sessão do Instagram expirou ou não tem permissão para este conteúdo. Conecte a conta novamente.'
        : 'Este conteúdo exige login no Instagram. Conecte sua conta no app ou configure COOKIES_FILE no servidor.',
      { details: text }
    );
  }

  // Login/cookies/bot check. Inclui a mensagem combinada do Instagram.
  if (matches(lower, /login required|use --cookies|--cookies-from-browser|sign in to confirm|not a bot|authentication required|empty media response|private profile|this content is private|this video is private|requested content is not available.*(?:login|rate-limit)|content is private|requires authentication|http error 40[13]|http error 401|http error 403/)) {
    const isInstagram = platform?.id === 'instagram';
    let message;

    if (hasCookies) {
      message = isInstagram
        ? 'Sua sessão do Instagram expirou ou não tem permissão para este conteúdo. Conecte a conta novamente.'
        : 'O conteúdo exige uma sessão válida. Os cookies configurados podem estar expirados ou sem permissão para este conteúdo.';
    } else if (isInstagram) {
      message = 'Este conteúdo exige login no Instagram. Conecte sua conta no app ou configure COOKIES_FILE no servidor.';
    } else {
      message = 'Este conteúdo exige login/cookies de uma conta válida. Configure COOKIES_FILE no servidor para conteúdos restritos.';
    }

    return appError(403, 'AUTH_REQUIRED', message, { details: text });
  }

  if (matches(lower, /drm|protected by drm|has_drm/)) {
    return appError(422, 'DRM_PROTECTED', 'Conteúdo protegido por DRM não pode ser baixado.');
  }

  if (matches(lower, /is live|live event|live stream|premieres in|upcoming live|will begin in/)) {
    return appError(422, 'LIVE_NOT_SUPPORTED', 'Transmissões ao vivo e estreias não são suportadas.');
  }

  if (matches(lower, /made this video available in your country|not available in your country|geo.?restrict|blocked in your country|ip address is blocked|http error 451/)) {
    return appError(403, 'GEO_BLOCKED', 'O conteúdo não está disponível para o servidor por restrição geográfica ou de IP.');
  }

  if (matches(lower, /unsupported url|no suitable extractor|no video could be found/)) {
    return appError(422, 'UNSUPPORTED_CONTENT', 'O link não contém um vídeo suportado.');
  }

  if (matches(lower, /http error 429|too many requests|rate.?limit|ratelimit/)) {
    return appError(429, 'PLATFORM_RATE_LIMITED', `${platformName} limitou temporariamente as requisições deste servidor. Tente novamente em alguns minutos.`, {
      retryable: true,
      retryAfter: 60,
      details: text,
    });
  }

  if (matches(lower, /this video is unavailable|video unavailable|has been removed|no longer available|content is not available|requested content is not available|video not available|status code 10204|does not exist|http error 404|not found/)) {
    return appError(404, 'NOT_AVAILABLE', 'O conteúdo não está disponível publicamente ou foi removido.');
  }

  if (matches(lower, /cannot parse data|could not parse|unable to extract|failed to extract/)) {
    return appError(502, 'UPSTREAM_PARSE', 'Não foi possível interpretar a página da plataforma. O conteúdo pode ter sido removido ou a plataforma mudou.', {
      details: text,
    });
  }

  if (matches(lower, /http error 5\d\d|connection reset|connection refused|temporary failure|network is unreachable|econnreset|etimedout|timed out|read timeout/)) {
    return appError(503, 'UPSTREAM_UNAVAILABLE', 'A plataforma está temporariamente indisponível. Tente novamente.', {
      retryable: true,
      retryAfter: 10,
      details: text,
    });
  }

  return appError(502, 'UPSTREAM_ERROR', 'Não foi possível obter o vídeo. Tente novamente.', {
    retryable: true,
    details: text,
  });
}

module.exports = { classifyYtDlpFailure };
