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
  buildSequenceIv,
  decodeBase64DataUri,
  decryptAes128Segment,
  importAes128Key,
  isBase64DataUri,
  parseHlsIvHex,
  resolveSegmentIv
} from '../src/shared/hls_crypto.js';

test('parseHlsIvHex and buildSequenceIv normalize 16-byte AES-CBC initialization vectors', () => {
  const parsed = parseHlsIvHex('0x0102030405060708090a0b0c0d0e0f10');
  assert.equal(parsed.byteLength, 16);
  assert.equal(parsed[0], 0x01);
  assert.equal(parsed[15], 0x10);

  const shortHex = parseHlsIvHex('0x2a');
  assert.equal(shortHex[14], 0);
  assert.equal(shortHex[15], 0x2a);

  assert.equal(parseHlsIvHex(''), null);
  assert.equal(parseHlsIvHex('invalid-iv'), null);

  const seqIv = buildSequenceIv(42);
  assert.equal(seqIv.byteLength, 16);
  assert.equal(seqIv[15], 42);
  assert.equal(seqIv[14], 0);

  assert.deepEqual(resolveSegmentIv('', 7), buildSequenceIv(7));
  assert.deepEqual(resolveSegmentIv('0xff', 7), parseHlsIvHex('0xff'));
});

test('decodeBase64DataUri decodes valid 16-byte AES keys and rejects malformed inputs', () => {
  const rawKey = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) {
    rawKey[i] = i + 1;
  }
  const b64 = Buffer.from(rawKey).toString('base64');
  const uri = `data:application/octet-stream;base64,${b64}`;

  assert.equal(isBase64DataUri(uri), true);
  assert.deepEqual(decodeBase64DataUri(uri), rawKey);
  assert.equal(isBase64DataUri('https://example.com/key'), false);

  const wrongLenUri = `data:application/octet-stream;base64,${Buffer.from([1, 2, 3]).toString('base64')}`;
  assert.throws(() => decodeBase64DataUri(wrongLenUri), /INVALID_KEY/);
});

test('decryptAes128Segment decrypts Web Crypto AES-128-CBC payloads cleanly', async () => {
  const rawKey = new Uint8Array(16).fill(0x5a);
  const iv = buildSequenceIv(12);
  const plaintext = new Uint8Array([0x47, 0x40, 0x00, 0x10, 1, 2, 3, 4, 5, 6, 7, 8]);

  const encryptKey = await globalThis.crypto.subtle.importKey(
    'raw',
    rawKey,
    { name: 'AES-CBC' },
    false,
    ['encrypt']
  );
  const encrypted = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-CBC', iv },
    encryptKey,
    plaintext
  );

  const cachedKey = await importAes128Key(rawKey);
  const decrypted = await decryptAes128Segment(encrypted, cachedKey, iv);
  assert.deepEqual(new Uint8Array(decrypted), plaintext);
});
