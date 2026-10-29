'use strict';

const fs = require('fs');
const path = require('path');

const { appError } = require('./errors');
const { runProcess } = require('./process');
const { getTargetResolution } = require('./platforms');

const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mkv', '.mov', '.m4v']);
const AUDIO_EXTENSIONS = new Set(['.m4a', '.mp3', '.opus', '.ogg', '.oga', '.aac', '.wav', '.webm']);

function allowedExtensionsFor(quality) {
  return quality === 'audio' ? AUDIO_EXTENSIONS : VIDEO_EXTENSIONS;
}

async function probeMedia(filePath, config, signal) {
  const result = await runProcess(config.ffprobePath, [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    filePath,
  ], {
    timeoutMs: Math.min(config.ffmpegTimeout, 30000),
    maxBuffer: 8 * 1024 * 1024,
    signal,
  });

  if (result.code !== 0) {
    throw appError(422, 'MEDIA_INVALID', 'O arquivo baixado não é um vídeo/áudio válido.', {
      details: result.stderr,
    });
  }

  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw appError(422, 'MEDIA_INVALID', 'Não foi possível validar o arquivo baixado.', {
      details: error.message,
    });
  }
}

function extractMediaInfo(probe, filePath) {
  const streams = Array.isArray(probe.streams) ? probe.streams : [];
  const video = streams.find((stream) => stream.codec_type === 'video' && !stream.disposition?.attached_pic);
  const audio = streams.find((stream) => stream.codec_type === 'audio');

  let width = Number(video?.width) || 0;
  let height = Number(video?.height) || 0;
  let rotation = 0;
  const sideData = Array.isArray(video?.side_data_list) ? video.side_data_list : [];
  const rotationData = sideData.find((item) => item && item.rotation !== undefined);
  if (rotationData) rotation = Number(rotationData.rotation) || 0;
  if (!rotation && video?.tags?.rotate) rotation = Number(video.tags.rotate) || 0;

  if (Math.abs(rotation) % 180 === 90) {
    [width, height] = [height, width];
  }

  const durationValue = Number(probe.format?.duration || video?.duration || audio?.duration);
  const stat = fs.statSync(filePath);

  return {
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    width,
    height,
    rotation,
    videoCodec: video?.codec_name || null,
    audioCodec: audio?.codec_name || null,
    duration: Number.isFinite(durationValue) ? durationValue : null,
    size: Number(probe.format?.size) || stat.size,
    formatName: probe.format?.format_name || '',
    formatLongName: probe.format?.format_long_name || '',
    ext: path.extname(filePath).toLowerCase(),
    streamCount: streams.length,
  };
}

function validateMedia(info, { quality, maxVideoDuration, maxFileSize }) {
  if (!info.streamCount) {
    throw appError(422, 'MEDIA_INVALID', 'O arquivo baixado está vazio ou inválido.');
  }

  if (quality === 'audio') {
    if (!info.hasAudio) {
      throw appError(422, 'NO_AUDIO', 'O conteúdo não possui faixa de áudio.');
    }
  } else if (!info.hasVideo) {
    throw appError(422, 'NO_VIDEO', 'O conteúdo não contém vídeo. Envie um link de vídeo/Short.');
  }

  if (Number.isFinite(info.duration) && info.duration > maxVideoDuration + 1) {
    throw appError(400, 'VIDEO_TOO_LONG', `Vídeo muito longo. Limite máximo: ${Math.floor(maxVideoDuration / 60)} minutos.`);
  }

  if (Number.isFinite(info.size) && info.size > maxFileSize) {
    throw appError(413, 'FILE_TOO_LARGE', `Arquivo muito grande para download. Limite máximo: ${Math.round(maxFileSize / (1024 * 1024))}MB.`);
  }
}

function targetDimensions(width, height, target) {
  if (!width || !height || !target) return null;
  const shortest = Math.min(width, height);
  if (shortest <= target) return null;

  const scale = target / shortest;
  const scaledWidth = Math.max(2, Math.round((width * scale) / 2) * 2);
  const scaledHeight = Math.max(2, Math.round((height * scale) / 2) * 2);
  return { width: scaledWidth, height: scaledHeight };
}

