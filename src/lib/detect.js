// Decides if a network response is media that the user can download.

import { urlExtension } from './util.js';

const FILE_EXTS = new Set([
  'mp4', 'm4v', 'webm', 'mkv', 'mov', 'flv', 'avi', 'wmv', '3gp', 'ogv',
  'mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wav', 'flac', 'weba',
]);

// Pieces of a segmented stream. The manifest is the useful item, not these.
const SEGMENT_EXTS = new Set(['ts', 'm4s', 'm4f', 'cmfv', 'cmfa', 'cmft']);
const SEGMENT_TYPES = new Set(['video/mp2t', 'video/iso.segment', 'audio/iso.segment']);

const GENERIC_TYPES = new Set(['', 'application/octet-stream', 'binary/octet-stream', 'application/mp4']);

const MIME_EXT = {
  'video/mp4': 'mp4',
  'video/x-m4v': 'm4v',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/x-matroska': 'mkv',
  'video/x-flv': 'flv',
  'video/ogg': 'ogv',
  'video/3gpp': '3gp',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/webm': 'weba',
  'audio/flac': 'flac',
};

// The Chrome Web Store policy does not permit downloads from YouTube.
const IGNORED_HOSTS = /(^|\.)(youtube\.com|youtube-nocookie\.com|youtu\.be|googlevideo\.com)$/i;

export function isIgnoredHost(host) {
  return IGNORED_HOSTS.test(host || '');
}

// Returns 'hls', 'dash', 'file' or null.
export function classify(url, contentType) {
  const ct = (contentType || '').split(';')[0].trim().toLowerCase();
  const ext = urlExtension(url);
  if (ct.includes('mpegurl')) return 'hls';
  if (ct === 'application/dash+xml') return 'dash';
  if (ext === 'm3u8' && !ct.startsWith('text/html')) return 'hls';
  if (ext === 'mpd' && !ct.startsWith('text/html')) return 'dash';
  if (SEGMENT_EXTS.has(ext) || SEGMENT_TYPES.has(ct)) return null;
  if (ct.startsWith('video/') || ct.startsWith('audio/')) return 'file';
  if (FILE_EXTS.has(ext) && GENERIC_TYPES.has(ct)) return 'file';
  return null;
}

export function fileExtension(url, contentType) {
  const ext = urlExtension(url);
  if (FILE_EXTS.has(ext)) return ext;
  const ct = (contentType || '').split(';')[0].trim().toLowerCase();
  return MIME_EXT[ct] || 'mp4';
}

// Full size of the resource in bytes, or 0 if the server did not report it.
export function responseSize(statusCode, headers) {
  if (statusCode === 206) {
    const m = /\/(\d+)\s*$/.exec(headers['content-range'] || '');
    return m ? Number(m[1]) : 0;
  }
  const n = Number(headers['content-length']);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// URLs of numbered stream segments differ only in their digits. This key
// is the same for all segments of one stream.
export function segmentPattern(url) {
  try {
    const u = new URL(url);
    return u.origin + u.pathname.replace(/\d+/g, '#');
  } catch {
    return url;
  }
}
