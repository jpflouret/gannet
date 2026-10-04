// Download engine. Fetches all segments of a plan, decrypts AES-128
// segments and assembles the output files. It uses only web platform APIs
// (fetch, Blob, WebCrypto), so it runs in the offscreen document and in
// Node.js.

import { defragment } from './mp4.js';

const RETRIES = 3;
const FLUSH_BYTES = 16 * 1024 * 1024;

class HttpError extends Error {
  constructor(status) {
    super(`The server returned HTTP ${status}.`);
    this.status = status;
  }
}

function hexToBytes(hex) {
  const s = hex.padStart(32, '0').slice(-32);
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// Without an explicit IV, HLS uses the media sequence number of the segment.
function sequenceIv(seq) {
  const iv = new Uint8Array(16);
  new DataView(iv.buffer).setBigUint64(8, BigInt(seq));
  return iv;
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });

// Reads the body into a Blob. Large bodies are moved to Blobs in steps so
// that the browser can store them on disk.
async function readBody(res, onBytes) {
  const reader = res.body.getReader();
  const blobs = [];
  let chunks = [];
  let pending = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    pending += value.byteLength;
    onBytes(value.byteLength);
    if (pending >= FLUSH_BYTES) {
      blobs.push(new Blob(chunks));
      chunks = [];
      pending = 0;
    }
  }
  return new Blob([...blobs, ...chunks]);
}

// Identifies the container format from the first bytes of a Blob.
export async function sniff(blob) {
  const b = new Uint8Array(await blob.slice(0, 1024).arrayBuffer());
  if (b.length < 8) return 'unknown';
  const tag = String.fromCharCode(b[4], b[5], b[6], b[7]);
  if (['ftyp', 'styp', 'moov', 'moof', 'sidx', 'emsg', 'prft', 'free'].includes(tag)) return 'fmp4';
  if (b[0] === 0x47 && (b.length <= 188 || b[188] === 0x47)) return 'ts';
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'webm';
  // Packed audio starts with an optional ID3 tag, then ADTS or MPEG frames.
  let p = 0;
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33 && b.length >= 10) {
    p = 10 + ((b[6] & 0x7f) << 21) + ((b[7] & 0x7f) << 14) + ((b[8] & 0x7f) << 7) + (b[9] & 0x7f);
  }
  if (p + 1 < b.length && b[p] === 0xff) {
    if ((b[p + 1] & 0xf6) === 0xf0) return 'aac';
    if ((b[p + 1] & 0xe0) === 0xe0) return 'mp3';
  }
  return p > 0 ? 'aac' : 'unknown';
}

const EXTENSIONS = { ts: 'ts', aac: 'aac', mp3: 'mp3', webm: 'webm' };

