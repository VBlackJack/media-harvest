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

import { DEFAULT_FILENAMES, LIMITS } from '../config/constants.js';

const ZIP_LOCAL_HEADER_SIG = 0x04034b50;
const ZIP_CENTRAL_HEADER_SIG = 0x02014b50;
const ZIP_EOCD_SIG = 0x06054b50;
const ZIP_UTF8_FLAG = 0x0800;
const ZIP_VERSION_EXTRACT = 20;
const ZIP_VERSION_MADE_BY = 20;

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
 * Builds a uncompressed STORE (method 0) ZIP archive byte buffer from named binary entries.
 * @param {Array<{ name: string, data: Uint8Array | ArrayBuffer | ArrayBufferView }>} rawEntries
 * @param {Date} [timestamp=new Date()]
 * @returns {Uint8Array}
 */
export function buildZipUint8Array(rawEntries, timestamp = new Date()) {
  const entries = Array.isArray(rawEntries) ? rawEntries : [];
  const usedNames = new Set();
  const { dosTime, dosDate } = encodeDosDateTime(timestamp);

  const prepared = entries.map((entry, idx) => {
    const safeName = sanitizeZipEntryName(entry && entry.name, idx, usedNames);
    const nameBytes = utf8Encoder.encode(safeName);
    const dataBytes = toUint8Array(entry && entry.data);
    return {
      nameBytes,
      dataBytes,
      crc: crc32(dataBytes),
      size: dataBytes.byteLength
    };
  });

  let localTotal = 0;
  let centralTotal = 0;
  for (const item of prepared) {
    localTotal += 30 + item.nameBytes.length + item.size;
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
    view.setUint16(localOffset + 8, 0, true);
    view.setUint16(localOffset + 10, dosTime, true);
    view.setUint16(localOffset + 12, dosDate, true);
    view.setUint32(localOffset + 14, item.crc, true);
    view.setUint32(localOffset + 18, item.size, true);
    view.setUint32(localOffset + 22, item.size, true);
    view.setUint16(localOffset + 26, item.nameBytes.length, true);
    view.setUint16(localOffset + 28, 0, true);
    out.set(item.nameBytes, localOffset + 30);
    out.set(item.dataBytes, localOffset + 30 + item.nameBytes.length);
    localOffset += 30 + item.nameBytes.length + item.size;

    centralRecords.push({ item, entryStart });
  }

  const centralOffset = localOffset;
  let centralPtr = centralOffset;
  for (const { item, entryStart } of centralRecords) {
    view.setUint32(centralPtr, ZIP_CENTRAL_HEADER_SIG, true);
    view.setUint16(centralPtr + 4, ZIP_VERSION_MADE_BY, true);
    view.setUint16(centralPtr + 6, ZIP_VERSION_EXTRACT, true);
    view.setUint16(centralPtr + 8, ZIP_UTF8_FLAG, true);
    view.setUint16(centralPtr + 10, 0, true);
    view.setUint16(centralPtr + 12, dosTime, true);
    view.setUint16(centralPtr + 14, dosDate, true);
    view.setUint32(centralPtr + 16, item.crc, true);
    view.setUint32(centralPtr + 20, item.size, true);
    view.setUint32(centralPtr + 24, item.size, true);
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
 * Builds an application/zip Blob from named binary entries.
 * @param {Array<{ name: string, data: Uint8Array | ArrayBuffer | ArrayBufferView }>} entries
 * @returns {Blob}
 */
export function buildZipBlob(entries) {
  return new Blob([buildZipUint8Array(entries)], { type: 'application/zip' });
}
