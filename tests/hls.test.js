import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAttributes, parseHls, hasUnsupportedKey } from '../src/lib/hls.js';

const BASE = 'https://cdn.example.com/video/master.m3u8';

test('parseAttributes reads quoted and plain values', () => {
  const a = parseAttributes('BANDWIDTH=1280000,CODECS="avc1.4d401f,mp4a.40.2",RESOLUTION=1280x720');
  assert.deepEqual(a, { BANDWIDTH: '1280000', CODECS: 'avc1.4d401f,mp4a.40.2', RESOLUTION: '1280x720' });
});

test('parseHls rejects text that is not a playlist', () => {
  assert.throws(() => parseHls('<html></html>', BASE), /Not an HLS playlist/);
});

test('parseHls reads a master playlist', () => {
  const text = [
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",DEFAULT=YES,URI="audio/en.m3u8"',
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="sub",NAME="English",URI="sub/en.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.4d401e",AUDIO="aud"',
    'low/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=3000000,AVERAGE-BANDWIDTH=2500000,RESOLUTION=1920x1080,AUDIO="aud"',
    '/abs/high.m3u8?token=1',
  ].join('\n');
  const p = parseHls(text, BASE);
  assert.equal(p.master, true);
  assert.equal(p.variants.length, 2);
  assert.deepEqual(p.variants[0], {
    bandwidth: 800000,
    width: 640,
    height: 360,
    codecs: 'avc1.4d401e',
    audio: 'aud',
    url: 'https://cdn.example.com/video/low/index.m3u8',
  });
  assert.equal(p.variants[1].bandwidth, 2500000);
  assert.equal(p.variants[1].url, 'https://cdn.example.com/abs/high.m3u8?token=1');
  assert.equal(p.renditions.length, 2);
  assert.deepEqual(p.renditions[0], {
    type: 'AUDIO',
    groupId: 'aud',
    name: 'English',
    language: 'en',
    isDefault: true,
    url: 'https://cdn.example.com/video/audio/en.m3u8',
  });
});

test('parseHls reads segments, keys and sequence numbers', () => {
  const text = [
    '#EXTM3U',
    '#EXT-X-TARGETDURATION:6',
    '#EXT-X-MEDIA-SEQUENCE:7',
    '#EXTINF:6.0,',
    'seg7.ts',
    '#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x000102030405060708090A0B0C0D0E0F',
    '#EXTINF:4.5,',
    'seg8.ts',
    '#EXT-X-KEY:METHOD=NONE',
    '#EXTINF:2,',
    'seg9.ts',
    '#EXT-X-ENDLIST',
  ].join('\r\n');
  const p = parseHls(text, BASE);
  assert.equal(p.master, false);
  assert.equal(p.endList, true);
  assert.equal(p.duration, 12.5);
  assert.deepEqual(p.segments.map((s) => s.seq), [7, 8, 9]);
  assert.equal(p.segments[0].key, null);
  assert.deepEqual(p.segments[1].key, {
    method: 'AES-128',
    url: 'https://cdn.example.com/video/key.bin',
    iv: '000102030405060708090A0B0C0D0E0F',
    keyFormat: 'identity',
  });
  assert.equal(p.segments[2].key, null);
  assert.equal(hasUnsupportedKey(p), false);
});

test('parseHls reads byte ranges and the map', () => {
  const text = [
    '#EXTM3U',
    '#EXT-X-MAP:URI="main.mp4",BYTERANGE="700@0"',
    '#EXTINF:6,',
    '#EXT-X-BYTERANGE:1000@700',
    'main.mp4',
    '#EXTINF:6,',
    '#EXT-X-BYTERANGE:500',
    'main.mp4',
    '#EXT-X-ENDLIST',
  ].join('\n');
  const p = parseHls(text, BASE);
  assert.deepEqual(p.segments[0].map, {
    url: 'https://cdn.example.com/video/main.mp4',
    byteRange: { offset: 0, length: 700 },
    key: null,
  });
  assert.deepEqual(p.segments[0].byteRange, { offset: 700, length: 1000 });
  assert.deepEqual(p.segments[1].byteRange, { offset: 1700, length: 500 });
});

test('a playlist without an end tag is live', () => {
  const p = parseHls('#EXTM3U\n#EXTINF:6,\na.ts\n', BASE);
  assert.equal(p.endList, false);
});

test('SAMPLE-AES and DRM key formats are not supported', () => {
  const sample = parseHls('#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://key"\n#EXTINF:6,\na.ts\n#EXT-X-ENDLIST', BASE);
  assert.equal(hasUnsupportedKey(sample), true);
  const fairplay = parseHls(
    '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="k",KEYFORMAT="com.apple.streamingkeydelivery"\n#EXTINF:6,\na.ts\n#EXT-X-ENDLIST',
    BASE,
  );
  assert.equal(hasUnsupportedKey(fairplay), true);
});
