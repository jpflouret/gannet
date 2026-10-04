// End-to-end test. Loads the extension in headless Chrome, opens a page
// from a local test server and downloads the detected media.
//
// Usage: node tools/e2e.mjs
// Set CHROME_PATH if Chrome is not in the default location.
// Set EXTENSION_DIR to test a different copy of the extension, for example
// the extracted ZIP from tools/pack.mjs.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const CHROME_PATHS = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

const extensionDir = path.resolve(process.env.EXTENSION_DIR || path.join(import.meta.dirname, '..'));
const workDir = mkdtempSync(path.join(tmpdir(), 'gannet-e2e-'));
const downloadDir = path.join(workDir, 'downloads');
const profileDir = path.join(workDir, 'profile');
mkdirSync(downloadDir);
mkdirSync(path.join(profileDir, 'Default'), { recursive: true });
writeFileSync(
  path.join(profileDir, 'Default', 'Preferences'),
  JSON.stringify({ download: { default_directory: downloadDir, prompt_for_download: false } }),
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------- test server

function tsSegment(marker) {
  const out = Buffer.alloc(188 * 400, marker);
  for (let i = 0; i < out.length; i += 188) out[i] = 0x47;
  return out;
}

const clip = Buffer.alloc(300 * 1024, 0x11);
const protectedClip = Buffer.alloc(350 * 1024, 0x22);
const segments = [tsSegment(1), tsSegment(2), tsSegment(3)];
const requests = [];

const PAGE = `<!doctype html><title>Gannet: e2e "test" page</title>
<video src="/media/clip.mp4" muted></video>
<video src="/protected/clip.mp4" muted></video>
<script>
  fetch('/hls/master.m3u8').then(() => fetch('/hls/media.m3u8'));
</script>`;

const MASTER = [
  '#EXTM3U',
  '#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=640x360',
  'media.m3u8?quality=low',
  '#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720',
  'media.m3u8',
  '',
].join('\n');
const MEDIA = `#EXTM3U\n#EXT-X-TARGETDURATION:6\n${segments.map((_, i) => `#EXTINF:6,\nseg${i}.ts\n`).join('')}#EXT-X-ENDLIST\n`;

const server = createServer((req, res) => {
  const referer = req.headers.referer || '';
  requests.push({ url: req.url, referer, origin: req.headers.origin || '' });
  const send = (status, type, body) => {
    res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(body) });
    res.end(body);
  };
  const fromPage = referer.startsWith(`http://localhost:${server.address().port}/`);
  const seg = /^\/hls\/seg(\d)\.ts$/.exec(req.url);
  if (req.url === '/page.html') return send(200, 'text/html', PAGE);
  if (req.url === '/media/clip.mp4') return send(200, 'video/mp4', clip);
  // The paths below need the Referer of the test page.
  if (!fromPage) return send(403, 'text/plain', 'forbidden');
  if (req.url === '/protected/clip.mp4') return send(200, 'video/mp4', protectedClip);
  if (req.url === '/hls/master.m3u8') return send(200, 'application/vnd.apple.mpegurl', MASTER);
  if (req.url.startsWith('/hls/media.m3u8')) return send(200, 'application/vnd.apple.mpegurl', MEDIA);
  if (seg && segments[seg[1]]) return send(200, 'video/mp2t', segments[seg[1]]);
  return send(404, 'text/plain', 'not found');
});
await new Promise((r) => server.listen(0, 'localhost', r));
const origin = `http://localhost:${server.address().port}`;

// ------------------------------------------- Chrome DevTools protocol

const chromePath = CHROME_PATHS.find((p) => existsSync(p));
if (!chromePath) throw new Error('Chrome was not found. Set CHROME_PATH.');

const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    '--no-first-run',
    '--disable-gpu',
    `--user-data-dir=${profileDir}`,
    '--remote-debugging-pipe',
    '--enable-unsafe-extension-debugging',
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] },
);
const toChrome = chrome.stdio[3];
const fromChrome = chrome.stdio[4];

