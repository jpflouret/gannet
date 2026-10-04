// Turns an HLS or DASH manifest into:
//  - "info": the list of qualities that the popup shows, and
//  - "tracks": the list of segment URLs that the download engine fetches.
//
// fetchText(url) must return the response body as text.

import { parseHls, hasUnsupportedKey } from './hls.js';
import { parseMpd } from './dash.js';

export const LIVE_MESSAGE = 'Live streams are not supported.';
export const DRM_MESSAGE = 'This stream is DRM protected and cannot be downloaded.';

// Video codec families, in the order of player compatibility.
const CODECS = [
  [/avc[13]/, 'H.264'],
  [/hvc1|hev1/, 'HEVC'],
  [/vp0?9/, 'VP9'],
  [/av01/, 'AV1'],
  [/dvh1|dvhe/, 'Dolby Vision'],
];

// Index in CODECS of the video codec. 0 if the codec is H.264 or not known.
function codecRank(codecs) {
  const i = CODECS.findIndex(([re]) => re.test(codecs || ''));
  return i < 0 ? 0 : i;
}

function qualityLabel({ height, bandwidth, codecs }) {
  const parts = [];
  if (height) parts.push(`${height}p`);
  if (bandwidth) {
    parts.push(bandwidth >= 1e6 ? `${(bandwidth / 1e6).toFixed(1)} Mbps` : `${Math.round(bandwidth / 1e3)} kbps`);
  }
  const rank = codecRank(codecs);
  if (rank > 0) parts.push(CODECS[rank][1]);
  return parts.join(' - ') || 'Default';
}

// Best first: highest resolution, then the most compatible codec, then bitrate.
const byQuality = (a, b) =>
  b.height - a.height || codecRank(a.codecs) - codecRank(b.codecs) || b.bandwidth - a.bandwidth;

// ---------------------------------------------------------------- HLS

function hlsFlags(playlist) {
  return {
    live: !playlist.endList,
    duration: playlist.duration,
    drm: hasUnsupportedKey(playlist),
  };
}

const planKey = (key) => (key ? { url: key.url, iv: key.iv } : null);

function hlsTrack(playlist, role) {
  const flags = hlsFlags(playlist);
  if (flags.drm) throw new Error(DRM_MESSAGE);
  if (flags.live) throw new Error(LIVE_MESSAGE);
  if (!playlist.segments.length) throw new Error('The playlist has no segments.');
  const map = playlist.segments[0].map;
  return {
    role,
    init: map ? { url: map.url, range: map.byteRange, key: planKey(map.key), seq: 0 } : null,
    segments: playlist.segments.map((s) => ({
      url: s.url,
      range: s.byteRange,
      key: planKey(s.key),
      seq: s.seq,
    })),
  };
}

function defaultRendition(playlist, variant) {
  if (!variant.audio) return null;
  const group = playlist.renditions.filter((r) => r.type === 'AUDIO' && r.groupId === variant.audio);
  return group.find((r) => r.isDefault) || group[0] || null;
}

async function probeHls(url, fetchText) {
  const playlist = parseHls(await fetchText(url), url);
  if (!playlist.master) {
    return {
      kind: 'hls',
      ...hlsFlags(playlist),
      videos: [{ id: '0', label: 'Default', width: 0, height: 0, bandwidth: 0, audioGroup: '' }],
      audios: [],
      children: [],
    };
  }

  const seen = new Set();
  const videos = [];
  playlist.variants.forEach((v, i) => {
    // Redundant variants point to backup servers with the same quality.
    const key = `${v.height}|${v.bandwidth}|${codecRank(v.codecs)}`;
    if (seen.has(key)) return;
    seen.add(key);
    videos.push({
      id: String(i),
      label: qualityLabel(v),
      width: v.width,
      height: v.height,
      bandwidth: v.bandwidth,
      codecs: v.codecs,
      audioGroup: v.audio,
    });
  });
  videos.sort(byQuality);
  if (!videos.length) throw new Error('The playlist has no streams.');

  const audios = [];
  playlist.renditions.forEach((r, i) => {
    if (r.type !== 'AUDIO' || !r.url) return;
    audios.push({
      id: String(i),
      label: r.name || r.language || 'Audio',
      lang: r.language,
      group: r.groupId,
      isDefault: r.isDefault,
    });
  });

  // Read the best variant to learn the duration and the protection state.
  let flags = { live: false, duration: 0, drm: false };
  try {
    const best = playlist.variants[Number(videos[0].id)];
    flags = hlsFlags(parseHls(await fetchText(best.url), best.url));
  } catch {
    // The download reports the error if the variant cannot be read.
  }

  return {
    kind: 'hls',
    ...flags,
    videos,
    audios,
    children: [...playlist.variants.map((v) => v.url), ...playlist.renditions.map((r) => r.url).filter(Boolean)],
  };
}

