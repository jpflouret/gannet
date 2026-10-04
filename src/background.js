// Service worker. It detects media in network responses, keeps the list
// of media for each tab, and starts and tracks downloads.

import { classify, fileExtension, responseSize, segmentPattern, isIgnoredHost } from './lib/detect.js';
import { probeManifest, planTracks, trackHosts } from './lib/manifest.js';
import { sanitizeFilename, urlBasename, hostOf } from './lib/util.js';

const REQUEST_FILTER = {
  urls: ['http://*/*', 'https://*/*'],
  types: ['media', 'xmlhttprequest', 'object', 'other'],
};
const MIN_FILE_BYTES = 200 * 1024;
const MAX_ITEMS_PER_TAB = 60;
const MAX_JOBS = 30;
const ACTIVE = new Set(['preparing', 'downloading', 'saving']);

// ------------------------------------------------------------- state

// The service worker can stop at any time. The state is kept in session
// storage and loaded again when the worker starts.
//   media:     { tabId: [item] }
//   jobs:      { jobId: job }
//   downloads: { downloadId: { jobId } }
//   seq:       source of unique ids for items, jobs and header rules
const state = { media: {}, jobs: {}, downloads: {}, seq: 1 };

const ready = chrome.storage.session.get('state').then((stored) => {
  if (stored.state) Object.assign(state, stored.state);
  // The work of a job in the "preparing" state was lost with the old worker.
  for (const job of Object.values(state.jobs)) {
    if (job.state === 'preparing') failJob(job, new Error('The download was interrupted.'));
  }
});

let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    chrome.storage.session.set({ state });
  }, 200);
}

// ----------------------------------------------------- request headers

// Many servers refuse requests that do not come from their own page. A
// session rule sets the Referer and Origin headers of the requests that
// this extension sends to the given hosts.
async function setHeaderRule(id, source, hosts) {
  const requestHeaders = [];
  if (source.referer) requestHeaders.push({ header: 'referer', operation: 'set', value: source.referer });
  if (source.origin) requestHeaders.push({ header: 'origin', operation: 'set', value: source.origin });
  if (!requestHeaders.length || !hosts.length) return;
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [id],
      addRules: [{
        id,
        priority: 1,
        action: { type: 'modifyHeaders', requestHeaders },
        condition: {
          initiatorDomains: [chrome.runtime.id],
          tabIds: [chrome.tabs.TAB_ID_NONE],
          requestDomains: hosts,
          resourceTypes: ['xmlhttprequest', 'media', 'other'],
        },
      }],
    });
  } catch (err) {
    console.warn('Could not set the header rule', err);
  }
}

function clearHeaderRule(id) {
  return chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id] }).catch(() => {});
}

// Returns a fetch function for manifests. It adds each new host to the
// header rule before the first request to that host.
function fetchContext(ruleId, source) {
  const hosts = new Set();
  return {
    hosts,
    async fetchText(url) {
      const host = hostOf(url);
      if (host && !hosts.has(host)) {
        hosts.add(host);
        await setHeaderRule(ruleId, source, [...hosts]);
      }
      let res;
      try {
        res = await fetch(url, { credentials: 'include' });
      } catch {
        throw Object.assign(new Error('The stream could not be read (network error).'), { network: true });
      }
      if (!res.ok) {
        throw Object.assign(new Error(`The stream could not be read (HTTP ${res.status}).`), { network: true });
      }
      return res.text();
    },
  };
}

// --------------------------------------------------------- detection

// Referer of each request in progress, by request id.
const referers = new Map();

// Segment patterns seen for each tab. See isSegmentSpam().
const patterns = new Map();

chrome.webRequest.onSendHeaders.addListener(
  (d) => {
    if (d.tabId < 0) return;
    const referer = d.requestHeaders?.find((h) => h.name.toLowerCase() === 'referer')?.value;
    if (!referer) return;
    if (referers.size > 2000) referers.clear();
    referers.set(d.requestId, referer);
  },
  REQUEST_FILTER,
  ['requestHeaders', 'extraHeaders'],
);

chrome.webRequest.onErrorOccurred.addListener((d) => referers.delete(d.requestId), REQUEST_FILTER);

