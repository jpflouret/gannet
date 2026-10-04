// Converts fragmented MP4 (the format of HLS fMP4 and DASH segments) to a
// regular MP4 file. The function reads the sample tables of each fragment
// and writes one "moov" box with complete tables. Sample data is not
// decoded or copied in memory: the output Blob refers to slices of the
// input Blobs. Audio and video inputs are combined into one file.

const WINDOW = 64 * 1024;
const MAX_U32 = 0xffffffff;

export class DrmError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DrmError';
  }
}

// ------------------------------------------------------------ reading

export function fourcc(u8, off) {
  return String.fromCharCode(u8[off], u8[off + 1], u8[off + 2], u8[off + 3]);
}

const view = (u8) => new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

// Lists the boxes between start and end. "data" is the payload offset.
export function parseBoxes(u8, start = 0, end = u8.length) {
  const dv = view(u8);
  const boxes = [];
  let off = start;
  while (off + 8 <= end) {
    let size = dv.getUint32(off);
    let header = 8;
    if (size === 1) {
      if (off + 16 > end) break;
      size = Number(dv.getBigUint64(off + 8));
      header = 16;
    } else if (size === 0) {
      size = end - off;
    }
    if (size < header || off + size > end) break;
    boxes.push({ type: fourcc(u8, off + 4), start: off, end: off + size, data: off + header });
    off += size;
  }
  return boxes;
}

const childrenOf = (u8, box) => parseBoxes(u8, box.data, box.end);
const childOf = (u8, box, type) => childrenOf(u8, box).find((b) => b.type === type);
const bytesOf = (u8, box) => u8.subarray(box.start, box.end);

// Reads a Blob through a window so that small boxes need few async reads.
class BlobReader {
  constructor(blob) {
    this.blob = blob;
    this.start = 0;
    this.buf = new Uint8Array(0);
  }

  async read(off, len) {
    if (off < this.start || off + len > this.start + this.buf.length) {
      const end = Math.min(this.blob.size, off + Math.max(len, WINDOW));
      this.buf = new Uint8Array(await this.blob.slice(off, end).arrayBuffer());
      this.start = off;
    }
    const rel = off - this.start;
    return this.buf.subarray(rel, Math.min(rel + len, this.buf.length));
  }
}

async function* walkTopLevel(blob) {
  const reader = new BlobReader(blob);
  let off = 0;
  while (off + 8 <= blob.size) {
    const head = await reader.read(off, 16);
    const dv = view(head);
    let size = dv.getUint32(0);
    let header = 8;
    if (size === 1) {
      if (head.length < 16) return;
      size = Number(dv.getBigUint64(8));
      header = 16;
    } else if (size === 0) {
      size = blob.size - off;
    }
    if (size < header) return;
    const start = off;
    const length = size;
    yield { type: fourcc(head, 4), offset: start, size: length, read: () => reader.read(start, length) };
    off += size;
  }
}

