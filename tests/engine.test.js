import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDownload, sniff } from '../src/lib/engine.js';
import { probeManifest, planTracks, trackHosts, DRM_MESSAGE, LIVE_MESSAGE } from '../src/lib/manifest.js';

// A fake server: { url: Uint8Array | string | status number }.
function fakeFetch(routes, log = []) {
  return async (url, options = {}) => {
    log.push({ url, range: options.headers?.Range });
    const body = routes[url];
    if (body === undefined) return new Response('', { status: 404 });
    if (typeof body === 'number') return new Response('', { status: body });
    const range = /bytes=(\d+)-(\d+)/.exec(options.headers?.Range || '');
    if (range) {
      const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
      return new Response(bytes.slice(Number(range[1]), Number(range[2]) + 1), { status: 206 });
    }
    return new Response(body, { status: 200 });
  };
}

const fetchTextFrom = (routes) => async (url) => {
  const res = await fakeFetch(routes)(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
};

// A buffer that looks like MPEG-TS: sync byte 0x47 every 188 bytes.
function tsPayload(packets, marker) {
  const out = new Uint8Array(packets * 188).fill(marker);
  for (let i = 0; i < packets; i++) out[i * 188] = 0x47;
  return out;
}

async function encrypt(plain, keyBytes, iv) {
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-CBC', false, ['encrypt']);
  return new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, key, plain));
}

const bytesOf = async (blob) => new Uint8Array(await blob.arrayBuffer());

test('runDownload joins TS segments in playlist order', async () => {
  const a = tsPayload(2, 1);
  const b = tsPayload(3, 2);
  const routes = { 'https://x.test/a.ts': a, 'https://x.test/b.ts': b };
  const tracks = [{
    role: 'video',
    init: null,
    segments: [
      { url: 'https://x.test/a.ts', range: null, key: null, seq: 0 },
      { url: 'https://x.test/b.ts', range: null, key: null, seq: 1 },
    ],
  }];
  const progress = [];
  const { files } = await runDownload({ tracks, fetchImpl: fakeFetch(routes), onProgress: (p) => progress.push(p) });
  assert.equal(files.length, 1);
  assert.equal(files[0].ext, 'ts');
  assert.deepEqual(await bytesOf(files[0].blob), new Uint8Array([...a, ...b]));
  assert.deepEqual(progress.at(-1), { done: 2, total: 2, bytes: a.length + b.length, totalBytes: 0 });
});

test('runDownload decrypts AES-128 segments', async () => {
  const keyBytes = crypto.getRandomValues(new Uint8Array(16));
  const explicitIv = crypto.getRandomValues(new Uint8Array(16));
  const sequenceIv = new Uint8Array(16);
  sequenceIv[15] = 5;
  const a = tsPayload(2, 1);
  const b = tsPayload(2, 2);
  const routes = {
    'https://x.test/key': keyBytes,
    'https://x.test/a.ts': await encrypt(a, keyBytes, explicitIv),
    'https://x.test/b.ts': await encrypt(b, keyBytes, sequenceIv),
  };
  const hex = [...explicitIv].map((v) => v.toString(16).padStart(2, '0')).join('');
  const tracks = [{
    role: 'video',
    init: null,
    segments: [
      { url: 'https://x.test/a.ts', range: null, key: { url: 'https://x.test/key', iv: hex }, seq: 4 },
      { url: 'https://x.test/b.ts', range: null, key: { url: 'https://x.test/key', iv: null }, seq: 5 },
    ],
  }];
  const log = [];
  const { files } = await runDownload({ tracks, fetchImpl: fakeFetch(routes, log) });
  assert.deepEqual(await bytesOf(files[0].blob), new Uint8Array([...a, ...b]));
  assert.equal(log.filter((r) => r.url === 'https://x.test/key').length, 1);
});