chrome.webRequest.onHeadersReceived.addListener(
  (d) => {
    // A redirect keeps its request id. Keep the Referer for the final response.
    if (d.statusCode >= 300 && d.statusCode < 400) return;
    const referer = referers.get(d.requestId);
    referers.delete(d.requestId);
    if (d.tabId < 0 || (d.statusCode !== 200 && d.statusCode !== 206)) return;

    const headers = {};
    for (const h of d.responseHeaders || []) headers[h.name.toLowerCase()] = h.value || '';
    const kind = classify(d.url, headers['content-type']);
    if (!kind) return;
    if (isIgnoredHost(hostOf(d.url)) || isIgnoredHost(hostOf(d.initiator || ''))) return;
    const size = responseSize(d.statusCode, headers);
    if (kind === 'file' && size && size < MIN_FILE_BYTES) return;

    ready.then(() => addMedia(d, kind, headers['content-type'] || '', size, referer));
  },
  REQUEST_FILTER,
  ['responseHeaders'],
);

// Players that use Media Source Extensions fetch many small numbered
// files. Three files with the same URL pattern are segments, not videos.
function isSegmentSpam(tabId, url) {
  let tab = patterns.get(tabId);
  if (!tab) patterns.set(tabId, (tab = new Map()));
  const key = segmentPattern(url);
  const seen = tab.get(key);
  if (seen === true) return true;
  const paths = seen || new Set();
  paths.add(url.split('?')[0]);
  tab.set(key, paths.size >= 3 ? true : paths);
  return paths.size >= 3;
}

function addMedia(d, kind, contentType, size, referer) {
  const tabId = d.tabId;
  const list = state.media[tabId] || (state.media[tabId] = []);
  const viaXhr = d.type !== 'media';

  if (kind === 'file' && viaXhr && isSegmentSpam(tabId, d.url)) {
    const pattern = segmentPattern(d.url);
    state.media[tabId] = list.filter((i) => !(i.kind === 'file' && i.viaXhr && segmentPattern(i.url) === pattern));
    updateBadge(tabId);
    save();
    return;
  }

  // The query of a file URL frequently holds a token that changes.
  const key = kind === 'file' ? d.url.split('?')[0] : d.url;
  const existing = list.find((i) => i.key === key);
  if (existing) {
    if (size > existing.size) {
      existing.size = size;
      save();
    }
    return;
  }

  const origin = /^https?:/.test(d.initiator || '') ? d.initiator : '';
  const item = {
    id: state.seq++,
    tabId,
    key,
    url: d.url,
    kind,
    viaXhr,
    // The size of a manifest is not the size of its media.
    size: kind === 'file' ? size : 0,
    ext: kind === 'file' ? fileExtension(d.url, contentType) : '',
    referer: referer || (origin ? `${origin}/` : ''),
    origin,
    info: null,
    error: '',
  };
  if (list.length >= MAX_ITEMS_PER_TAB) list.shift();
  list.push(item);
  updateBadge(tabId);
  save();
  if (kind !== 'file') probe(item);
}

// Reads a manifest to learn the available qualities.
async function probe(item) {
  const ruleId = state.seq++;
  try {
    const ctx = fetchContext(ruleId, item);
    item.info = await probeManifest(item.kind, item.url, ctx.fetchText);
  } catch (err) {
    if (err.network) {
      item.error = err.message;
    } else {
      // The response was not a manifest. Remove the item.
      const list = state.media[item.tabId];
      if (list) state.media[item.tabId] = list.filter((i) => i !== item);
    }
  } finally {
    clearHeaderRule(ruleId);
  }
  updateBadge(item.tabId);
  save();
}

// Media playlists that belong to a detected master playlist are hidden.
function visibleMedia(tabId) {
  const list = state.media[tabId] || [];
  const children = new Set();
  for (const item of list) {
    for (const url of item.info?.children || []) children.add(url);
  }
  return list.filter((item) => !children.has(item.url));
}

function updateBadge(tabId) {
  const count = visibleMedia(tabId).length;
  chrome.action.setBadgeText({ tabId, text: count ? String(count) : '' }).catch(() => {});
}

chrome.action.setBadgeBackgroundColor({ color: '#0b6bcb' });

function forgetTab(tabId) {
  delete state.media[tabId];
  patterns.delete(tabId);
  save();
}

chrome.webNavigation.onCommitted.addListener((d) => {
  if (d.frameId === 0) ready.then(() => forgetTab(d.tabId));
});

chrome.tabs.onRemoved.addListener((tabId) => ready.then(() => forgetTab(tabId)));

// -------------------------------------------------- offscreen document

// The offscreen document runs the download engine. A service worker
// cannot create the blob URL that chrome.downloads needs.
let creating = null;

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  creating ||= chrome.offscreen
    .createDocument({
      url: 'src/offscreen.html',
      reasons: ['BLOBS'],
      justification: 'Assembles the downloaded media segments into one file.',
    })
    .finally(() => {
      creating = null;
    });
  await creating;
}