let nextId = 0;
const pending = new Map();
let buffer = '';
fromChrome.setEncoding('utf8');
fromChrome.on('data', (data) => {
  buffer += data;
  for (let end = buffer.indexOf('\0'); end >= 0; end = buffer.indexOf('\0')) {
    const message = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    const waiter = pending.get(message.id);
    if (!waiter) continue;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(`${waiter.method}: ${message.error.message}`));
    else waiter.resolve(message.result);
  }
});

function cdp(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject, method });
    toChrome.write(`${JSON.stringify({ id, method, params, sessionId })}\0`);
  });
}

async function openPage(url) {
  const { targetId } = await cdp('Target.createTarget', { url });
  const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
  return sessionId;
}

// Runs an expression in a page and returns its JSON value.
async function evaluate(sessionId, expression) {
  const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  }
  return result.result.value;
}

async function waitFor(label, fn, timeoutMs = 20000) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`Timeout: ${label}`);
    await sleep(250);
  }
}

// --------------------------------------------------------------- test

let failed = false;
try {
  // Do not use Browser.setDownloadBehavior here. It overrides the file
  // names that the extension gives to chrome.downloads. The download
  // folder comes from the profile preferences instead.
  const { id: extensionId } = await cdp('Extensions.loadUnpacked', { path: extensionDir });
  console.log(`Extension loaded: ${extensionId}`);
  await sleep(1000);

  // Open the test page last. Chrome does not load media in background tabs.
  const ext = await openPage(`chrome-extension://${extensionId}/src/popup/popup.html`);
  await waitFor('extension page', () => evaluate(ext, `typeof chrome === 'object' && Boolean(chrome.tabs)`));
  await openPage(`${origin}/page.html`);
  const message = (data) =>
    evaluate(ext, `chrome.runtime.sendMessage(${JSON.stringify({ target: 'bg', ...data })})`);
  const tabId = await waitFor('test page tab', () =>
    evaluate(ext, `chrome.tabs.query({ url: '${origin}/*' }).then((tabs) => tabs[0]?.id)`));

  // 1. Detection.
  const state = await waitFor('media detection', async () => {
    const s = await message({ type: 'get-state', tabId });
    const hls = s.media.find((m) => m.kind === 'hls');
    return s.media.length === 3 && hls?.info ? s : null;
  });
  const names = state.media.map((m) => `${m.kind}:${new URL(m.url).pathname}`).sort();
  assert.deepEqual(names, ['file:/media/clip.mp4', 'file:/protected/clip.mp4', 'hls:/hls/master.m3u8']);
  const hls = state.media.find((m) => m.kind === 'hls');
  assert.equal(hls.info.videos[0].label, '720p - 1.0 Mbps');
  assert.equal(hls.info.duration, 18);
  assert.equal(hls.info.live, false);
  console.log('PASS detection: 2 files and 1 HLS stream. The media playlist is hidden.');

  const badge = await evaluate(ext, `chrome.action.getBadgeText({ tabId: ${tabId} })`);
  assert.equal(badge, '3');
  console.log('PASS badge shows 3');

  // 2. Downloads.
  const download = async (item, choice = {}) => {
    const { jobId, error } = await message({ type: 'download', tabId, mediaId: item.id, ...choice });
    assert.equal(error, undefined);
    return waitFor(`job ${jobId}`, async () => {
      const s = await message({ type: 'get-state', tabId });
      const job = s.jobs.find((j) => j.id === jobId);
      return job && !['preparing', 'downloading', 'saving'].includes(job.state) ? job : null;
    });
  };
  const fileOf = (pathname) => state.media.find((m) => new URL(m.url).pathname === pathname);

  const plain = await download(fileOf('/media/clip.mp4'));
  assert.equal(plain.state, 'done', plain.error);
  assert.equal(plain.fallback, false);
  console.log('PASS direct file download');

  const guarded = await download(fileOf('/protected/clip.mp4'));
  assert.equal(guarded.state, 'done', guarded.error);
  assert.equal(guarded.fallback, true);
  console.log('PASS file download that needs a Referer (engine fallback)');

  const stream = await download(hls, { videoId: hls.info.videos[0].id });
  assert.equal(stream.state, 'done', stream.error);
  assert.equal(stream.done, 3);
  console.log('PASS HLS download');

  // 3. Saved files.
  await sleep(500);
  const saved = readdirSync(downloadDir).sort();
  assert.deepEqual(saved, ['Gannet e2e test page (1).mp4', 'Gannet e2e test page.mp4', 'Gannet e2e test page.ts']);
  const read = (name) => readFileSync(path.join(downloadDir, name));
  assert.ok(read('Gannet e2e test page.mp4').equals(clip));
  assert.ok(read('Gannet e2e test page (1).mp4').equals(protectedClip));
  assert.ok(read('Gannet e2e test page.ts').equals(Buffer.concat(segments)));
  console.log('PASS saved files have the correct names and contents');

  // 4. Headers of the requests that the extension sent.
  const engineRequests = requests.filter((r) => r.url.startsWith('/hls/seg'));
  assert.equal(engineRequests.length, 3);
  for (const r of engineRequests) {
    assert.equal(r.referer, `${origin}/page.html`);
    assert.equal(r.origin, origin);
  }
  console.log('PASS engine requests have the Referer and Origin of the page');

  // 5. Popup user interface.
  const popup = await openPage(`chrome-extension://${extensionId}/src/popup/popup.html?tabId=${tabId}`);
  const ui = await waitFor('popup content', async () => {
    const v = await evaluate(popup, `({
      media: [...document.querySelectorAll('#media .card .badge')].map((n) => n.textContent),
      jobs: [...document.querySelectorAll('#jobs .card .detail.wrap')].map((n) => n.textContent),
      buttons: document.querySelectorAll('#media .card button.primary').length,
    })`);
    return v.media.length === 3 && v.jobs.length === 3 ? v : null;
  });
  assert.deepEqual(ui.media.sort(), ['HLS', 'MP4', 'MP4']);
  assert.deepEqual(ui.jobs, ['Completed', 'Completed', 'Completed']);
  assert.equal(ui.buttons, 3);
  if (process.env.E2E_SCREENSHOT) {
    await cdp('Emulation.setDeviceMetricsOverride', { width: 420, height: 560, deviceScaleFactor: 2, mobile: false }, popup);
    const shot = await cdp('Page.captureScreenshot', { format: 'png' }, popup);
    writeFileSync(process.env.E2E_SCREENSHOT, Buffer.from(shot.data, 'base64'));
  }
  console.log('PASS popup shows the media list and the downloads');

  // 6. Cleanup in the extension: no offscreen document and no header rules remain.
  const leftovers = await waitFor('cleanup', async () => {
    const v = await evaluate(ext, `Promise.all([
      chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }),
      chrome.declarativeNetRequest.getSessionRules(),
    ]).then(([contexts, rules]) => ({ contexts: contexts.length, rules: rules.length }))`);
    return v.contexts === 0 && v.rules === 0 ? v : null;
  });
  assert.deepEqual(leftovers, { contexts: 0, rules: 0 });
  console.log('PASS offscreen document closed and header rules removed');

  console.log('\nAll end-to-end checks passed.');
} catch (err) {
  failed = true;
  console.error('\nFAIL', err);
  console.error('Requests seen by the server:', requests);
  console.error('Files saved:', readdirSync(downloadDir));
} finally {
  chrome.kill();
  server.close();
  await sleep(500);
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    // Chrome can keep the profile locked for a moment. The folder is temporary.
  }
}
process.exit(failed ? 1 : 0);
