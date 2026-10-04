// Popup. Shows the media of the current tab and the downloads.

import { formatBytes, formatDuration } from '../lib/util.js';

const REFRESH_INTERVAL_MS = 600;
const ACTIVE = new Set(['preparing', 'downloading', 'saving']);

const mediaRoot = document.getElementById('media');
const emptyNote = document.getElementById('empty');
const jobsSection = document.getElementById('jobs-section');
const jobsRoot = document.getElementById('jobs');

let tabId = null;
let lastMedia = '';
const choices = new Map(); // media id -> { videoId, audioId }
const jobRows = new Map(); // job id -> row

const send = (type, data = {}) => chrome.runtime.sendMessage({ target: 'bg', type, ...data });

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
}

// -------------------------------------------------------------- media

function fillSelect(select, options, selectedId) {
  select.replaceChildren(...options.map((o) => el('option', { value: o.id, textContent: o.label })));
  if (options.some((o) => o.id === selectedId)) select.value = selectedId;
  select.hidden = options.length < 2;
}

function streamControls(item, onChange) {
  const { videos, audios } = item.info;
  const choice = choices.get(item.id) || {};
  choices.set(item.id, choice);

  const videoSelect = el('select', { title: 'Quality' });
  const audioSelect = el('select', { title: 'Audio track' });
  const audiosFor = (videoId) => {
    const video = videos.find((v) => v.id === videoId);
    return audios.filter((a) => a.group === (video?.audioGroup ?? ''));
  };
  const updateAudio = () => {
    const list = audiosFor(videoSelect.value);
    const preferred = list.some((a) => a.id === choice.audioId) ? choice.audioId : list.find((a) => a.isDefault)?.id;
    fillSelect(audioSelect, list, preferred);
    choice.audioId = list.length ? audioSelect.value : null;
  };

  fillSelect(videoSelect, videos, choice.videoId);
  choice.videoId = videoSelect.value;
  updateAudio();
  videoSelect.addEventListener('change', () => {
    choice.videoId = videoSelect.value;
    updateAudio();
    onChange();
  });
  audioSelect.addEventListener('change', () => {
    choice.audioId = audioSelect.value;
  });

  const quality = () => videos.find((v) => v.id === choice.videoId)?.label || '';
  return { nodes: [videoSelect, audioSelect], choice, quality };
}

function mediaCard(item) {
  const info = item.info;
  const isFile = item.kind === 'file';
  const badge = isFile ? item.ext.toUpperCase() : item.kind.toUpperCase();
  const name = isFile ? `${item.name || 'media'}.${item.ext}` : item.name || 'stream';

  let problem = '';
  if (item.error) problem = item.error;
  else if (info?.drm) problem = 'DRM protected. Download is not possible.';
  else if (info?.live) problem = 'Live stream. Download is not supported.';
  const ready = !problem && (isFile || Boolean(info));

  const detail = el('span', { className: 'detail' });
  const updateDetail = () => {
    const parts = [];
    if (item.size) parts.push(formatBytes(item.size));
    if (info?.duration) {
      parts.push(formatDuration(info.duration));
      // The size of a stream is an estimate from its bit rate.
      const video = info.videos.find((v) => v.id === controls.choice.videoId);
      if (video?.bandwidth) parts.push(`about ${formatBytes((video.bandwidth / 8) * info.duration)}`);
    }
    if (info?.videos.length === 1 && info.videos[0].height) parts.push(`${info.videos[0].height}p`);
    parts.push(item.host);
    detail.textContent = parts.join(' - ');
  };
  const controls = ready && !isFile ? streamControls(item, updateDetail) : { nodes: [], choice: {}, quality: () => '' };
  updateDetail();

  const copy = el('button', { className: 'link', type: 'button', textContent: 'Copy URL' });
  copy.addEventListener('click', async () => {
    await navigator.clipboard.writeText(item.url);
    copy.textContent = 'Copied';
    setTimeout(() => (copy.textContent = 'Copy URL'), 1200);
  });

  const card = el(
    'div',
    { className: 'card' },
    el('div', { className: 'row' },
      el('span', { className: 'badge', textContent: badge }),
      el('span', { className: 'name', textContent: name, title: item.url })),
    el('div', { className: 'row' }, detail, copy),
  );

  if (problem) {
    card.append(el('div', { className: 'row' }, el('span', { className: 'detail wrap error', textContent: problem })));
    return card;
  }
  if (!isFile && !info) {
    card.append(el('div', { className: 'row' }, el('span', { className: 'detail', textContent: 'Reading the stream information...' })));
    return card;
  }

  const message = el('span', { className: 'detail wrap error' });
  const button = el('button', { className: 'primary', type: 'button', textContent: 'Download' });
  button.addEventListener('click', async () => {
    button.disabled = true;
    message.textContent = '';
    const res = await send('download', {
      tabId,
      mediaId: item.id,
      videoId: controls.choice.videoId ?? null,
      audioId: controls.choice.audioId ?? null,
      quality: controls.quality(),
    });
    if (res?.error) message.textContent = res.error;
    await refresh();
    button.disabled = false;
  });

  card.append(el('div', { className: 'row' }, ...controls.nodes, button));
  card.append(message);
  return card;
}

