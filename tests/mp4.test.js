import { test } from 'node:test';
import assert from 'node:assert/strict';
import { box, fullBox32, parseBoxes, fourcc, defragment } from '../src/lib/mp4.js';

// ------------------------------------------------- synthetic fMP4 input

const u32 = (...values) => {
  const out = new Uint8Array(values.length * 4);
  const dv = new DataView(out.buffer);
  values.forEach((v, i) => dv.setUint32(i * 4, v));
  return out;
};
const u64 = (value) => {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(value));
  return out;
};
const ascii = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));

function initSegment({ trackId, handler, timescale, format }) {
  const mvhd = box('mvhd', u32(0, 0, 0, 1000, 0), new Uint8Array(80));
  const tkhd = box('tkhd', u32(3, 0, 0, trackId, 0, 0), new Uint8Array(60));
  const mdhd = box('mdhd', u32(0, 0, 0, timescale, 0, 0));
  const hdlr = box('hdlr', u32(0, 0), ascii(handler), new Uint8Array(13));
  const stsd = box('stsd', u32(0, 1), box(format, new Uint8Array(8)));
  const stbl = box(
    'stbl',
    stsd,
    fullBox32('stts', 0, 0, [0]),
    fullBox32('stsc', 0, 0, [0]),
    fullBox32('stsz', 0, 0, [0, 0]),
    fullBox32('stco', 0, 0, [0]),
  );
  const minf = box('minf', box(handler === 'vide' ? 'vmhd' : 'smhd', new Uint8Array(12)), stbl);
  const trak = box('trak', tkhd, box('mdia', mdhd, hdlr, minf));
  const mvex = box('mvex', box('trex', u32(0, trackId, 1, 0, 0, 0)));
  return new Blob([box('ftyp', ascii('iso5'), u32(0)), box('moov', mvhd, trak, mvex)]);
}

// samples: [{ size, duration, sync, cto, fill }]. Each sample is "size"
// bytes with the value "fill".
function mediaSegment(trackId, dts, samples) {
  const build = (dataOffset) => {
    const tfhd = box('tfhd', u32(0x20000, trackId));
    const tfdt = box('tfdt', u32(0x01000000), u64(dts));
    const rows = samples.flatMap((s) => [s.duration, s.size, s.sync ? 0x02000000 : 0x01010000, s.cto || 0]);
    const trun = box('trun', u32(0x01000f01, samples.length, dataOffset, ...rows));
    return box('moof', box('mfhd', u32(0, 1)), box('traf', tfhd, tfdt, trun));
  };
  const moof = build(build(0).length + 8);
  const payload = new Uint8Array(samples.reduce((n, s) => n + s.size, 0));
  let off = 0;
  for (const s of samples) {
    payload.fill(s.fill, off, off + s.size);
    off += s.size;
  }
  return new Blob([box('styp', ascii('msdh'), u32(0)), moof, box('mdat', payload)]);
}

// ---------------------------------------------------- output inspection

const find = (u8, parent, type) => parseBoxes(u8, parent.data, parent.end).find((b) => b.type === type);
const path = (u8, start, ...types) => types.reduce((b, t) => find(u8, b, t), start);
const table = (u8, b) => {
  const dv = new DataView(u8.buffer, u8.byteOffset + b.data, b.end - b.data);
  return Array.from({ length: (b.end - b.data) / 4 }, (_, i) => dv.getUint32(i * 4));
};

// Returns the tables of a trak and the bytes of each sample.
function readTrack(u8, trak) {
  const stbl = path(u8, trak, 'mdia', 'minf', 'stbl');
  const [, , ...sizes] = table(u8, find(u8, stbl, 'stsz')).slice(1);
  const offsets = table(u8, find(u8, stbl, 'stco')).slice(2);
  const stsc = table(u8, find(u8, stbl, 'stsc')).slice(2);
  const perChunk = offsets.map((_, chunk) => {
    let count = 0;
    for (let i = 0; i < stsc.length; i += 3) if (stsc[i] <= chunk + 1) count = stsc[i + 1];
    return count;
  });
  const samples = [];
  let n = 0;
  offsets.forEach((offset, chunk) => {
    let pos = offset;
    for (let i = 0; i < perChunk[chunk]; i++) {
      samples.push(u8.subarray(pos, pos + sizes[n]));
      pos += sizes[n++];
    }
  });
  const optional = (type) => {
    const b = find(u8, stbl, type);
    return b ? table(u8, b).slice(2) : null;
  };
  return {
    trackId: table(u8, find(u8, trak, 'tkhd'))[3],
    trackDuration: table(u8, find(u8, trak, 'tkhd'))[5],
    mediaDuration: table(u8, path(u8, trak, 'mdia', 'mdhd'))[4],
    format: fourcc(u8, find(u8, stbl, 'stsd').data + 12),
    sizes,
    samples,
    stts: table(u8, find(u8, stbl, 'stts')).slice(2),
    ctts: optional('ctts'),
    stss: optional('stss'),
  };
}

// ---------------------------------------------------------------- tests

const VIDEO = { trackId: 1, handler: 'vide', timescale: 90000, format: 'avc1' };
const AUDIO = { trackId: 1, handler: 'soun', timescale: 48000, format: 'mp4a' };

