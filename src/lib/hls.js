// Parser for HLS playlists (RFC 8216). Handles master and media playlists.

// Parses an attribute list such as: BANDWIDTH=1280000,CODECS="avc1.4d401f,mp4a.40.2"
export function parseAttributes(str) {
  const attrs = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(str))) {
    let value = m[2];
    if (value.startsWith('"')) value = value.slice(1, -1);
    attrs[m[1]] = value;
  }
  return attrs;
}

// Parses "length[@offset]". Without an offset, the range starts at prevEnd.
function parseByteRange(value, prevEnd) {
  const [length, offset] = value.split('@').map(Number);
  const start = Number.isFinite(offset) ? offset : prevEnd;
  return { offset: start, length };
}

export function parseHls(text, baseUrl) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length || !lines[0].startsWith('#EXTM3U')) {
    throw new Error('Not an HLS playlist');
  }
  const resolve = (u) => new URL(u, baseUrl).href;
  const out = {
    master: false,
    variants: [],
    renditions: [],
    segments: [],
    endList: false,
    mediaSequence: 0,
    duration: 0,
  };

  let pendingVariant = null;
  let key = null;
  let map = null;
  let duration = 0;
  let range = null;
  let rangeEnd = 0;
  let rangeUrl = '';

  for (const line of lines) {
    if (!line.startsWith('#')) {
      const url = resolve(line);
      if (pendingVariant) {
        out.variants.push({ ...pendingVariant, url });
        pendingVariant = null;
        continue;
      }
      let byteRange = null;
      if (range !== null) {
        byteRange = parseByteRange(range, rangeUrl === url ? rangeEnd : 0);
        rangeEnd = byteRange.offset + byteRange.length;
        rangeUrl = url;
      }
      out.segments.push({
        url,
        duration,
        byteRange,
        key,
        map,
        seq: out.mediaSequence + out.segments.length,
      });
      out.duration += duration;
      duration = 0;
      range = null;
      continue;
    }

    const m = /^#(EXT[^:]*)(?::(.*))?$/.exec(line);
    if (!m) continue;
    const tag = m[1];
    const value = m[2] || '';
    switch (tag) {
      case 'EXT-X-STREAM-INF': {
        const a = parseAttributes(value);
        const [width, height] = (a.RESOLUTION || '').split('x').map(Number);
        out.master = true;
        pendingVariant = {
          bandwidth: Number(a['AVERAGE-BANDWIDTH'] || a.BANDWIDTH) || 0,
          width: width || 0,
          height: height || 0,
          codecs: a.CODECS || '',
          audio: a.AUDIO || '',
        };
        break;
      }
      case 'EXT-X-MEDIA': {
        const a = parseAttributes(value);
        out.master = true;
        out.renditions.push({
          type: a.TYPE || '',
          groupId: a['GROUP-ID'] || '',
          name: a.NAME || '',
          language: a.LANGUAGE || '',
          isDefault: a.DEFAULT === 'YES',
          url: a.URI ? resolve(a.URI) : null,
        });
        break;
      }
      case 'EXT-X-MEDIA-SEQUENCE':
        out.mediaSequence = parseInt(value, 10) || 0;
        break;
      case 'EXTINF':
        duration = parseFloat(value) || 0;
        break;
      case 'EXT-X-BYTERANGE':
        range = value;
        break;
      case 'EXT-X-KEY': {
        const a = parseAttributes(value);
        const method = a.METHOD || 'NONE';
        if (method === 'NONE') {
          key = null;
        } else {
          key = {
            method,
            url: a.URI ? resolve(a.URI) : null,
            iv: a.IV ? a.IV.replace(/^0x/i, '') : null,
            keyFormat: a.KEYFORMAT || 'identity',
          };
        }
        break;
      }
      case 'EXT-X-MAP': {
        const a = parseAttributes(value);
        // A key tag before the map tag also encrypts the map.
        map = {
          url: resolve(a.URI),
          byteRange: a.BYTERANGE ? parseByteRange(a.BYTERANGE, 0) : null,
          key,
        };
        break;
      }
      case 'EXT-X-ENDLIST':
        out.endList = true;
        break;
      default:
        break;
    }
  }
  return out;
}

// True if a segment key needs a DRM system that this project does not support.
export function isUnsupportedKey(key) {
  return Boolean(key) && (key.method !== 'AES-128' || key.keyFormat !== 'identity' || !key.url);
}

// True if a segment of the playlist, or its map, has an unsupported key.
export function hasUnsupportedKey(playlist) {
  return playlist.segments.some((s) => isUnsupportedKey(s.key) || isUnsupportedKey(s.map?.key));
}