function renderMedia(media) {
  mediaRoot.replaceChildren(...media.map(mediaCard));
  emptyNote.hidden = media.length > 0;
}

// --------------------------------------------------------------- jobs

function createJobRow(job) {
  const name = el('span', { className: 'name', textContent: job.title, title: job.title });
  const quality = el('span', { className: 'detail', textContent: job.quality });
  quality.style.flex = 'none';
  const progress = el('progress', { max: 1 });
  const status = el('span', { className: 'detail wrap' });
  const button = el('button', { type: 'button' });
  const row = { job, progress, status, button };
  button.addEventListener('click', async () => {
    await send(ACTIVE.has(row.job.state) ? 'cancel' : 'show', { jobId: row.job.id });
    refresh();
  });
  row.root = el(
    'div',
    { className: 'card' },
    el('div', { className: 'row' }, name, quality),
    el('div', { className: 'row' }, progress, status, button),
  );
  row.root.dataset.id = job.id;
  return row;
}

function jobStatus(job, fraction) {
  switch (job.state) {
    case 'preparing':
      return 'Reading the stream...';
    case 'downloading': {
      const parts = [];
      if (fraction !== null) parts.push(`${Math.floor(fraction * 100)}%`);
      if (job.bytes) parts.push(formatBytes(job.bytes));
      return parts.join(' - ') || 'Starting...';
    }
    case 'saving':
      return 'Saving the file...';
    case 'done':
      return job.note || 'Completed';
    case 'canceled':
      return 'Canceled';
    default:
      return job.error || 'The download failed.';
  }
}

function updateJobRow(row, job) {
  row.job = job;
  const active = ACTIVE.has(job.state);
  let fraction = null;
  if (job.totalBytes > 0) fraction = Math.min(1, job.bytes / job.totalBytes);
  else if (job.total > 1) fraction = job.done / job.total;

  row.progress.hidden = !active;
  if (fraction === null || job.state !== 'downloading') row.progress.removeAttribute('value');
  else row.progress.value = fraction;

  row.status.textContent = jobStatus(job, fraction);
  row.status.classList.toggle('error', job.state === 'error');
  row.status.classList.toggle('ok', job.state === 'done');

  row.button.hidden = !active && job.state !== 'done';
  row.button.textContent = active ? 'Cancel' : 'Show';
}

function renderJobs(jobs) {
  jobsSection.hidden = jobs.length === 0;
  const ids = new Set(jobs.map((j) => j.id));
  for (const [id, row] of jobRows) {
    if (ids.has(id)) continue;
    row.root.remove();
    jobRows.delete(id);
  }
  for (const job of jobs) {
    let row = jobRows.get(job.id);
    if (!row) {
      row = createJobRow(job);
      jobRows.set(job.id, row);
    }
    updateJobRow(row, job);
  }
  // Move the rows only if the order changed. This keeps clicks reliable.
  const wanted = jobs.map((j) => String(j.id)).join(',');
  const current = [...jobsRoot.children].map((c) => c.dataset.id).join(',');
  if (wanted !== current) jobsRoot.replaceChildren(...jobs.map((j) => jobRows.get(j.id).root));
}

// --------------------------------------------------------------- main

async function refresh() {
  let state;
  try {
    state = await send('get-state', { tabId });
  } catch {
    return;
  }
  if (!state || state.error) return;
  const mediaJson = JSON.stringify(state.media);
  if (mediaJson !== lastMedia) {
    lastMedia = mediaJson;
    renderMedia(state.media);
  }
  renderJobs(state.jobs);
}

document.getElementById('clear-media').addEventListener('click', async () => {
  await send('clear-media', { tabId });
  refresh();
});

document.getElementById('clear-jobs').addEventListener('click', async () => {
  await send('clear-jobs');
  refresh();
});

// The end-to-end test opens this page in a tab and gives the tab id in the URL.
const tabParam = Number(new URLSearchParams(location.search).get('tabId'));
if (tabParam) {
  tabId = tabParam;
} else {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id ?? null;
}
await refresh();
setInterval(refresh, REFRESH_INTERVAL_MS);