function normalizationPlan(info, quality) {
  if (quality === 'audio') return null;

  const target = getTargetResolution(quality);
  const dimensions = targetDimensions(info.width, info.height, target);
  const videoCodecOk = info.videoCodec === 'h264';
  const audioCodecOk = !info.hasAudio || info.audioCodec === 'aac';
  const containerOk = info.ext === '.mp4';

  if (!dimensions && videoCodecOk && audioCodecOk && containerOk) return null;

  return {
    target,
    dimensions,
    encodeVideo: Boolean(dimensions) || !videoCodecOk,
    encodeAudio: Boolean(info.hasAudio) && !audioCodecOk,
    remuxOnly: !dimensions && videoCodecOk && audioCodecOk && !containerOk,
  };
}

async function normalizeMedia(filePath, info, quality, config, signal) {
  const plan = normalizationPlan(info, quality);
  if (!plan) return filePath;

  const parsed = path.parse(filePath);
  const outputPath = path.join(parsed.dir, `${parsed.name}-compat.mp4`);
  const args = [
    '-y',
    '-i', filePath,
    '-map', '0:v:0?',
    '-map', '0:a:0?',
  ];

  if (plan.encodeVideo) {
    if (plan.dimensions) {
      args.push('-vf', `scale=${plan.dimensions.width}:${plan.dimensions.height}`);
    }
    args.push(
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', plan.target <= 480 ? '26' : '23',
      '-pix_fmt', 'yuv420p'
    );
  } else {
    args.push('-c:v', 'copy');
  }

  if (!info.hasAudio) {
    args.push('-an');
  } else if (plan.encodeAudio) {
    args.push('-c:a', 'aac', '-b:a', '128k');
  } else {
    args.push('-c:a', 'copy');
  }

  args.push('-movflags', '+faststart', '-map_metadata', '0', outputPath);

  const result = await runProcess(config.ffmpegPath, args, {
    timeoutMs: config.ffmpegTimeout,
    maxBuffer: 4 * 1024 * 1024,
    signal,
  });

  if (result.code !== 0) {
    throw appError(502, 'TRANSCODE_FAILED', 'Não foi possível preparar o vídeo para o formato compatível.', {
      details: result.stderr,
    });
  }

  return outputPath;
}

function mimeTypeFor(info, quality) {
  const ext = info.ext;
  if (quality === 'audio' || !info.hasVideo) {
    if (ext === '.m4a' || ext === '.mp4' || ext === '.aac') return 'audio/mp4';
    if (ext === '.mp3') return 'audio/mpeg';
    if (ext === '.ogg' || ext === '.oga' || ext === '.opus') return 'audio/ogg';
    if (ext === '.wav') return 'audio/wav';
    if (ext === '.webm') return 'audio/webm';
    return 'audio/mp4';
  }

  if (ext === '.webm') return 'video/webm';
  if (ext === '.mov') return 'video/quicktime';
  if (ext === '.mkv') return 'video/x-matroska';
  return 'video/mp4';
}

function safeFilename(title, ext, fallback = 'video') {
  const cleaned = String(title || fallback)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+|\.+$/g, '');

  const base = cleaned || fallback;
  const limited = base.length > 120 ? base.slice(0, 120).trim() : base;
  return `${limited || fallback}${ext || ''}`;
}

function contentDisposition(filename) {
  const fallback = filename
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\]/g, '_') || 'video.mp4';

  const encoded = encodeURIComponent(filename).replace(/[!'()*]/g, (char) => (
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  ));

  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

module.exports = {
  VIDEO_EXTENSIONS,
  AUDIO_EXTENSIONS,
  allowedExtensionsFor,
  probeMedia,
  extractMediaInfo,
  validateMedia,
  targetDimensions,
  normalizationPlan,
  normalizeMedia,
  mimeTypeFor,
  safeFilename,
  contentDisposition,
};
