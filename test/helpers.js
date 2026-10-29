'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { loadConfig } = require('../lib/config');

const ROOT = path.resolve(__dirname, '..');
const FAKE_YTDLP = path.join(__dirname, 'fixtures', 'fake-yt-dlp.js');
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

function makeTempDir(prefix = 'isalvei-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function ensureExecutable(file) {
  fs.chmodSync(file, 0o755);
}

function makeVideo(file, options = {}) {
  const width = options.width || 320;
  const height = options.height || 240;
  const videoCodec = options.videoCodec || 'libx264';
  const audio = options.audio !== false;
  const args = [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', `color=c=black:s=${width}x${height}:r=10`,
  ];
  if (audio) args.push('-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=44100');
  args.push('-t', String(options.duration || 1));
  args.push('-c:v', videoCodec, '-pix_fmt', 'yuv420p');
  if (videoCodec === 'libvpx-vp9') args.push('-b:v', '200k');
  else args.push('-preset', 'ultrafast');
  if (audio) args.push('-c:a', 'aac', '-b:a', '64k');
  else args.push('-an');
  args.push(file);

  const result = spawnSync(FFMPEG, args, { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    return false;
  }
  return fs.existsSync(file);
}

function canRunFfmpeg() {
  const result = spawnSync(FFMPEG, ['-version'], { encoding: 'utf8' });
  return !result.error && result.status === 0;
}

function makeConfig(overrides = {}) {
  return loadConfig({
    YTDLP_PATH: FAKE_YTDLP,
    FFMPEG_PATH: FFMPEG,
    FFPROBE_PATH: process.env.FFPROBE_PATH || 'ffprobe',
    YTDLP_TIMEOUT: '5000',
    YTDLP_MAX_ATTEMPTS: '2',
    YTDLP_INITIAL_BACKOFF: '1',
    FFMPEG_TIMEOUT: '20000',
    JOB_TIMEOUT: '20000',
    MAX_VIDEO_DURATION: '600',
    MAX_FILE_SIZE: String(100 * 1024 * 1024),
    MAX_CONCURRENT_DOWNLOADS: '2',
    DOWNLOAD_QUEUE_TIMEOUT: '1000',
    LOG_LEVEL: 'silent',
    ...overrides,
  });
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value));
}

module.exports = {
  ROOT,
  FAKE_YTDLP,
  FFMPEG,
  ensureExecutable,
  makeTempDir,
  makeVideo,
  canRunFfmpeg,
  makeConfig,
  writeJson,
};
