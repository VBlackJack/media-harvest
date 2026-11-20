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
import { createOpfsSpool } from '../src/offscreen/opfs_spool.js';

test('createOpfsSpool streams chunks to OPFS disk handle and cleans up temp file on revoke', async () => {
  const writtenChunks = [];
  let closed = false;
  let removedFile = '';

  const fakeStorage = {
    getDirectory: async () => ({
      getDirectoryHandle: async () => ({
        getFileHandle: async (name) => ({
          createWritable: async () => ({
            write: async (chunk) => {
              writtenChunks.push(chunk);
            },
            close: async () => {
              closed = true;
            }
          }),
          getFile: async () => new Blob(writtenChunks, { type: 'video/webm' })
        }),
        removeEntry: async (name) => {
          removedFile = name;
        }
      })
    })
  };

  const spool = await createOpfsSpool('rec_123', 'video/webm', { storageApi: fakeStorage });
  assert.equal(spool.isDiskBacked, true);
  await spool.append(new Uint8Array([1, 2, 3, 4]));
  await spool.append(new Uint8Array([5, 6]));
  assert.equal(spool.getBytesWritten(), 6);

  const { blob, byteLength, cleanup } = await spool.finalize();
  assert.equal(closed, true);
  assert.equal(byteLength, 6);
  assert.equal(blob.size, 6);

  await cleanup();
  assert.match(removedFile, /^rec_123_\d+\.bin$/);
});

test('createOpfsSpool falls back cleanly to in-memory accumulation when OPFS is unavailable', async () => {
  const spool = await createOpfsSpool('mem_1', 'video/mp4', { storageApi: {} });
  assert.equal(spool.isDiskBacked, false);
  await spool.append(new Uint8Array([10, 20, 30]));
  const { blob, byteLength } = await spool.finalize();
  assert.equal(byteLength, 3);
  assert.equal(blob.type, 'video/mp4');
});
