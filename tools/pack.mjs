// Builds the ZIP file for the Chrome Web Store and for GitHub releases.
// The ZIP contains only the files that the extension needs. No dependencies.
//
// Usage: node tools/pack.mjs
// Output: dist/gannet-<version>.zip

import { deflateRawSync, crc32 } from 'node:zlib';
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const INCLUDE = ['manifest.json', 'LICENSE', 'icons', 'src'];

// All entries get the same time stamp, so the same input gives the same ZIP.
// DOS format: 2026-01-01 00:00:00.
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

// Returns the files below "relative" as paths with forward slashes, in sorted order.
function listFiles(relative) {
  const full = path.join(ROOT, relative);
  let entries;
  try {
    entries = readdirSync(full, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOTDIR') return [relative];
    throw err;
  }
  return entries
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .flatMap((e) => (e.isDirectory() ? listFiles(`${relative}/${e.name}`) : [`${relative}/${e.name}`]));
}

function zip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const name of files) {
    const data = readFileSync(path.join(ROOT, name));
    const packed = deflateRawSync(data, { level: 9 });
    const nameBytes = Buffer.from(name, 'utf8');

    // Fields that the local header and the central directory share.
    const common = Buffer.alloc(26);
    common.writeUInt16LE(20, 0); // Version needed: 2.0.
    common.writeUInt16LE(0x0800, 2); // Flags: UTF-8 file names.
    common.writeUInt16LE(8, 4); // Method: deflate.
    common.writeUInt16LE(DOS_TIME, 6);
    common.writeUInt16LE(DOS_DATE, 8);
    common.writeUInt32LE(crc32(data), 10);
    common.writeUInt32LE(packed.length, 14);
    common.writeUInt32LE(data.length, 18);
    common.writeUInt16LE(nameBytes.length, 22);
    common.writeUInt16LE(0, 24); // Extra field length.

    const localSignature = Buffer.alloc(4);
    localSignature.writeUInt32LE(0x04034b50);
    const local = Buffer.concat([localSignature, common, nameBytes, packed]);

    const head = Buffer.alloc(6);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(20, 4); // Version made by.
    const tail = Buffer.alloc(14);
    tail.writeUInt32LE(offset, 10); // Offset of the local header.
    central.push(Buffer.concat([head, common, tail, nameBytes]));

    locals.push(local);
    offset += local.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const { version } = JSON.parse(readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const files = INCLUDE.flatMap(listFiles);
const output = path.join(ROOT, 'dist', `gannet-${version}.zip`);
mkdirSync(path.dirname(output), { recursive: true });
const archive = zip(files);
writeFileSync(output, archive);
console.log(`Wrote ${path.relative(ROOT, output)}: ${files.length} files, ${(archive.length / 1024).toFixed(1)} KB`);