async function planHls(url, fetchText, { videoId, audioId }) {
  const playlist = parseHls(await fetchText(url), url);
  if (!playlist.master) return [hlsTrack(playlist, 'video')];

  // An absent id selects the default. Number(null) is 0, so check first.
  const at = (list, id) => (id === null || id === undefined || id === '' ? undefined : list[Number(id)]);
  let variant = at(playlist.variants, videoId);
  if (!variant) variant = [...playlist.variants].sort(byQuality)[0];
  if (!variant) throw new Error('The playlist has no streams.');

  const tracks = [hlsTrack(parseHls(await fetchText(variant.url), variant.url), 'video')];
  const chosen = at(playlist.renditions, audioId);
  const rendition = chosen && chosen.type === 'AUDIO' ? chosen : defaultRendition(playlist, variant);
  if (rendition?.url && rendition.url !== variant.url) {
    tracks.push(hlsTrack(parseHls(await fetchText(rendition.url), rendition.url), 'audio'));
  }
  return tracks;
}

// --------------------------------------------------------------- DASH

const isMp4 = (rep) => rep.mime.includes('mp4');

function dashLists(mpd) {
  const indexed = mpd.representations.map((rep, i) => ({ rep, id: String(i) })).filter((e) => isMp4(e.rep));
  const videos = indexed.filter((e) => e.rep.kind === 'video').sort((a, b) => byQuality(a.rep, b.rep));
  const audios = indexed.filter((e) => e.rep.kind === 'audio');
  // The default audio is the best quality in the first language of the manifest.
  const lang = audios[0]?.rep.lang;
  const defaultAudio = audios
    .filter((e) => e.rep.lang === lang)
    .sort((a, b) => b.rep.bandwidth - a.rep.bandwidth)[0];
  return { videos, audios, defaultAudio };
}

async function probeDash(url, fetchText) {
  const mpd = parseMpd(await fetchText(url), url);
  const { videos, audios, defaultAudio } = dashLists(mpd);
  if (!videos.length && !audios.length) throw new Error('This DASH stream has no MP4 media.');
  return {
    kind: 'dash',
    live: mpd.live,
    duration: mpd.duration,
    drm: [...videos, ...audios].some((e) => e.rep.drm),
    videos: videos.map(({ rep, id }) => ({
      id,
      label: qualityLabel(rep),
      width: rep.width,
      height: rep.height,
      bandwidth: rep.bandwidth,
      audioGroup: '',
    })),
    audios: audios.map((e) => ({
      id: e.id,
      label: [e.rep.lang, qualityLabel(e.rep)].filter(Boolean).join(' - '),
      lang: e.rep.lang,
      group: '',
      isDefault: e === defaultAudio,
    })),
    children: [],
  };
}

function dashTrack(rep, role) {
  if (rep.drm) throw new Error(DRM_MESSAGE);
  if (!rep.segments.length) throw new Error('The manifest has no segments.');
  return { role, init: rep.init, segments: rep.segments.map((s) => ({ ...s, key: null })) };
}

async function planDash(url, fetchText, { videoId, audioId }) {
  const mpd = parseMpd(await fetchText(url), url);
  if (mpd.live) throw new Error(LIVE_MESSAGE);
  const { videos, audios, defaultAudio } = dashLists(mpd);
  const pick = (list, id) => list.find((e) => e.id === String(id));
  const video = pick(videos, videoId) || videos[0];
  const audio = pick(audios, audioId) || defaultAudio;
  const tracks = [];
  if (video) tracks.push(dashTrack(video.rep, 'video'));
  if (audio) tracks.push(dashTrack(audio.rep, 'audio'));
  if (!tracks.length) throw new Error('This DASH stream has no MP4 media.');
  return tracks;
}

// ------------------------------------------------------------- public

export function probeManifest(kind, url, fetchText) {
  return kind === 'hls' ? probeHls(url, fetchText) : probeDash(url, fetchText);
}

export function planTracks(kind, url, fetchText, choice = {}) {
  return kind === 'hls' ? planHls(url, fetchText, choice) : planDash(url, fetchText, choice);
}

// All host names that a download plan sends requests to.
export function trackHosts(tracks) {
  const hosts = new Set();
  const add = (url) => {
    try {
      hosts.add(new URL(url).hostname);
    } catch {
      // Ignore URLs that cannot be parsed. The fetch reports them later.
    }
  };
  for (const track of tracks) {
    if (track.init) add(track.init.url);
    for (const s of track.segments) {
      add(s.url);
      if (s.key) add(s.key.url);
    }
  }
  return [...hosts];
}
