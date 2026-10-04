import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, fileExtension, responseSize, segmentPattern, isIgnoredHost } from '../src/lib/detect.js';
import { sanitizeFilename, formatBytes, formatDuration, urlBasename, urlExtension } from '../src/lib/util.js';

test('classify finds manifests', () => {
  assert.equal(classify('https://a.com/x', 'application/vnd.apple.mpegurl'), 'hls');
  assert.equal(classify('https://a.com/x', 'application/x-mpegURL; charset=utf-8'), 'hls');
  assert.equal(classify('https://a.com/v/index.m3u8?t=1', 'text/plain'), 'hls');
  assert.equal(classify('https://a.com/v/index.m3u8', 'text/html'), null);
  assert.equal(classify('https://a.com/x', 'application/dash+xml'), 'dash');
  assert.equal(classify('https://a.com/v/stream.mpd', 'application/octet-stream'), 'dash');
});

test('classify finds media files and ignores segments', () => {
  assert.equal(classify('https://a.com/v/movie', 'video/mp4'), 'file');
  assert.equal(classify('https://a.com/v/song.mp3', 'audio/mpeg'), 'file');
  assert.equal(classify('https://a.com/v/movie.mp4', 'application/octet-stream'), 'file');
  assert.equal(classify('https://a.com/v/movie.webm', ''), 'file');
  assert.equal(classify('https://a.com/v/seg1.ts', 'video/mp2t'), null);
  assert.equal(classify('https://a.com/v/seg1.m4s', 'video/mp4'), null);
  assert.equal(classify('https://a.com/v/chunk', 'video/mp2t'), null);
  assert.equal(classify('https://a.com/page.html', 'text/html'), null);
  assert.equal(classify('https://a.com/data', 'application/octet-stream'), null);
});

test('fileExtension prefers the URL, then the content type', () => {
  assert.equal(fileExtension('https://a.com/a.webm', 'video/mp4'), 'webm');
  assert.equal(fileExtension('https://a.com/a', 'audio/mpeg'), 'mp3');
  assert.equal(fileExtension('https://a.com/a.php', 'video/x-unknown'), 'mp4');
});

test('responseSize reads the total size', () => {
  assert.equal(responseSize(200, { 'content-length': '1234' }), 1234);
  assert.equal(responseSize(206, { 'content-length': '100', 'content-range': 'bytes 0-99/5000' }), 5000);
  assert.equal(responseSize(206, { 'content-range': 'bytes 0-99/*' }), 0);
  assert.equal(responseSize(200, {}), 0);
});

test('segmentPattern is equal for numbered segments', () => {
  assert.equal(
    segmentPattern('https://a.com/v/720p/seg-12.mp4?x=1'),
    segmentPattern('https://a.com/v/720p/seg-13.mp4?x=2'),
  );
  assert.notEqual(segmentPattern('https://a.com/v/intro.mp4'), segmentPattern('https://a.com/v/movie.mp4'));
});

test('isIgnoredHost matches YouTube hosts only', () => {
  assert.equal(isIgnoredHost('www.youtube.com'), true);
  assert.equal(isIgnoredHost('r4---sn-abc.googlevideo.com'), true);
  assert.equal(isIgnoredHost('notyoutube.com'), false);
  assert.equal(isIgnoredHost('vimeo.com'), false);
});

test('sanitizeFilename removes characters that are not permitted', () => {
  assert.equal(sanitizeFilename('My: Video / Part <1>?'), 'My Video Part 1');
  assert.equal(sanitizeFilename('  ..hidden.  '), 'hidden');
  assert.equal(sanitizeFilename('CON'), '_CON');
  assert.equal(sanitizeFilename(''), 'video');
  assert.equal(sanitizeFilename('***', 'fallback'), 'fallback');
  assert.equal(sanitizeFilename('a'.repeat(300)).length, 120);
});

test('format helpers', () => {
  assert.equal(formatBytes(0), '');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(250 * 1024 * 1024), '250 MB');
  assert.equal(formatDuration(75), '1:15');
  assert.equal(formatDuration(3723), '1:02:03');
  assert.equal(urlBasename('https://a.com/v/My%20Clip.mp4?x=1'), 'My Clip');
  assert.equal(urlExtension('https://a.com/v/a.M3U8?x=1'), 'm3u8');
});
