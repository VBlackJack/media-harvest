/*
 * Copyright 2026 Julien Bombled
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST_DIR = path.join(ROOT_DIR, 'dist');

const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i += 1) {
  let c = i;
  for (let j = 0; j < 8; j += 1) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC_TABLE[i] = c >>> 0;
}

/**
 * Computes standard 32-bit CRC checksum for a Buffer.
 * @param {Buffer} buffer
 * @returns {number}
 */
function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Recursively collects file entries from a directory.
 * @param {string} dir
 * @param {string} baseRel
 * @returns {Array<{ relPath: string, absPath: string }>}
 */
function collectFiles(dir, baseRel = '') {
  const entries = [];
  if (!fs.existsSync(dir)) {
    return entries;
  }
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const itemRel = baseRel ? `${baseRel}/${item.name}` : item.name;
    const absPath = path.join(dir, item.name);
    if (item.isDirectory()) {
      entries.push(...collectFiles(absPath, itemRel));
    } else if (item.isFile()) {
      entries.push({ relPath: itemRel, absPath });
    }
  }
  return entries;
}

/**
 * Encodes a collection of files into a standard ZIP archive Buffer.
 * @param {Array<{ zipPath: string, data: Buffer }>} files
 * @returns {Buffer}
 */
function createZipBuffer(files) {
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  for (const file of files) {
    const rawData = file.data;
    const rawCrc = crc32(rawData);
    const uncompressedSize = rawData.length;

    const deflated = zlib.deflateRawSync(rawData);
    const useDeflate = deflated.length < uncompressedSize;
    const compressedData = useDeflate ? deflated : rawData;
    const compressionMethod = useDeflate ? 8 : 0;
    const compressedSize = compressedData.length;

    const nameBuffer = Buffer.from(file.zipPath, 'utf8');

    // Local file header (30 bytes + name length)
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); // signature
    localHeader.writeUInt16LE(20, 4);         // version needed to extract (2.0)
    localHeader.writeUInt16LE(0, 6);          // general purpose bit flag
    localHeader.writeUInt16LE(compressionMethod, 8);
    localHeader.writeUInt16LE(0, 10);         // last mod file time
    localHeader.writeUInt16LE(0, 12);         // last mod file date
    localHeader.writeUInt32LE(rawCrc, 14);
    localHeader.writeUInt32LE(compressedSize, 18);
    localHeader.writeUInt32LE(uncompressedSize, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28);         // extra field length

    const localRecord = Buffer.concat([localHeader, nameBuffer, compressedData]);
    localChunks.push(localRecord);

    // Central directory header (46 bytes + name length)
    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0); // signature
    centralHeader.writeUInt16LE(20, 4);          // version made by
    centralHeader.writeUInt16LE(20, 6);          // version needed
    centralHeader.writeUInt16LE(0, 8);           // flag
    centralHeader.writeUInt16LE(compressionMethod, 10);
    centralHeader.writeUInt16LE(0, 12);          // time
    centralHeader.writeUInt16LE(0, 14);          // date
    centralHeader.writeUInt32LE(rawCrc, 16);
    centralHeader.writeUInt32LE(compressedSize, 20);
    centralHeader.writeUInt32LE(uncompressedSize, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt16LE(0, 30);          // extra field length
    centralHeader.writeUInt16LE(0, 32);          // comment length
    centralHeader.writeUInt16LE(0, 34);          // disk number start
    centralHeader.writeUInt16LE(0, 36);          // internal file attributes
    centralHeader.writeUInt32LE(0, 38);          // external file attributes
    centralHeader.writeUInt32LE(offset, 42);     // relative offset of local header

    centralChunks.push(Buffer.concat([centralHeader, nameBuffer]));
    offset += localRecord.length;
  }

  const centralDirBuffer = Buffer.concat(centralChunks);
  const centralDirOffset = offset;
  const centralDirSize = centralDirBuffer.length;

  // End of central directory record (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);                     // disk number
  eocd.writeUInt16LE(0, 6);                     // disk with start of central dir
  eocd.writeUInt16LE(files.length, 8);          // total entries on this disk
  eocd.writeUInt16LE(files.length, 10);         // total entries
  eocd.writeUInt32LE(centralDirSize, 12);       // size of central directory
  eocd.writeUInt32LE(centralDirOffset, 16);     // offset of start of central dir
  eocd.writeUInt16LE(0, 20);                    // zip comment length

  return Buffer.concat([...localChunks, centralDirBuffer, eocd]);
}

/**
 * Packages the extension into a distributable zip archive.
 */
export function packageExtension() {
  const manifestPath = path.join(ROOT_DIR, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error('Missing manifest.json');
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const version = manifest.version || '1.0.0';

  const includeRoots = ['_locales', 'assets', 'src'];
  const zipEntries = [];

  // Add manifest.json at zip root
  zipEntries.push({
    zipPath: 'manifest.json',
    data: fs.readFileSync(manifestPath)
  });

  // Collect files from included directories
  for (const root of includeRoots) {
    const fullRoot = path.join(ROOT_DIR, root);
    const files = collectFiles(fullRoot, root);
    for (const file of files) {
      zipEntries.push({
        zipPath: file.relPath.replace(/\\/g, '/'),
        data: fs.readFileSync(file.absPath)
      });
    }
  }

  if (!fs.existsSync(DIST_DIR)) {
    fs.mkdirSync(DIST_DIR, { recursive: true });
  }

  const zipBuffer = createZipBuffer(zipEntries);
  const zipFileName = `media-harvest-v${version}.zip`;
  const zipFilePath = path.join(DIST_DIR, zipFileName);
  fs.writeFileSync(zipFilePath, zipBuffer);

  const hash = crypto.createHash('sha256').update(zipBuffer).digest('hex');

  console.log(`Packaged ${zipEntries.length} files -> ${zipFilePath}`);
  console.log(`Size: ${(zipBuffer.length / 1024).toFixed(1)} KB`);
  console.log(`SHA-256: ${hash}`);

  return {
    version,
    zipFilePath,
    fileCount: zipEntries.length,
    byteLength: zipBuffer.length,
    sha256: hash
  };
}

if (process.argv[1] && process.argv[1].endsWith('package_extension.mjs')) {
  packageExtension();
}
