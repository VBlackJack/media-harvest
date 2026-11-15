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

import { DEFAULT_FILENAMES, LIMITS, ZIP_COMPRESSIBLE_EXTENSIONS, ZIP_RENAME_MODES } from '../config/constants.js';

const ZIP_LOCAL_HEADER_SIG = 0x04034b50;
const ZIP_CENTRAL_HEADER_SIG = 0x02014b50;
const ZIP_EOCD_SIG = 0x06054b50;
const ZIP_UTF8_FLAG = 0x0800;
const ZIP_METHOD_STORE = 0;
const ZIP_METHOD_DEFLATE = 8;
const ZIP_VERSION_EXTRACT = 20;
const ZIP_VERSION_MADE_BY = 20;
const COMPRESSIBLE_EXT_SET = new Set(ZIP_COMPRESSIBLE_EXTENSIONS);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
})();

const utf8Encoder = new TextEncoder();

/**
 * Computes IEEE 802.3 CRC32 checksum for a byte buffer.
 * @param {Uint8Array} bytes
 * @returns {number}
 */
export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Encodes a Date instance into MS-DOS time and date packed 16-bit integers.
 * @param {Date} [date=new Date()]
 * @returns {{ dosTime: number, dosDate: number }}
 */
function encodeDosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = Math.floor(date.getSeconds() / 2);
  const dosTime = ((hours & 0x1f) << 11) | ((minutes & 0x3f) << 5) | (seconds & 0x1f);
  const dosDate = (((year - 1980) & 0x7f) << 9) | ((month & 0x0f) << 5) | (day & 0x1f);
  return { dosTime, dosDate };
}

/**
 * Normalizes a ZIP archive entry filename and avoids collisions within an archive.
 * @param {string} rawName
 * @param {number} index
 * @param {Set<string>} usedNames
 * @returns {string}
 */