async function toOffscreen(message) {
  if (!(await hasOffscreen())) return;
  try {
    await chrome.runtime.sendMessage({ target: 'offscreen', ...message });
  } catch {
    // The document closed before it received the message.
  }
}

async function closeOffscreenIfIdle() {
  const busy = Object.values(state.jobs).some((j) => j.engine === 'offscreen' && ACTIVE.has(j.state));
  if (!busy && (await hasOffscreen())) await chrome.offscreen.closeDocument().catch(() => {});
}

// --------------------------------------------------------------- jobs

function trimJobs() {
  const jobs = Object.values(state.jobs).sort((a, b) => a.id - b.id);
  for (const job of jobs) {
    if (Object.keys(state.jobs).length <= MAX_JOBS) break;
    if (!ACTIVE.has(job.state)) delete state.jobs[job.id];
  }
}

// Sets the final state of a job and releases its resources.
function finishJob(job, finalState, error = '') {
  if (!ACTIVE.has(job.state)) return;
  job.state = finalState;
  job.error = error;
  save();
  clearHeaderRule(job.id);
  if (job.engine === 'offscreen') {
    toOffscreen({ type: 'release-job', id: job.id }).then(closeOffscreenIfIdle);
  }
}

function failJob(job, err) {
  finishJob(job, 'error', err?.message || String(err));
}

async function startDownload({ tabId, mediaId, videoId, audioId, quality }) {
  const item = (state.media[tabId] || []).find((i) => i.id === mediaId);
  if (!item) throw new Error('The media is no longer available. Reload the page.');
  let title = '';
  try {
    title = (await chrome.tabs.get(tabId)).title || '';
  } catch {
    // The tab is closed. Use the name from the URL.
  }
  const job = {
    id: state.seq++,
    title: sanitizeFilename(title, sanitizeFilename(urlBasename(item.url))),
    kind: item.kind,
    quality: quality || '',
    engine: item.kind === 'file' ? 'browser' : 'offscreen',
    state: 'preparing',
    done: 0,
    total: 0,
    bytes: 0,
    totalBytes: 0,
    error: '',
    note: '',
    files: [],
    pending: 0,
    fallback: false,
    source: { url: item.url, referer: item.referer, origin: item.origin, ext: item.ext },
  };
  state.jobs[job.id] = job;
  trimJobs();
  save();
  runJob(job, { videoId, audioId });
  return { jobId: job.id };
}

async function runJob(job, choice) {
  try {
    if (job.kind === 'file') {
      const id = await chrome.downloads.download({
        url: job.source.url,
        filename: `${job.title}.${job.source.ext}`,
        conflictAction: 'uniquify',
      });
      state.downloads[id] = { jobId: job.id };
      job.files = [id];
      job.pending = 1;
      job.state = 'downloading';
      save();
      return;
    }
    const ctx = fetchContext(job.id, job.source);
    const tracks = await planTracks(job.kind, job.source.url, ctx.fetchText, choice);
    if (job.state !== 'preparing') {
      // The user canceled the job. The plan can have set the rule again.
      clearHeaderRule(job.id);
      return;
    }
    await startEngine(job, tracks, null, [...ctx.hosts]);
  } catch (err) {
    failJob(job, err);
  }
}

async function startEngine(job, tracks, raw, hosts = []) {
  job.engine = 'offscreen';
  await setHeaderRule(job.id, job.source, [...new Set([...hosts, ...trackHosts(tracks)])]);
  await ensureOffscreen();
  job.state = 'downloading';
  save();
  await chrome.runtime.sendMessage({ target: 'offscreen', type: 'start-job', id: job.id, tracks, raw });
}

// The browser download of a file failed, for example because the server
// requires a Referer header. Fetch the file with the engine as a fallback.
async function retryWithEngine(job) {
  job.fallback = true;
  job.files = [];
  job.bytes = 0;
  job.totalBytes = 0;
  const tracks = [{ role: 'video', init: null, segments: [{ url: job.source.url, range: null, key: null }] }];
  try {
    await startEngine(job, tracks, { ext: job.source.ext });
  } catch (err) {
    failJob(job, err);
  }
}

async function saveBlob(url, filename, fallbackName) {
  try {
    return await chrome.downloads.download({ url, filename, conflictAction: 'uniquify' });
  } catch {
    // Chrome refused the file name. Use a name with safe characters only.
    return chrome.downloads.download({ url, filename: fallbackName, conflictAction: 'uniquify' });
  }
}

