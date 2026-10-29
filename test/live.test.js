'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { loadConfig } = require('../lib/config');
const { createDownloader } = require('../lib/downloader');
const { probeMedia, extractMediaInfo } = require('../lib/media');
const { detectPlatform, buildMetadataArgs } = require('../lib/platforms');
const { resolveSafeUrl } = require('../lib/url-policy');

const RUN_LIVE = process.env.RUN_LIVE_TESTS === '1';
const YTDLP = process.env.YTDLP_PATH || 'yt-dlp';

function liveConfig() {
  const tmpRoot = fs.mkdtempSync(path.join(require('os').tmpdir(), 'isalvei-live-'));
  const config = loadConfig({
    ...process.env,
    YTDLP_PATH: YTDLP,
    TMP_DIR: tmpRoot,
    MAX_VIDEO_DURATION: '900',
    MAX_FILE_SIZE: String(150 * 1024 * 1024),
    YTDLP_MAX_ATTEMPTS: '3',
  });
  return { config, tmpRoot, downloader: createDownloader(config) };
}

async function prepareAndProbe(downloader, config, url, quality) {
  const result = await downloader.prepare(url, quality, { requestId: `live-${quality}` });
  const info = extractMediaInfo(await probeMedia(result.filePath, config), result.filePath);
  return { result, info };
}

test('LIVE: YouTube baixa e entrega MP4 H.264/AAC', { skip: !RUN_LIVE, timeout: 300000 }, async (t) => {
  const { config, tmpRoot, downloader } = liveConfig();
  t.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

  const { result, info } = await prepareAndProbe(downloader, config, 'https://youtu.be/jNQXAC9IVRw', 'best');
  t.after(() => result.cleanup());

  assert.equal(info.videoCodec, 'h264');
  assert.equal(info.audioCodec, 'aac');
  assert.equal(result.contentType, 'video/mp4');
  assert.ok(info.duration > 0);
  assert.ok(result.size > 0);
});

test('LIVE: YouTube 720/480 seleciona H.264 dentro do alvo', { skip: !RUN_LIVE, timeout: 180000 }, async () => {
  const { config, tmpRoot, downloader } = liveConfig();
  const platform = detectPlatform('https://www.youtube.com/watch?v=aqz-KE-bpKQ');
  try {
    for (const quality of ['720', '480']) {
      const args = buildMetadataArgs('https://www.youtube.com/watch?v=aqz-KE-bpKQ', platform, quality, config);
      const metadata = await downloader._internal.getMetadata(
        'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
        platform,
        quality,
        undefined,
        `live-meta-${quality}`
      );
      const selected = metadata.requested_formats && metadata.requested_formats.length
        ? metadata.requested_formats.find((format) => format.vcodec && format.vcodec !== 'none')
        : metadata;
      assert.ok(selected, `sem formato de vídeo para ${quality}`);
      assert.ok(Number(selected.height) <= Number(quality), `altura ${selected.height} > ${quality}`);
      assert.match(String(selected.vcodec), /^(avc|h264)/i, `codec ${selected.vcodec}`);
      assert.ok(args.includes(`res:${quality},vcodec:h264,acodec:m4a`));
    }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('LIVE: Instagram Reel vertical mantém 720x1280 em 720 e gera 480x854 em 480', { skip: !RUN_LIVE, timeout: 300000 }, async (t) => {
  const { config, tmpRoot, downloader } = liveConfig();
  t.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
  const url = 'https://www.instagram.com/example/reel/Dezg36US9SW/';

  const hd = await prepareAndProbe(downloader, config, url, '720');
  t.after(() => hd.result.cleanup());
  assert.equal(hd.info.width, 720);
  assert.equal(hd.info.height, 1280);
  assert.equal(hd.info.videoCodec, 'h264');

  const sd = await prepareAndProbe(downloader, config, url, '480');
  t.after(() => sd.result.cleanup());
  assert.equal(sd.info.width, 480);
  assert.equal(sd.info.height, 854);
});

test('LIVE: Instagram áudio gera m4a AAC', { skip: !RUN_LIVE, timeout: 180000 }, async (t) => {
  const { config, tmpRoot, downloader } = liveConfig();
  t.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

  const { result, info } = await prepareAndProbe(downloader, config, 'https://www.instagram.com/example/reel/Dezg36US9SW/', 'audio');
  t.after(() => result.cleanup());
  assert.equal(info.hasVideo, false);
  assert.equal(info.audioCodec, 'aac');
  assert.equal(path.extname(result.filePath), '.m4a');
});

test('LIVE: TikTok entrega H.264/AAC vertical', { skip: !RUN_LIVE, timeout: 240000 }, async (t) => {
  const { config, tmpRoot, downloader } = liveConfig();
  t.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

  const { result, info } = await prepareAndProbe(downloader, config, 'https://www.tiktok.com/@tiktok/video/6718335390845095173', 'best');
  t.after(() => result.cleanup());
  assert.equal(info.videoCodec, 'h264');
  assert.equal(info.audioCodec, 'aac');
  assert.ok(info.height > info.width);
});

test('LIVE: Facebook entrega H.264/AAC', { skip: !RUN_LIVE, timeout: 240000 }, async (t) => {
  const { config, tmpRoot, downloader } = liveConfig();
  t.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

  const { result, info } = await prepareAndProbe(downloader, config, 'https://www.facebook.com/watch/?v=10153231379946729', 'best');
  t.after(() => result.cleanup());
  assert.equal(info.videoCodec, 'h264');
  assert.equal(info.audioCodec, 'aac');
  assert.ok(info.width >= 720);
});

test('LIVE: Kwai é rejeitado antes de qualquer download', async () => {
  const config = loadConfig({});
  await assert.rejects(
    () => resolveSafeUrl('https://www.kwai.com/@user/video/123', { config }),
    (error) => error.statusCode === 422 && error.code === 'UNSUPPORTED_PLATFORM'
  );
});

test('LIVE: X/Twitter entrega H.264/AAC em MP4', { skip: !RUN_LIVE, timeout: 240000 }, async (t) => {
  const { config, tmpRoot, downloader } = liveConfig();
  t.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

  const { result, info } = await prepareAndProbe(downloader, config, 'https://x.com/NASA/status/2105842656429432894', 'best');
  t.after(() => result.cleanup());
  assert.equal(result.platform.id, 'twitter');
  assert.equal(info.videoCodec, 'h264');
  assert.equal(info.audioCodec, 'aac');
});