export function sanitizeZipEntryName(rawName, index, usedNames = new Set()) {
  const cleaned = String(rawName || '')
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    .replace(/[\x00-\x1f\x7f<>:"|?*]/g, '_')
    .replace(/^\.+/, '')
    .trim();

  const fallback = `${DEFAULT_FILENAMES.BASE}_${index + 1}.${DEFAULT_FILENAMES.FALLBACK_EXT}`;
  const baseName = cleaned || fallback;
  const dotIdx = baseName.lastIndexOf('.');
  const rawStem = dotIdx > 0 ? baseName.slice(0, dotIdx) : baseName;
  const rawExt = dotIdx > 0 ? baseName.slice(dotIdx) : '';
  const maxStemLen = Math.max(8, LIMITS.MAX_FILENAME_LENGTH - rawExt.length - 6);
  const stem = rawStem.slice(0, maxStemLen) || `${DEFAULT_FILENAMES.BASE}_${index + 1}`;

  let candidate = `${stem}${rawExt}`;
  let suffix = 2;
  while (usedNames.has(candidate.toLowerCase())) {
    candidate = `${stem}_${suffix}${rawExt}`;
    suffix += 1;
  }
  usedNames.add(candidate.toLowerCase());
  return candidate;
}

/**
 * Converts supported binary payloads into a Uint8Array view.
 * @param {Uint8Array | ArrayBuffer | ArrayBufferView} data
 * @returns {Uint8Array}
 */
function toUint8Array(data) {
  if (data instanceof Uint8Array) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return new Uint8Array(0);
}

/**
 * Extracts lowercase file extension from a sanitized filename.
 * @param {string} filename
 * @returns {string}
 */
function extractExtension(filename) {
  const dotIdx = filename.lastIndexOf('.');
  return dotIdx > 0 ? filename.slice(dotIdx + 1).toLowerCase() : '';
}

/**
 * Compresses raw bytes via Web CompressionStream('deflate-raw') when available and beneficial.
 * Falls back cleanly to raw STORE payload when CompressionStream is unavailable or larger.
 * @param {Uint8Array} rawBytes
 * @param {string} safeName
 * @returns {Promise<{ payload: Uint8Array, method: number }>}
 */
async function maybeDeflateEntry(rawBytes, safeName) {
  const ext = extractExtension(safeName);
  if (
    !COMPRESSIBLE_EXT_SET.has(ext) ||
    rawBytes.byteLength < 32 ||
    typeof CompressionStream !== 'function'
  ) {
    return { payload: rawBytes, method: ZIP_METHOD_STORE };
  }
  try {
    const stream = new Blob([rawBytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    const compressedBuf = await new Response(stream).arrayBuffer();
    const compressed = new Uint8Array(compressedBuf);
    if (compressed.byteLength > 0 && compressed.byteLength < rawBytes.byteLength) {
      return { payload: compressed, method: ZIP_METHOD_DEFLATE };
    }
  } catch {
    // Fall back to STORE when runtime does not support deflate-raw
  }
  return { payload: rawBytes, method: ZIP_METHOD_STORE };
}

/**
 * Assembles local file headers, central directory, and EOCD from prepared ZIP items.
 * @param {Array<{ nameBytes: Uint8Array, payloadBytes: Uint8Array, crc: number, uncompressedSize: number, compressedSize: number, method: number }>} prepared
 * @param {Date} timestamp
 * @returns {Uint8Array}
 */
function assembleZipArchive(prepared, timestamp) {
  const { dosTime, dosDate } = encodeDosDateTime(timestamp);

  let localTotal = 0;
  let centralTotal = 0;
  for (const item of prepared) {
    localTotal += 30 + item.nameBytes.length + item.compressedSize;
    centralTotal += 46 + item.nameBytes.length;
  }

  const out = new Uint8Array(localTotal + centralTotal + 22);
  const view = new DataView(out.buffer);

  let localOffset = 0;
  const centralRecords = [];
  for (const item of prepared) {
    const entryStart = localOffset;
    view.setUint32(localOffset, ZIP_LOCAL_HEADER_SIG, true);
    view.setUint16(localOffset + 4, ZIP_VERSION_EXTRACT, true);
    view.setUint16(localOffset + 6, ZIP_UTF8_FLAG, true);
    view.setUint16(localOffset + 8, item.method, true);
    view.setUint16(localOffset + 10, dosTime, true);
    view.setUint16(localOffset + 12, dosDate, true);
    view.setUint32(localOffset + 14, item.crc, true);
    view.setUint32(localOffset + 18, item.compressedSize, true);
    view.setUint32(localOffset + 22, item.uncompressedSize, true);
    view.setUint16(localOffset + 26, item.nameBytes.length, true);
    view.setUint16(localOffset + 28, 0, true);
    out.set(item.nameBytes, localOffset + 30);
    out.set(item.payloadBytes, localOffset + 30 + item.nameBytes.length);
    localOffset += 30 + item.nameBytes.length + item.compressedSize;

    centralRecords.push({ item, entryStart });
  }

  const centralOffset = localOffset;
  let centralPtr = centralOffset;
  for (const { item, entryStart } of centralRecords) {
    view.setUint32(centralPtr, ZIP_CENTRAL_HEADER_SIG, true);
    view.setUint16(centralPtr + 4, ZIP_VERSION_MADE_BY, true);
    view.setUint16(centralPtr + 6, ZIP_VERSION_EXTRACT, true);
    view.setUint16(centralPtr + 8, ZIP_UTF8_FLAG, true);
    view.setUint16(centralPtr + 10, item.method, true);
    view.setUint16(centralPtr + 12, dosTime, true);
    view.setUint16(centralPtr + 14, dosDate, true);
    view.setUint32(centralPtr + 16, item.crc, true);
    view.setUint32(centralPtr + 20, item.compressedSize, true);
    view.setUint32(centralPtr + 24, item.uncompressedSize, true);
    view.setUint16(centralPtr + 28, item.nameBytes.length, true);
    view.setUint16(centralPtr + 30, 0, true);
    view.setUint16(centralPtr + 32, 0, true);
    view.setUint16(centralPtr + 34, 0, true);
    view.setUint16(centralPtr + 36, 0, true);
    view.setUint32(centralPtr + 38, 0, true);
    view.setUint32(centralPtr + 42, entryStart, true);
    out.set(item.nameBytes, centralPtr + 46);
    centralPtr += 46 + item.nameBytes.length;
  }

  view.setUint32(centralPtr, ZIP_EOCD_SIG, true);
  view.setUint16(centralPtr + 4, 0, true);
  view.setUint16(centralPtr + 6, 0, true);
  view.setUint16(centralPtr + 8, centralRecords.length, true);
  view.setUint16(centralPtr + 10, centralRecords.length, true);
  view.setUint32(centralPtr + 12, centralTotal, true);
  view.setUint32(centralPtr + 16, centralOffset, true);
  view.setUint16(centralPtr + 20, 0, true);

  return out;
}

/**
 * Builds an uncompressed STORE (method 0) ZIP archive byte buffer from named binary entries.
 * @param {Array<{ name: string, data: Uint8Array | ArrayBuffer | ArrayBufferView }>} rawEntries
 * @param {Date} [timestamp=new Date()]
 * @returns {Uint8Array}
 */
export function buildZipUint8Array(rawEntries, timestamp = new Date()) {
  const entries = Array.isArray(rawEntries) ? rawEntries : [];
  const usedNames = new Set();

  const prepared = entries.map((entry, idx) => {
    const safeName = sanitizeZipEntryName(entry && entry.name, idx, usedNames);
    const nameBytes = utf8Encoder.encode(safeName);
    const dataBytes = toUint8Array(entry && entry.data);
    return {
      nameBytes,
      payloadBytes: dataBytes,
      crc: crc32(dataBytes),
      uncompressedSize: dataBytes.byteLength,
      compressedSize: dataBytes.byteLength,
      method: ZIP_METHOD_STORE
    };
  });

  return assembleZipArchive(prepared, timestamp);
}

/**
 * Builds a ZIP archive byte buffer using selective DEFLATE compression for text/SVG entries.
 * @param {Array<{ name: string, data: Uint8Array | ArrayBuffer | ArrayBufferView }>} rawEntries
 * @param {Date} [timestamp=new Date()]
 * @returns {Promise<Uint8Array>}
 */
export async function buildZipUint8ArrayAsync(rawEntries, timestamp = new Date()) {
  const entries = Array.isArray(rawEntries) ? rawEntries : [];
  const usedNames = new Set();

  const prepared = await Promise.all(
    entries.map(async (entry, idx) => {
      const safeName = sanitizeZipEntryName(entry && entry.name, idx, usedNames);
      const nameBytes = utf8Encoder.encode(safeName);
      const dataBytes = toUint8Array(entry && entry.data);
      const { payload, method } = await maybeDeflateEntry(dataBytes, safeName);
      return {
        nameBytes,
        payloadBytes: payload,
        crc: crc32(dataBytes),
        uncompressedSize: dataBytes.byteLength,
        compressedSize: payload.byteLength,
        method
      };
    })
  );

  return assembleZipArchive(prepared, timestamp);
}

/**
 * Builds an application/zip Blob synchronously using STORE (method 0).
 * @param {Array<{ name: string, data: Uint8Array | ArrayBuffer | ArrayBufferView }>} entries
 * @returns {Blob}
 */
export function buildZipBlob(entries) {
  return new Blob([buildZipUint8Array(entries)], { type: 'application/zip' });
}

/**
 * Builds an application/zip Blob asynchronously with selective DEFLATE compression.
 * @param {Array<{ name: string, data: Uint8Array | ArrayBuffer | ArrayBufferView }>} entries
 * @returns {Promise<Blob>}
 */
export async function buildZipBlobAsync(entries) {
  return new Blob([await buildZipUint8ArrayAsync(entries)], { type: 'application/zip' });
}

/**
 * Resolves the filename for a ZIP archive entry under original or sequential indexed naming.
 * @param {string} rawFilename
 * @param {string} targetExt
 * @param {number} index
 * @param {number} totalCount
 * @param {string} renameMode
 * @returns {string}
 */
export function resolveZipEntryFilename(rawFilename, targetExt, index, totalCount, renameMode) {
  const cleanExt = String(targetExt || DEFAULT_FILENAMES.FALLBACK_EXT).replace(/^\.+/, '') || DEFAULT_FILENAMES.FALLBACK_EXT;
  if (renameMode === ZIP_RENAME_MODES.SEQUENTIAL) {
    const padWidth = Math.max(3, String(Math.max(1, totalCount || 1)).length);
    const paddedIndex = String((index || 0) + 1).padStart(padWidth, '0');
    return `${DEFAULT_FILENAMES.BASE}_${paddedIndex}.${cleanExt}`;
  }
  const fallbackName = `${DEFAULT_FILENAMES.BASE}_${(index || 0) + 1}.${cleanExt}`;
  const candidate = typeof rawFilename === 'string' && rawFilename.trim() ? rawFilename.trim() : fallbackName;
  if (targetExt) {
    const base = candidate.replace(/\.[^./\\]+$/, '');
    return `${base || `${DEFAULT_FILENAMES.BASE}_${(index || 0) + 1}`}.${cleanExt}`;
  }
  return candidate;
}