// The engine completed. Save its blob URLs to the downloads folder.
async function saveOutput(job, files, note) {
  job.state = 'saving';
  job.note = note || '';
  job.pending = files.length;
  job.files = [];
  save();
  try {
    for (const f of files) {
      const id = await saveBlob(f.url, `${job.title}${f.suffix}.${f.ext}`, `gannet-${job.id}${f.suffix}.${f.ext}`);
      state.downloads[id] = { jobId: job.id };
      job.files.push(id);
    }
    save();
  } catch (err) {
    failJob(job, err);
  }
}

chrome.downloads.onChanged.addListener(async (delta) => {
  await ready;
  const ref = state.downloads[delta.id];
  if (!ref || !delta.state) return;
  const job = state.jobs[ref.jobId];
  const current = delta.state.current;
  if (current !== 'complete' && current !== 'interrupted') return;
  delete state.downloads[delta.id];
  save();
  if (!job || !ACTIVE.has(job.state)) return;

  if (current === 'complete') {
    job.pending--;
    if (job.pending <= 0) finishJob(job, 'done');
    return;
  }
  const reason = delta.error?.current || 'unknown error';
  if (reason === 'USER_CANCELED') {
    finishJob(job, 'canceled');
  } else if (job.engine === 'browser' && !job.fallback) {
    chrome.downloads.erase({ id: delta.id }).catch(() => {});
    await retryWithEngine(job);
  } else {
    failJob(job, new Error(`The browser could not save the file (${reason}).`));
  }
});

async function cancelJob(id) {
  const job = state.jobs[id];
  if (!job || !ACTIVE.has(job.state)) return;
  const downloads = job.files;
  if (job.engine === 'offscreen') await toOffscreen({ type: 'cancel-job', id });
  finishJob(job, 'canceled');
  for (const downloadId of downloads) chrome.downloads.cancel(downloadId).catch(() => {});
}

// Updates the progress of browser downloads and finds lost engine jobs.
async function refreshJobs() {
  let offscreen = null;
  for (const job of Object.values(state.jobs)) {
    if (!ACTIVE.has(job.state)) continue;
    if (job.engine === 'browser') {
      if (!job.files.length) continue;
      const [d] = await chrome.downloads.search({ id: job.files[0] });
      if (d) {
        job.bytes = d.bytesReceived;
        job.totalBytes = d.totalBytes > 0 ? d.totalBytes : 0;
      }
    } else if (job.state !== 'preparing') {
      offscreen ??= await hasOffscreen();
      if (!offscreen) failJob(job, new Error('The download was interrupted.'));
    }
  }
}

// ----------------------------------------------------------- messages

function publicItem(item) {
  const info = item.info && { ...item.info, children: undefined };
  return {
    id: item.id,
    kind: item.kind,
    url: item.url,
    host: hostOf(item.url),
    name: urlBasename(item.url),
    size: item.size,
    ext: item.ext,
    info,
    error: item.error,
  };
}

function publicJob(job) {
  const { source, ...rest } = job;
  return rest;
}

const handlers = {
  async 'get-state'({ tabId }) {
    await refreshJobs();
    return {
      media: visibleMedia(tabId).map(publicItem),
      jobs: Object.values(state.jobs).sort((a, b) => b.id - a.id).map(publicJob),
    };
  },
  download: startDownload,
  async cancel({ jobId }) {
    await cancelJob(jobId);
  },
  async show({ jobId }) {
    const job = state.jobs[jobId];
    if (job?.files.length) chrome.downloads.show(job.files[0]);
  },
  async 'clear-jobs'() {
    for (const job of Object.values(state.jobs)) {
      if (!ACTIVE.has(job.state)) delete state.jobs[job.id];
    }
    save();
  },
  async 'clear-media'({ tabId }) {
    forgetTab(tabId);
    updateBadge(tabId);
  },

  // Messages from the offscreen document.
  async 'job-progress'({ id, done, total, bytes, totalBytes }) {
    const job = state.jobs[id];
    if (job?.state !== 'downloading') return;
    Object.assign(job, { done, total, bytes, totalBytes });
    save();
  },
  async 'job-output'({ id, files, note }) {
    const job = state.jobs[id];
    if (job?.state !== 'downloading') {
      await toOffscreen({ type: 'release-job', id });
      return;
    }
    await saveOutput(job, files, note);
  },
  async 'job-error'({ id, message }) {
    const job = state.jobs[id];
    if (job) failJob(job, new Error(message));
  },
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== 'bg' || !handlers[message.type]) return false;
  ready
    .then(() => handlers[message.type](message))
    .then((result) => sendResponse(result ?? {}))
    .catch((err) => sendResponse({ error: err?.message || String(err) }));
  return true;
});
