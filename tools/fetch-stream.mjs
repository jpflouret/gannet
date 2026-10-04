// Downloads an HLS or DASH stream with the same code that the extension
// uses. This is a development tool to test the engine without a browser.
//
// Usage: node tools/fetch-stream.mjs <manifest-url> [output-name] [--lowest]

import { writeFile } from 'node:fs/promises';
import { classify } from '../src/lib/detect.js';
import { probeManifest, planTracks } from '../src/lib/manifest.js';
import { runDownload } from '../src/lib/engine.js';

const args = process.argv.slice(2);
const lowest = args.includes('--lowest');
const [url, output = 'output'] = args.filter((a) => !a.startsWith('--'));
if (!url) {
  console.error('Usage: node tools/fetch-stream.mjs <manifest-url> [output-name] [--lowest]');
  process.exit(1);
}

const fetchText = async (u) => {
  const res = await fetch(u);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${u}`);
  return res.text();
};

const kind = classify(url, '');
if (kind !== 'hls' && kind !== 'dash') {
  console.error('The URL must end in .m3u8 or .mpd');
  process.exit(1);
}

const info = await probeManifest(kind, url, fetchText);
console.log(`${kind.toUpperCase()} duration=${Math.round(info.duration)}s live=${info.live} drm=${info.drm}`);
for (const v of info.videos) console.log(`  video ${v.id}: ${v.label}`);
for (const a of info.audios) console.log(`  audio ${a.id}: ${a.label}${a.isDefault ? ' (default)' : ''}`);

const video = lowest ? info.videos[info.videos.length - 1] : info.videos[0];
const tracks = await planTracks(kind, url, fetchText, { videoId: video?.id });
console.log(`Plan: ${tracks.map((t) => `${t.role} ${t.segments.length} segments`).join(', ')}`);

let lastLog = 0;
const { files, note } = await runDownload({
  tracks,
  onProgress: (p) => {
    if (Date.now() - lastLog < 1000) return;
    lastLog = Date.now();
    console.log(`  ${p.done}/${p.total} segments, ${(p.bytes / 1e6).toFixed(1)} MB`);
  },
});
if (note) console.log(`Note: ${note}`);
for (const f of files) {
  const name = `${output}${f.suffix}.${f.ext}`;
  await writeFile(name, Buffer.from(await f.blob.arrayBuffer()));
  console.log(`Saved ${name} (${(f.blob.size / 1e6).toFixed(1)} MB)`);
}