test('runDownload sends byte ranges and skips an optional last segment', async () => {
  const file = tsPayload(4, 7);
  const routes = { 'https://x.test/all.ts': file };
  const tracks = [{
    role: 'video',
    init: null,
    segments: [
      { url: 'https://x.test/all.ts', range: { offset: 0, length: 376 }, key: null },
      { url: 'https://x.test/all.ts', range: { offset: 376, length: 376 }, key: null },
      { url: 'https://x.test/missing.ts', range: null, key: null, optional: true },
    ],
  }];
  const log = [];
  const { files } = await runDownload({ tracks, fetchImpl: fakeFetch(routes, log), concurrency: 1 });
  assert.deepEqual(await bytesOf(files[0].blob), file);
  assert.deepEqual(log.map((r) => r.range), ['bytes=0-375', 'bytes=376-751', undefined]);
});

test('runDownload fails on a missing segment and saves raw files as they are', async () => {
  const tracks = [{ role: 'video', init: null, segments: [{ url: 'https://x.test/gone.ts', range: null, key: null }] }];
  await assert.rejects(runDownload({ tracks, fetchImpl: fakeFetch({}) }), /HTTP 404/);

  const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const raw = [{ role: 'video', init: null, segments: [{ url: 'https://x.test/v.mp4', range: null, key: null }] }];
  const { files } = await runDownload({ tracks: raw, raw: { ext: 'mp4' }, fetchImpl: fakeFetch({ 'https://x.test/v.mp4': data }) });
  assert.equal(files[0].ext, 'mp4');
  assert.deepEqual(await bytesOf(files[0].blob), data);
});

test('runDownload stops when the signal aborts', async () => {
  const controller = new AbortController();
  const fetchImpl = (url, options) =>
    new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason)));
  const tracks = [{ role: 'video', init: null, segments: [{ url: 'https://x.test/a.ts', range: null, key: null }] }];
  const pending = runDownload({ tracks, fetchImpl, signal: controller.signal });
  controller.abort(new Error('Canceled'));
  await assert.rejects(pending, /Canceled/);
});

test('sniff identifies containers', async () => {
  assert.equal(await sniff(new Blob([tsPayload(2, 0)])), 'ts');
  assert.equal(await sniff(new Blob([new Uint8Array([0, 0, 0, 24]), 'ftypiso5'])), 'fmp4');
  assert.equal(await sniff(new Blob([new Uint8Array([0xff, 0xf1, 0x50, 0x80, 0, 0, 0, 0, 0])])), 'aac');
  assert.equal(await sniff(new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0])])), 'webm');
});

// -------------------------------------------------------- manifest.js

const MASTER = [
  '#EXTM3U',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="French",LANGUAGE="fr",URI="https://audio.test/fr.m3u8"',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="English",LANGUAGE="en",DEFAULT=YES,URI="https://audio.test/en.m3u8"',
  '#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2",AUDIO="a"',
  'low.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080,CODECS="hvc1.2.4.L123,mp4a.40.2",AUDIO="a"',
  'hevc.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",AUDIO="a"',
  'high.m3u8',
].join('\n');

const media = (name, extra = '') =>
  `#EXTM3U\n${extra}#EXTINF:6,\n${name}1.ts\n#EXTINF:4,\n${name}2.ts\n#EXT-X-ENDLIST\n`;

const HLS_ROUTES = {
  'https://v.test/master.m3u8': MASTER,
  'https://v.test/low.m3u8': media('low'),
  'https://v.test/hevc.m3u8': media('hevc'),
  'https://v.test/high.m3u8': media('high'),
  'https://audio.test/fr.m3u8': media('fr'),
  'https://audio.test/en.m3u8': media('en'),
  'https://v.test/live.m3u8': '#EXTM3U\n#EXTINF:6,\na.ts\n',
  'https://v.test/drm.m3u8': media('x', '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://k"\n'),
};

test('probeManifest lists HLS qualities with the best compatible stream first', async () => {
  const info = await probeManifest('hls', 'https://v.test/master.m3u8', fetchTextFrom(HLS_ROUTES));
  assert.equal(info.kind, 'hls');
  assert.equal(info.live, false);
  assert.equal(info.drm, false);
  assert.equal(info.duration, 10);
  assert.deepEqual(info.videos.map((v) => [v.id, v.label]), [
    ['2', '1080p - 3.0 Mbps'],
    ['1', '1080p - 4.0 Mbps - HEVC'],
    ['0', '360p - 500 kbps'],
  ]);
  assert.deepEqual(info.audios.map((a) => [a.id, a.label, a.isDefault]), [
    ['0', 'French', false],
    ['1', 'English', true],
  ]);
  assert.ok(info.children.includes('https://v.test/high.m3u8'));
  assert.ok(info.children.includes('https://audio.test/en.m3u8'));
});

