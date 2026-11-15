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

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildZipBlob,
  buildZipUint8Array,
  crc32,
  sanitizeZipEntryName
} from '../src/shared/zip_builder.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Parses STORE entries back out of a generated ZIP byte array to verify structural integrity.
 * @param {Uint8Array} bytes
 * @returns {Array<{ name: string, crc: number, size: number, data: Uint8Array }>}
 */
function parseStoreZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries = [];
  let offset = 0;

  while (offset + 4 <= bytes.length && view.getUint32(offset, true) === 0x04034b50) {
    const crc = view.getUint32(offset + 14, true);
    const size = view.getUint32(offset + 18, true);
    const nameLen = view.getUint16(offset + 26, true);
    const extraLen = view.getUint16(offset + 28, true);
    const name = decoder.decode(bytes.slice(offset + 30, offset + 30 + nameLen));
    const dataStart = offset + 30 + nameLen + extraLen;
    const data = bytes.slice(dataStart, dataStart + size);
    entries.push({ name, crc, size, data });
    offset = dataStart + size;
  }

  let centralCount = 0;
  while (offset + 4 <= bytes.length && view.getUint32(offset, true) === 0x02014b50) {
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    centralCount += 1;
    offset += 46 + nameLen + extraLen + commentLen;
  }

  assert.equal(view.getUint32(offset, true), 0x06054b50, 'Expected End of Central Directory record');
  assert.equal(view.getUint16(offset + 8, true), centralCount);
  assert.equal(view.getUint16(offset + 10, true), entries.length);
  return entries;
}

test('crc32 matches standard IEEE 802.3 vector', () => {
  assert.equal(crc32(encoder.encode('123456789')), 0xcbf43926);
  assert.equal(crc32(new Uint8Array(0)), 0x00000000);
});

test('sanitizeZipEntryName strips unsafe path chars and deduplicates colliding names', () => {
  const used = new Set();
  assert.equal(sanitizeZipEntryName('../evil/path:photo*.png', 0, used), 'path_photo_.png');
  assert.equal(sanitizeZipEntryName('path_photo_.png', 1, used), 'path_photo__2.png');
  assert.equal(sanitizeZipEntryName('PATH_PHOTO_.PNG', 2, used), 'PATH_PHOTO__3.PNG');
  assert.equal(sanitizeZipEntryName('', 3, used), 'media_4.bin');
});

test('buildZipUint8Array and buildZipBlob emit valid parseable ZIP archives with multiple files', async () => {
  const payloadA = encoder.encode('hello world');
  const payloadB = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const rawZip = buildZipUint8Array([
    { name: 'note.txt', data: payloadA },
    { name: 'note.txt', data: payloadB.buffer },
    { name: 'icône.svg', data: encoder.encode('<svg/>') }
  ]);

  const parsed = parseStoreZip(rawZip);
  assert.equal(parsed.length, 3);
  assert.deepEqual(parsed.map((e) => e.name), ['note.txt', 'note_2.txt', 'icône.svg']);
  assert.equal(parsed[0].crc, crc32(payloadA));
  assert.equal(decoder.decode(parsed[0].data), 'hello world');
  assert.deepEqual(parsed[1].data, payloadB);
  assert.equal(decoder.decode(parsed[2].data), '<svg/>');

  const blob = buildZipBlob([{ name: 'a.bin', data: new Uint8Array([1, 2, 3]) }]);
  assert.equal(blob.type, 'application/zip');
  assert.ok(blob.size > 50);
});
