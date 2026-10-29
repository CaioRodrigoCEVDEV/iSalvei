#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function getOutputTemplate() {
  return argValue('-o');
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const exitCode = Number(process.env.FAKE_EXIT || 0);
if (process.env.FAKE_MARKER) {
  fs.appendFileSync(process.env.FAKE_MARKER, process.argv.includes('--dump-single-json') ? 'metadata\n' : 'download\n');
}
const stderr = process.env.FAKE_STDERR || '';
if (stderr) process.stderr.write(stderr + '\n');
if (process.env.FAKE_SLEEP) sleepSync(Number(process.env.FAKE_SLEEP) || 1000);

if (process.argv.includes('--dump-single-json')) {
  if (exitCode !== 0) process.exit(exitCode);
  const metadata = process.env.FAKE_METADATA || JSON.stringify({
    id: 'fake-id',
    title: 'Fake video',
    duration: 2,
    ext: 'mp4',
    width: 320,
    height: 240,
    vcodec: 'h264',
    acodec: 'aac',
    filesize: 1024,
    formats: [{ format_id: '1', ext: 'mp4', vcodec: 'h264', acodec: 'aac', filesize: 1024 }],
  });
  process.stdout.write(metadata + '\n');
  process.exit(exitCode);
}

if (exitCode !== 0) process.exit(exitCode);
if (process.env.FAKE_NO_OUTPUT === '1') process.exit(0);
if (process.env.FAKE_FAIL_ONCE && !fs.existsSync(process.env.FAKE_FAIL_ONCE)) {
  fs.writeFileSync(process.env.FAKE_FAIL_ONCE, 'failed\n');
  process.stderr.write('ERROR: HTTP Error 503: Service Unavailable\n');
  process.exit(1);
}

const template = getOutputTemplate();
if (!template) {
  process.stderr.write('missing -o\n');
  process.exit(2);
}

const id = process.env.FAKE_ID || 'fake-id';
const ext = process.env.FAKE_EXT || 'mp4';
const output = template.replace('%(id)s', id).replace('%(ext)s', ext);
fs.mkdirSync(path.dirname(output), { recursive: true });

if (process.env.FAKE_COPY_FROM) {
  fs.copyFileSync(process.env.FAKE_COPY_FROM, output);
} else {
  const size = Number(process.env.FAKE_FILE_SIZE || 1024);
  fs.writeFileSync(output, Buffer.alloc(size, 0x20));
}