// Reads the track definitions of a "moov" box. u8 holds the complete box.
function parseInit(u8) {
  const moov = parseBoxes(u8)[0];
  if (!moov || moov.type !== 'moov') throw new Error('Malformed MP4: bad moov box');
  const dv = view(u8);
  const kids = childrenOf(u8, moov);
  const mvhd = kids.find((b) => b.type === 'mvhd');
  if (!mvhd) throw new Error('Malformed MP4: no mvhd box');
  const timescale = dv.getUint32(mvhd.data + (u8[mvhd.data] === 1 ? 20 : 12));

  const trex = new Map();
  const mvex = kids.find((b) => b.type === 'mvex');
  if (mvex) {
    for (const b of childrenOf(u8, mvex)) {
      if (b.type !== 'trex') continue;
      trex.set(dv.getUint32(b.data + 4), {
        duration: dv.getUint32(b.data + 12),
        size: dv.getUint32(b.data + 16),
        flags: dv.getUint32(b.data + 20),
      });
    }
  }

  const tracks = [];
  for (const trak of kids.filter((b) => b.type === 'trak')) {
    const tkhd = childOf(u8, trak, 'tkhd');
    const mdia = childOf(u8, trak, 'mdia');
    const mdhd = mdia && childOf(u8, mdia, 'mdhd');
    const hdlr = mdia && childOf(u8, mdia, 'hdlr');
    const minf = mdia && childOf(u8, mdia, 'minf');
    const stbl = minf && childOf(u8, minf, 'stbl');
    const stsd = stbl && childOf(u8, stbl, 'stsd');
    if (!tkhd || !mdhd || !hdlr || !stsd) throw new Error('Malformed MP4: incomplete trak box');

    const format = stsd.end - stsd.data >= 16 ? fourcc(u8, stsd.data + 12) : '';
    if (format === 'encv' || format === 'enca') {
      throw new DrmError('This stream is DRM protected and cannot be downloaded.');
    }

    // Media time of the first normal edit. It removes the encoder delay.
    let mediaTime = 0;
    const edts = childOf(u8, trak, 'edts');
    const elst = edts && childOf(u8, edts, 'elst');
    if (elst) {
      const v1 = u8[elst.data] === 1;
      const count = dv.getUint32(elst.data + 4);
      let p = elst.data + 8;
      for (let i = 0; i < count && p + (v1 ? 20 : 12) <= elst.end; i++) {
        const t = v1 ? Number(dv.getBigInt64(p + 8)) : dv.getInt32(p + 4);
        if (t >= 0) {
          mediaTime = t;
          break;
        }
        p += v1 ? 20 : 12;
      }
    }

    const id = dv.getUint32(tkhd.data + (u8[tkhd.data] === 1 ? 20 : 12));
    tracks.push({
      u8,
      trak,
      id,
      timescale: dv.getUint32(mdhd.data + (u8[mdhd.data] === 1 ? 20 : 12)) || 1,
      handler: fourcc(u8, hdlr.data + 8),
      trex: trex.get(id) || { duration: 0, size: 0, flags: 0 },
      mediaTime,
      sizes: [],
      durations: [],
      ctos: [],
      sync: [],
      chunks: [],
      firstDts: null,
      nextDts: null,
    });
  }
  return { u8, mvhd, timescale: timescale || 1000, tracks };
}