// options:
//   tracks      [{ role, init, segments }] from manifest.js
//   raw         { ext } to save the single segment of the plan as it is
//   signal      AbortSignal that cancels the download
//   onProgress  called with { done, total, bytes, totalBytes }
// Returns { files: [{ blob, ext, suffix }], note }.
export async function runDownload({ tracks, raw = null, signal, onProgress = () => {}, concurrency = 6, fetchImpl = fetch }) {
  const internal = new AbortController();
  const combined = signal ? AbortSignal.any([signal, internal.signal]) : internal.signal;
  const progress = { done: 0, total: 0, bytes: 0, totalBytes: 0 };
  for (const t of tracks) progress.total += t.segments.length + (t.init ? 1 : 0);
  // A plan with one request for each track shows progress in bytes.
  const singleFiles = progress.total === tracks.length;
  const keys = new Map();
  const emit = () => onProgress({ ...progress });

  async function fetchOnce(part) {
    const headers = {};
    if (part.range) {
      headers.Range = `bytes=${part.range.offset}-${part.range.offset + part.range.length - 1}`;
    }
    const res = await fetchImpl(part.url, { headers, credentials: 'include', signal: combined });
    if (!res.ok) throw new HttpError(res.status);
    const length = Number(res.headers.get('content-length'));
    if (singleFiles && length > 0) progress.totalBytes += length;
    let counted = 0;
    try {
      let blob = await readBody(res, (n) => {
        counted += n;
        progress.bytes += n;
        emit();
      });
      // A server that ignores the Range header returns the complete file.
      if (part.range && res.status === 200 && blob.size > part.range.length) {
        blob = blob.slice(part.range.offset, part.range.offset + part.range.length);
      }
      return blob;
    } catch (err) {
      progress.bytes -= counted;
      if (singleFiles && length > 0) progress.totalBytes -= length;
      throw err;
    }
  }

  async function fetchPart(part) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fetchOnce(part);
      } catch (err) {
        if (combined.aborted) throw combined.reason;
        const status = err instanceof HttpError ? err.status : 0;
        if (part.optional && status === 404) return null;
        const permanent = status >= 400 && status < 500 && status !== 408 && status !== 429;
        if (permanent || attempt >= RETRIES) throw err;
        await sleep(500 * 2 ** attempt, combined);
      }
    }
  }

  function loadKey(url) {
    if (!keys.has(url)) {
      keys.set(url, (async () => {
        const raw = await (await fetchPart({ url })).arrayBuffer();
        if (raw.byteLength !== 16) throw new Error('The decryption key is not valid.');
        return crypto.subtle.importKey('raw', raw, 'AES-CBC', false, ['decrypt']);
      })());
    }
    return keys.get(url);
  }

  async function fetchSegment(seg) {
    let blob = await fetchPart(seg);
    if (blob && seg.key) {
      const key = await loadKey(seg.key.url);
      const iv = seg.key.iv ? hexToBytes(seg.key.iv) : sequenceIv(seg.seq);
      const plain = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, await blob.arrayBuffer());
      blob = new Blob([plain]);
    }
    progress.done++;
    emit();
    return blob;
  }

  async function fetchTrack(track) {
    const init = track.init ? await fetchSegment(track.init) : null;
    const blobs = new Array(track.segments.length);
    let next = 0;
    const worker = async () => {
      while (next < blobs.length) {
        const i = next++;
        blobs[i] = await fetchSegment(track.segments[i]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, blobs.length) }, worker));
    return { role: track.role, init, segments: blobs.filter(Boolean) };
  }

  try {
    const results = [];
    for (const track of tracks) results.push(await fetchTrack(track));
    for (const r of results) {
      if (!r.segments.length) throw new Error('The download returned no data.');
    }
    if (raw) {
      return { files: [{ blob: results[0].segments[0], ext: raw.ext, suffix: '' }], note: '' };
    }
    return await assemble(results);
  } catch (err) {
    internal.abort(err);
    throw err;
  }
}

async function assemble(results) {
  const kinds = await Promise.all(results.map((r) => sniff(r.init || r.segments[0])));
  let note = '';

  if (kinds.every((k) => k === 'fmp4')) {
    try {
      const { blob, hasVideo } = await defragment(results);
      return { files: [{ blob, ext: hasVideo ? 'mp4' : 'm4a', suffix: '' }], note };
    } catch (err) {
      if (err.name === 'DrmError') throw err;
      note = 'The MP4 conversion failed. The original segments were saved.';
    }
  }

  // No conversion is available: save each track as it is.
  const files = results.map((r, i) => {
    const parts = r.init ? [r.init, ...r.segments] : r.segments;
    let ext = EXTENSIONS[kinds[i]];
    if (!ext) ext = kinds[i] === 'fmp4' ? (r.role === 'audio' ? 'm4a' : 'mp4') : 'bin';
    return { blob: new Blob(parts), ext, suffix: i === 0 ? '' : '.audio' };
  });
  if (files.length > 1 && !note) {
    note = 'Audio and video are separate in this stream. They were saved as two files.';
  }
  return { files, note };
}
