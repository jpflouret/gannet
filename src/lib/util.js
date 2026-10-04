// Small helpers shared by the service worker, the popup and the tests.

const RESERVED_NAMES = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

// Makes a string safe to use as a file name on Windows, macOS and Linux.
export function sanitizeFilename(name, fallback = 'video') {
  let s = String(name ?? '')
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  s = s.replace(/^\.+/, '').trim();
  if (s.length > 120) s = s.slice(0, 120);
  s = s.replace(/[. ]+$/, '');
  if (RESERVED_NAMES.test(s)) s = `_${s}`;
  return s || fallback;
}

export function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (v) => String(v).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

// Lower-case extension of the URL path, without the dot. Empty if none.
export function urlExtension(url) {
  try {
    const m = /\.([a-z0-9]{1,5})$/i.exec(new URL(url).pathname);
    return m ? m[1].toLowerCase() : '';
  } catch {
    return '';
  }
}

// Last path segment of the URL without its extension.
export function urlBasename(url) {
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop() || '';
    let name = last;
    try {
      name = decodeURIComponent(last);
    } catch {
      // Keep the raw segment when it is not valid percent-encoding.
    }
    return name.replace(/\.[a-z0-9]{1,5}$/i, '');
  } catch {
    return '';
  }
}

export function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}
