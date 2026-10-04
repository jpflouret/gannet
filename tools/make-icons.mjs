// Draws the extension icons and writes them as PNG files. No dependencies.
//
// Usage: node tools/make-icons.mjs

import { deflateSync, crc32 } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const SIZES = [16, 32, 48, 128];
const SAMPLES = 4; // Supersampling grid for each pixel.

const TOP = [14, 165, 233]; // Background gradient, top color.
const BOTTOM = [29, 78, 216]; // Background gradient, bottom color.
const WHITE = [255, 255, 255];

// All shapes use coordinates from 0 to 1.
function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function inTriangle(x, y, [ax, ay], [bx, by], [cx, cy]) {
  const d1 = (x - bx) * (ay - by) - (ax - bx) * (y - by);
  const d2 = (x - cx) * (by - cy) - (bx - cx) * (y - cy);
  const d3 = (x - ax) * (cy - ay) - (cx - ax) * (y - ay);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

// Returns [r, g, b, a] for one point of the icon.
function sample(x, y) {
  if (!inRoundRect(x, y, 0, 0, 1, 1, 0.22)) return [0, 0, 0, 0];
  const arrow =
    inRoundRect(x, y, 0.42, 0.16, 0.58, 0.5, 0.03) ||
    inTriangle(x, y, [0.24, 0.42], [0.76, 0.42], [0.5, 0.7]) ||
    inRoundRect(x, y, 0.22, 0.77, 0.78, 0.86, 0.04);
  if (arrow) return [...WHITE, 255];
  return [...TOP.map((c, i) => c + (BOTTOM[i] - c) * y), 255];
}

function render(size) {
  const pixels = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const sum = [0, 0, 0, 0];
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const [r, g, b, a] = sample((px + (sx + 0.5) / SAMPLES) / size, (py + (sy + 0.5) / SAMPLES) / size);
          sum[0] += r * a;
          sum[1] += g * a;
          sum[2] += b * a;
          sum[3] += a;
        }
      }
      const o = (py * size + px) * 4;
      if (sum[3] > 0) {
        pixels[o] = Math.round(sum[0] / sum[3]);
        pixels[o + 1] = Math.round(sum[1] / sum[3]);
        pixels[o + 2] = Math.round(sum[2] / sum[3]);
      }
      pixels[o + 3] = Math.round(sum[3] / (SAMPLES * SAMPLES));
    }
  }
  return pixels;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

function png(size, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // Bit depth.
  header[9] = 6; // Color type RGBA.
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of SIZES) {
  const file = new URL(`../icons/icon${size}.png`, import.meta.url);
  writeFileSync(file, png(size, render(size)));
  console.log(`Wrote icons/icon${size}.png`);
}