// Adds the samples of one "moof" box to the tracks. u8 holds the complete
// box. moofOffset is the position of the box in its Blob.
function parseMoof(u8, moofOffset, blob, tracksById) {
  const moof = parseBoxes(u8)[0];
  if (!moof || moof.type !== 'moof') throw new Error('Malformed MP4: bad moof box');
  const dv = view(u8);
  let prevDataEnd = null;

  for (const traf of childrenOf(u8, moof)) {
    if (traf.type !== 'traf') continue;
    const kids = childrenOf(u8, traf);
    const tfhd = kids.find((b) => b.type === 'tfhd');
    if (!tfhd) continue;
    const flags = dv.getUint32(tfhd.data) & 0xffffff;
    const track = tracksById.get(dv.getUint32(tfhd.data + 4));
    if (!track) continue;

    let p = tfhd.data + 8;
    let base = null;
    if (flags & 0x1) {
      base = Number(dv.getBigUint64(p));
      p += 8;
    }
    if (flags & 0x2) p += 4;
    let defDuration = track.trex.duration;
    let defSize = track.trex.size;
    let defFlags = track.trex.flags;
    if (flags & 0x8) {
      defDuration = dv.getUint32(p);
      p += 4;
    }
    if (flags & 0x10) {
      defSize = dv.getUint32(p);
      p += 4;
    }
    if (flags & 0x20) defFlags = dv.getUint32(p);
    if (base === null) {
      base = flags & 0x20000 || prevDataEnd === null ? moofOffset : prevDataEnd;
    }

    const tfdt = kids.find((b) => b.type === 'tfdt');
    let dts = null;
    if (tfdt) {
      dts = u8[tfdt.data] === 1 ? Number(dv.getBigUint64(tfdt.data + 4)) : dv.getUint32(tfdt.data + 4);
    }
    if (track.firstDts === null) track.firstDts = dts ?? 0;
    if (dts === null) dts = track.nextDts ?? track.firstDts;
    // A gap in the timeline extends the last sample to keep audio and video in sync.
    if (track.nextDts !== null && dts > track.nextDts && track.durations.length) {
      track.durations[track.durations.length - 1] += dts - track.nextDts;
    }

    let time = dts;
    let dataPos = base;
    for (const trun of kids) {
      if (trun.type !== 'trun') continue;
      const version = u8[trun.data];
      const tf = dv.getUint32(trun.data) & 0xffffff;
      const count = dv.getUint32(trun.data + 4);
      let q = trun.data + 8;
      if (tf & 0x1) {
        dataPos = base + dv.getInt32(q);
        q += 4;
      }
      let firstFlags = null;
      if (tf & 0x4) {
        firstFlags = dv.getUint32(q);
        q += 4;
      }
      const chunkTime = time;
      let chunkSize = 0;
      for (let i = 0; i < count; i++) {
        let duration = defDuration;
        let size = defSize;
        let sampleFlags = i === 0 && firstFlags !== null ? firstFlags : defFlags;
        let cto = 0;
        if (tf & 0x100) {
          duration = dv.getUint32(q);
          q += 4;
        }
        if (tf & 0x200) {
          size = dv.getUint32(q);
          q += 4;
        }
        if (tf & 0x400) {
          sampleFlags = dv.getUint32(q);
          q += 4;
        }
        if (tf & 0x800) {
          cto = version === 0 ? dv.getUint32(q) : dv.getInt32(q);
          q += 4;
        }
        track.durations.push(duration);
        track.sizes.push(size);
        track.ctos.push(cto);
        // Bit 16 of the sample flags is sample_is_non_sync_sample.
        track.sync.push((sampleFlags & 0x10000) === 0);
        chunkSize += size;
        time += duration;
      }
      if (count) {
        track.chunks.push({
          blob,
          offset: dataPos,
          size: chunkSize,
          count,
          time: (chunkTime - track.firstDts) / track.timescale,
        });
      }
      dataPos += chunkSize;
    }
    prevDataEnd = dataPos;
    track.nextDts = time;
  }
}

// ------------------------------------------------------------ writing

