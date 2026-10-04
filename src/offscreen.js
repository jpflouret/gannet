// Offscreen document. It runs the download engine and gives the result
// to the service worker as blob URLs.

import { runDownload } from './lib/engine.js';

const PROGRESS_INTERVAL_MS = 300;

const controllers = new Map(); // job id -> AbortController
const blobUrls = new Map(); // job id -> [blob URL]

const send = (type, data) => chrome.runtime.sendMessage({ target: 'bg', type, ...data }).catch(() => {});

async function startJob({ id, tracks, raw }) {
  const controller = new AbortController();
  controllers.set(id, controller);
  let lastReport = 0;
  let lastProgress = null;
  try {
    const { files, note } = await runDownload({
      tracks,
      raw,
      signal: controller.signal,
      onProgress: (p) => {
        lastProgress = p;
        const now = Date.now();
        if (now - lastReport < PROGRESS_INTERVAL_MS) return;
        lastReport = now;
        send('job-progress', { id, ...p });
      },
    });
    if (controller.signal.aborted) return;
    if (lastProgress) await send('job-progress', { id, ...lastProgress });
    // Chrome replaces the file extension if it does not agree with the
    // blob type. For example, a blob without a type is saved as ".txt".
    // The generic binary type keeps the extension that the engine selected.
    const output = files.map((f) => ({
      url: URL.createObjectURL(new Blob([f.blob], { type: 'application/octet-stream' })),
      ext: f.ext,
      suffix: f.suffix,
    }));
    blobUrls.set(id, output.map((f) => f.url));
    await send('job-output', { id, files: output, note });
  } catch (err) {
    if (!controller.signal.aborted) {
      console.error(`Job ${id} failed`, err);
      await send('job-error', { id, message: err?.message || String(err) });
    }
  } finally {
    controllers.delete(id);
  }
}

function releaseJob(id) {
  for (const url of blobUrls.get(id) || []) URL.revokeObjectURL(url);
  blobUrls.delete(id);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== 'offscreen') return false;
  switch (message.type) {
    case 'start-job':
      startJob(message);
      break;
    case 'cancel-job':
      controllers.get(message.id)?.abort(new Error('Canceled'));
      releaseJob(message.id);
      break;
    case 'release-job':
      releaseJob(message.id);
      break;
    default:
      break;
  }
  sendResponse({});
  return false;
});
