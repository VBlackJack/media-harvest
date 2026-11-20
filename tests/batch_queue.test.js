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
import { createBackgroundBatchQueue } from '../src/background/batch_queue.js';

test('createBackgroundBatchQueue executes items sequentially, tracks failures, and emits progress snapshots', async () => {
  const progressEvents = [];
  const executed = [];
  const queue = createBackgroundBatchQueue({
    delayMs: 0,
    notifyProgress: (snap) => progressEvents.push(snap),
    executeItem: async (item) => {
      executed.push(item.url);
      if (item.fail) {
        throw new Error('HTTP_503');
      }
      return { downloadId: 1, requestId: item.requestId };
    }
  });

  const result = await queue.start([
    { url: 'https://cdn.example.com/1.jpg' },
    { url: 'https://cdn.example.com/2.jpg', fail: true },
    { url: 'https://cdn.example.com/3.jpg' }
  ]);

  assert.equal(result.ok, true);
  assert.equal(result.startedCount, 2);
  assert.equal(result.failedCount, 1);
  assert.equal(result.lastError, 'HTTP_503');
  assert.equal(result.running, false);
  assert.deepEqual(executed, [
    'https://cdn.example.com/1.jpg',
    'https://cdn.example.com/2.jpg',
    'https://cdn.example.com/3.jpg'
  ]);
  assert.ok(progressEvents.length >= 4);
});

test('createBackgroundBatchQueue supports mid-flight cancellation and forwards cancelRequest', async () => {
  const cancelledIds = [];
  let queue;
  queue = createBackgroundBatchQueue({
    delayMs: 0,
    notifyProgress: () => {},
    cancelRequest: async (reqId) => {
      cancelledIds.push(reqId);
    },
    executeItem: async (item) => {
      if (item.triggerCancel) {
        await queue.cancel();
      }
      return { downloadId: 1, requestId: item.requestId };
    }
  });

  const result = await queue.start([
    { url: 'https://cdn.example.com/a.jpg', triggerCancel: true },
    { url: 'https://cdn.example.com/b.jpg' }
  ]);

  assert.equal(result.aborted, true);
  assert.equal(result.completed, 1);
  assert.equal(cancelledIds.length, 1);
});