function concat(parts) {
  let size = 0;
  for (const p of parts) size += p.length;
  const out = new Uint8Array(size);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export function box(type, ...parts) {
  const head = new Uint8Array(8);
  let size = 8;
  for (const p of parts) size += p.length;
  view(head).setUint32(0, size);
  for (let i = 0; i < 4; i++) head[4 + i] = type.charCodeAt(i);
  return concat([head, ...parts]);
}

// A full box whose payload is a list of 32-bit integers.
export function fullBox32(type, version, flags, values) {
  const body = new Uint8Array(4 + values.length * 4);
  const dv = view(body);
  dv.setUint32(0, ((version << 24) | flags) >>> 0);
  for (let i = 0; i < values.length; i++) dv.setUint32(4 + i * 4, values[i]);
  return box(type, body);
}

function runLength(values) {
  const out = [];
  let count = 0;
  for (let i = 0; i < values.length; i++) {
    count++;
    if (i + 1 === values.length || values[i + 1] !== values[i]) {
      out.push(count, values[i]);
      count = 0;
    }
  }
  return out;
}

function buildStbl(track, offsets, co64) {
  const { u8, trak, sizes, durations, ctos, sync, chunks } = track;
  const mdia = childOf(u8, trak, 'mdia');
  const stbl = childOf(u8, childOf(u8, mdia, 'minf'), 'stbl');
  const parts = [bytesOf(u8, childOf(u8, stbl, 'stsd'))];

  const stts = runLength(durations);
  parts.push(fullBox32('stts', 0, 0, [stts.length / 2, ...stts]));

  if (ctos.some((c) => c !== 0)) {
    const ctts = runLength(ctos);
    const version = ctos.some((c) => c < 0) ? 1 : 0;
    parts.push(fullBox32('ctts', version, 0, [ctts.length / 2, ...ctts]));
  }

  if (!sync.every(Boolean)) {
    const numbers = [];
    sync.forEach((s, i) => s && numbers.push(i + 1));
    parts.push(fullBox32('stss', 0, 0, [numbers.length, ...numbers]));
  }

  // One stsc entry for each run of chunks with the same sample count.
  const stsc = [];
  chunks.forEach((c, i) => {
    if (i === 0 || chunks[i - 1].count !== c.count) stsc.push(i + 1, c.count, 1);
  });
  parts.push(fullBox32('stsc', 0, 0, [stsc.length / 3, ...stsc]));
  parts.push(fullBox32('stsz', 0, 0, [0, sizes.length, ...sizes]));

  if (co64) {
    const body = new Uint8Array(8 + offsets.length * 8);
    const dv = view(body);
    dv.setUint32(4, offsets.length);
    offsets.forEach((o, i) => dv.setBigUint64(8 + i * 8, BigInt(o)));
    parts.push(box('co64', body));
  } else {
    parts.push(fullBox32('stco', 0, 0, [offsets.length, ...offsets]));
  }
  return box('stbl', ...parts);
}

// Copies a tkhd, mdhd or mvhd box and sets its duration. The three boxes
// have the duration at different positions, given by the count of 32-bit
// fields between the time stamps and the duration.
function withDuration(u8, b, fieldsBefore, duration, trackId = null) {
  const copy = u8.slice(b.start, b.end);
  const dv = view(copy);
  const body = b.data - b.start;
  const v1 = copy[body] === 1;
  const p = body + 4 + (v1 ? 16 : 8);
  if (trackId !== null) dv.setUint32(p, trackId);
  const at = p + fieldsBefore * 4;
  if (v1) dv.setBigUint64(at, BigInt(Math.round(duration)));
  else dv.setUint32(at, Math.min(Math.round(duration), MAX_U32));
  return copy;
}

function buildElst(delay, duration, mediaTime) {
  const entries = [];
  if (delay > 0) entries.push([delay, -1]);
  entries.push([duration, mediaTime]);
  const body = new Uint8Array(8 + entries.length * 20);
  const dv = view(body);
  body[0] = 1;
  dv.setUint32(4, entries.length);
  entries.forEach(([d, t], i) => {
    const p = 8 + i * 20;
    dv.setBigUint64(p, BigInt(d));
    dv.setBigInt64(p + 8, BigInt(t));
    dv.setUint16(p + 16, 1);
  });
  return box('edts', box('elst', body));
}

function buildTrak(track, newId, movieTimescale, delay, offsets, co64) {
  const { u8, trak } = track;
  const mediaDuration = track.durations.reduce((a, b) => a + b, 0);
  const movieDuration = Math.round((mediaDuration * movieTimescale) / track.timescale);
  track.movieDuration = movieDuration + delay;

  const mdia = childOf(u8, trak, 'mdia');
  const minf = childOf(u8, mdia, 'minf');
  const newMinf = box(
    'minf',
    ...childrenOf(u8, minf).filter((b) => b.type !== 'stbl').map((b) => bytesOf(u8, b)),
    buildStbl(track, offsets, co64),
  );
  const newMdia = box(
    'mdia',
    ...childrenOf(u8, mdia).map((b) => {
      if (b.type === 'mdhd') return withDuration(u8, b, 1, mediaDuration);
      if (b.type === 'minf') return newMinf;
      return bytesOf(u8, b);
    }),
  );
  const tkhd = withDuration(u8, childOf(u8, trak, 'tkhd'), 2, track.movieDuration, newId);
  return box('trak', tkhd, buildElst(delay, movieDuration, track.mediaTime), newMdia);
}

function buildMoov(movie, tracks, delays, offsets, co64) {
  const traks = tracks.map((t, i) => buildTrak(t, i + 1, movie.timescale, delays[i], offsets[i], co64));
  const duration = Math.max(...tracks.map((t) => t.movieDuration));
  const mvhd = withDuration(movie.u8, movie.mvhd, 1, duration);
  // next_track_ID is the last field of the mvhd box.
  view(mvhd).setUint32(mvhd.length - 4, tracks.length + 1);
  return box('moov', mvhd, ...traks);
}

// ------------------------------------------------------------- public

// inputs: [{ init: Blob | null, segments: Blob[] }]. Each input is one
// fragmented MP4 stream. Without "init", the first segment must contain
// the moov box. Returns { blob, hasVideo }.
export async function defragment(inputs) {
  const tracks = [];
  let movie = null;

  for (const input of inputs) {
    const blobs = input.init ? [input.init, ...input.segments] : input.segments;
    let byId = null;
    for (const blob of blobs) {
      for await (const b of walkTopLevel(blob)) {
        if (b.type === 'moov' && !byId) {
          const init = parseInit((await b.read()).slice());
          byId = new Map(init.tracks.map((t) => [t.id, t]));
          tracks.push(...init.tracks);
          movie ??= init;
        } else if (b.type === 'moof') {
          if (!byId) throw new Error('Malformed MP4: fragment found before the moov box');
          parseMoof(await b.read(), b.offset, blob, byId);
        }
      }
    }
    if (!byId) throw new Error('Malformed MP4: no moov box');
  }

  const used = tracks.filter((t) => t.sizes.length);
  if (!used.length) throw new Error('Malformed MP4: no samples');

  // Tracks that start later than the first track get an empty edit.
  const starts = used.map((t) => t.firstDts / t.timescale);
  const first = Math.min(...starts);
  const delays = starts.map((s) => {
    const d = s - first;
    return d > 0.001 && d < 30 ? Math.round(d * movie.timescale) : 0;
  });

  // Interleave the chunks of all tracks in time order. The order of the
  // chunks of each track does not change.
  const order = [];
  const cursor = used.map(() => 0);
  for (;;) {
    let pick = -1;
    for (let i = 0; i < used.length; i++) {
      const c = used[i].chunks[cursor[i]];
      if (c && (pick < 0 || c.time < used[pick].chunks[cursor[pick]].time)) pick = i;
    }
    if (pick < 0) break;
    order.push([pick, used[pick].chunks[cursor[pick]++]]);
  }

  let payload = 0;
  const relative = used.map(() => []);
  const slices = [];
  let last = null;
  for (const [ti, c] of order) {
    if (c.offset < 0 || c.offset + c.size > c.blob.size) {
      throw new Error('Malformed MP4: sample data is outside of the segment');
    }
    relative[ti].push(payload);
    payload += c.size;
    if (last && last.blob === c.blob && last.end === c.offset) {
      last.end += c.size;
    } else {
      last = { blob: c.blob, start: c.offset, end: c.offset + c.size };
      slices.push(last);
    }
  }

  const brands = ['isom', 'iso2', 'mp41'];
  const ftypBody = new Uint8Array(8 + brands.length * 4);
  [...`isom\0\0\x02\0${brands.join('')}`].forEach((ch, i) => (ftypBody[i] = ch.charCodeAt(0)));
  const ftyp = box('ftyp', ftypBody);

  // The size of the moov box does not depend on the offset values. Build
  // it one time to learn its size, then again with the final offsets.
  const co64 = payload + 64 * 1024 * 1024 > MAX_U32;
  const moovSize = buildMoov(movie, used, delays, relative, co64).length;
  const dataStart = ftyp.length + moovSize + 16;
  const moov = buildMoov(movie, used, delays, relative.map((list) => list.map((o) => o + dataStart)), co64);

  const mdatHead = new Uint8Array(16);
  view(mdatHead).setUint32(0, 1);
  [...'mdat'].forEach((ch, i) => (mdatHead[4 + i] = ch.charCodeAt(0)));
  view(mdatHead).setBigUint64(8, BigInt(16 + payload));

  const hasVideo = used.some((t) => t.handler === 'vide');
  const blob = new Blob([ftyp, moov, mdatHead, ...slices.map((s) => s.blob.slice(s.start, s.end))], {
    type: hasVideo ? 'video/mp4' : 'audio/mp4',
  });
  return { blob, hasVideo };
}