test('defragment combines video and audio fragments into one MP4', async () => {
  const video = {
    init: initSegment(VIDEO),
    segments: [
      mediaSegment(1, 0, [
        { size: 50, duration: 3000, sync: true, cto: 3000, fill: 1 },
        { size: 20, duration: 3000, sync: false, cto: 6000, fill: 2 },
        { size: 10, duration: 3000, sync: false, cto: 0, fill: 3 },
      ]),
      mediaSegment(1, 9000, [
        { size: 40, duration: 3000, sync: true, cto: 3000, fill: 4 },
        { size: 30, duration: 3000, sync: false, cto: 3000, fill: 5 },
      ]),
    ],
  };
  const audio = {
    init: initSegment(AUDIO),
    segments: [
      mediaSegment(1, 0, [
        { size: 7, duration: 1024, sync: true, fill: 101 },
        { size: 8, duration: 1024, sync: true, fill: 102 },
      ]),
      mediaSegment(1, 2048, [{ size: 9, duration: 1024, sync: true, fill: 103 }]),
    ],
  };

  const { blob, hasVideo } = await defragment([video, audio]);
  assert.equal(hasVideo, true);
  assert.equal(blob.type, 'video/mp4');

  const u8 = new Uint8Array(await blob.arrayBuffer());
  const top = parseBoxes(u8);
  assert.deepEqual(top.map((b) => b.type), ['ftyp', 'moov', 'mdat']);
  assert.equal(top[2].end, u8.length);

  const moov = top[1];
  assert.equal(find(u8, moov, 'mvex'), undefined);
  const traks = parseBoxes(u8, moov.data, moov.end).filter((b) => b.type === 'trak');
  assert.equal(traks.length, 2);

  const v = readTrack(u8, traks[0]);
  assert.equal(v.trackId, 1);
  assert.equal(v.format, 'avc1');
  assert.deepEqual(v.sizes, [50, 20, 10, 40, 30]);
  assert.deepEqual(v.samples.map((s) => [s.length, s[0], s[s.length - 1]]), [
    [50, 1, 1], [20, 2, 2], [10, 3, 3], [40, 4, 4], [30, 5, 5],
  ]);
  assert.deepEqual(v.stts, [5, 3000]);
  assert.deepEqual(v.ctts, [1, 3000, 1, 6000, 1, 0, 2, 3000]);
  assert.deepEqual(v.stss, [1, 4]);
  assert.equal(v.mediaDuration, 15000);
  // 15000 units at 90 kHz are 167 units of the 1 kHz movie time scale.
  assert.equal(v.trackDuration, 167);

  const a = readTrack(u8, traks[1]);
  assert.equal(a.trackId, 2);
  assert.equal(a.format, 'mp4a');
  assert.deepEqual(a.samples.map((s) => [s.length, s[0]]), [[7, 101], [8, 102], [9, 103]]);
  assert.equal(a.ctts, null);
  assert.equal(a.stss, null);
  assert.equal(a.mediaDuration, 3072);

  // The duration of the movie is the duration of the longest track.
  assert.equal(table(u8, find(u8, moov, 'mvhd'))[4], 167);
});

test('defragment reads a stream that has its moov box in the first segment', async () => {
  const whole = new Blob([
    initSegment(AUDIO),
    mediaSegment(1, 0, [{ size: 5, duration: 1024, sync: true, fill: 9 }]),
    mediaSegment(1, 1024, [{ size: 6, duration: 1024, sync: true, fill: 8 }]),
  ]);
  const { blob, hasVideo } = await defragment([{ init: null, segments: [whole] }]);
  assert.equal(hasVideo, false);
  const u8 = new Uint8Array(await blob.arrayBuffer());
  const moov = parseBoxes(u8)[1];
  const a = readTrack(u8, find(u8, moov, 'trak'));
  assert.deepEqual(a.samples.map((s) => [s.length, s[0]]), [[5, 9], [6, 8]]);
});

test('defragment extends a sample over a gap in the timeline', async () => {
  const input = {
    init: initSegment(AUDIO),
    segments: [
      mediaSegment(1, 0, [{ size: 5, duration: 1000, sync: true, fill: 1 }]),
      mediaSegment(1, 3000, [{ size: 5, duration: 1000, sync: true, fill: 2 }]),
    ],
  };
  const { blob } = await defragment([input]);
  const u8 = new Uint8Array(await blob.arrayBuffer());
  const a = readTrack(u8, find(u8, parseBoxes(u8)[1], 'trak'));
  assert.deepEqual(a.stts, [1, 3000, 1, 1000]);
});

test('defragment refuses encrypted tracks', async () => {
  const input = {
    init: initSegment({ ...VIDEO, format: 'encv' }),
    segments: [mediaSegment(1, 0, [{ size: 5, duration: 3000, sync: true, fill: 1 }])],
  };
  await assert.rejects(defragment([input]), { name: 'DrmError' });
});

test('defragment refuses truncated segments', async () => {
  const good = mediaSegment(1, 0, [{ size: 50, duration: 3000, sync: true, fill: 1 }]);
  const input = { init: initSegment(VIDEO), segments: [good.slice(0, good.size - 10)] };
  await assert.rejects(defragment([input]), /outside of the segment/);
});