test('planTracks selects the variant and the default audio rendition', async () => {
  const fetchText = fetchTextFrom(HLS_ROUTES);
  const best = await planTracks('hls', 'https://v.test/master.m3u8', fetchText, {});
  assert.deepEqual(best.map((t) => [t.role, t.segments[0].url]), [
    ['video', 'https://v.test/high1.ts'],
    ['audio', 'https://audio.test/en1.ts'],
  ]);
  const chosen = await planTracks('hls', 'https://v.test/master.m3u8', fetchText, { videoId: '0', audioId: '0' });
  assert.deepEqual(chosen.map((t) => t.segments[0].url), ['https://v.test/low1.ts', 'https://audio.test/fr1.ts']);
  const nulls = await planTracks('hls', 'https://v.test/master.m3u8', fetchText, { videoId: null, audioId: null });
  assert.deepEqual(nulls.map((t) => t.segments[0].url), ['https://v.test/high1.ts', 'https://audio.test/en1.ts']);
  assert.deepEqual(trackHosts(best).sort(), ['audio.test', 'v.test']);
});

test('live and DRM streams are reported and refused', async () => {
  const fetchText = fetchTextFrom(HLS_ROUTES);
  assert.equal((await probeManifest('hls', 'https://v.test/live.m3u8', fetchText)).live, true);
  assert.equal((await probeManifest('hls', 'https://v.test/drm.m3u8', fetchText)).drm, true);
  await assert.rejects(planTracks('hls', 'https://v.test/live.m3u8', fetchText), { message: LIVE_MESSAGE });
  await assert.rejects(planTracks('hls', 'https://v.test/drm.m3u8', fetchText), { message: DRM_MESSAGE });
});

test('probeManifest and planTracks read a DASH manifest', async () => {
  const mpd = `<MPD type="static" mediaPresentationDuration="PT8S"><Period>
    <AdaptationSet mimeType="video/mp4">
      <SegmentTemplate timescale="1" duration="4" initialization="$RepresentationID$-init.mp4" media="$RepresentationID$-$Number$.m4s"/>
      <Representation id="sd" bandwidth="800000" width="640" height="360" codecs="avc1.4d401e"/>
      <Representation id="hd" bandwidth="2500000" width="1280" height="720" codecs="avc1.64001f"/>
    </AdaptationSet>
    <AdaptationSet mimeType="audio/mp4" lang="en">
      <SegmentTemplate timescale="1" duration="4" initialization="$RepresentationID$-init.mp4" media="$RepresentationID$-$Number$.m4s"/>
      <Representation id="a64" bandwidth="64000"/>
      <Representation id="a128" bandwidth="128000"/>
    </AdaptationSet>
    <AdaptationSet mimeType="video/webm"><Representation id="vp9" bandwidth="1" height="2160"><BaseURL>v.webm</BaseURL></Representation></AdaptationSet>
  </Period></MPD>`;
  const fetchText = fetchTextFrom({ 'https://d.test/m.mpd': mpd });
  const info = await probeManifest('dash', 'https://d.test/m.mpd', fetchText);
  assert.deepEqual(info.videos.map((v) => [v.id, v.label]), [['1', '720p - 2.5 Mbps'], ['0', '360p - 800 kbps']]);
  assert.deepEqual(info.audios.map((a) => [a.id, a.isDefault]), [['2', false], ['3', true]]);
  assert.equal(info.duration, 8);

  const tracks = await planTracks('dash', 'https://d.test/m.mpd', fetchText, { videoId: '0' });
  assert.deepEqual(tracks.map((t) => [t.role, t.init.url, t.segments.length]), [
    ['video', 'https://d.test/sd-init.mp4', 2],
    ['audio', 'https://d.test/a128-init.mp4', 2],
  ]);
});
