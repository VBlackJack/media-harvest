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

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  CANCEL_REASON,
  fetchWithManagedTimeout,
  isDashDescriptor,
  looksLikeDashXml
} from '../src/shared/fetch_utils.js';

const origFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = origFetch;
});

test('isDashDescriptor and looksLikeDashXml detect DASH streams without relying solely on extensions', () => {
  assert.equal(isDashDescriptor('https://cdn.example.com/vod/stream.mpd?token=1'), true);
  assert.equal(isDashDescriptor('https://cdn.example.com/manifest#dash-video-hd'), true);
  assert.equal(isDashDescriptor('https://cdn.example.com/manifest', 'application/dash+xml'), true);
  assert.equal(isDashDescriptor('https://cdn.example.com/manifest', '', { streamFormat: 'dash' }), true);
  assert.equal(isDashDescriptor('https://cdn.example.com/hls/master.m3u8', 'application/vnd.apple.mpegurl'), false);

  assert.equal(looksLikeDashXml('<?xml version="1.0"?><MPD type="static"></MPD>'), true);
  assert.equal(looksLikeDashXml('#EXTM3U\n#EXT-X-VERSION:3'), false);
});

test('fetchWithManagedTimeout reserves Content-Length across concurrent requests and rolls back on failure', async () => {
  const byteTracker = { bytes: 0 };
  globalThis.fetch = async (url) => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    if (String(url).includes('fail')) {
      return { ok: false, status: 503, headers: new Headers() };
    }
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-length': '60' }),
      arrayBuffer: async () => new Uint8Array(60).buffer
    };
  };

  await assert.rejects(
    Promise.all([
      fetchWithManagedTimeout('https://example.com/a.bin', { responseMode: 'buffer', byteTracker, maxBytes: 100 }),
      fetchWithManagedTimeout('https://example.com/b.bin', { responseMode: 'buffer', byteTracker, maxBytes: 100 })
    ]),
    /STREAM_TOO_LARGE/
  );
  // First reservation stayed or both rolled back depending on completion; tracker must stay <= 100
  assert.ok(byteTracker.bytes <= 100);

  const trackerFail = { bytes: 10 };
  await assert.rejects(
    fetchWithManagedTimeout('https://example.com/fail.bin', {
      responseMode: 'buffer',
      byteTracker: trackerFail,
      maxBytes: 100
    }),
    /HTTP 503/
  );
  assert.equal(trackerFail.bytes, 10);
});

test('fetchWithManagedTimeout enforces streaming maxBytes even with Content-Encoding compression', async () => {
  const byteTracker = { bytes: 0 };
  let cancelCalled = false;
  let chunkIndex = 0;

  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: new Headers({
      'content-length': '10',
      'content-encoding': 'gzip'
    }),
    body: {
      getReader: () => ({
        read: async () => {
          chunkIndex += 1;
          if (chunkIndex === 1) {
            return { done: false, value: new Uint8Array(40) };
          }
          if (chunkIndex === 2) {
            return { done: false, value: new Uint8Array(40) };
          }
          return { done: true, value: undefined };
        },
        cancel: async () => {
          cancelCalled = true;
        }
      })
    }
  });

  await assert.rejects(
    fetchWithManagedTimeout('https://example.com/compressed.bin', {
      responseMode: 'buffer',
      byteTracker,
      maxBytes: 50
    }),
    /STREAM_TOO_LARGE/
  );
  assert.equal(cancelCalled, true);
  assert.equal(byteTracker.bytes, 0);
});

test('fetchWithManagedTimeout rejects invalid URLs and respects user cancellation and timeouts', async () => {
  await assert.rejects(
    fetchWithManagedTimeout('ftp://example.com/file.mp4'),
    /INVALID_URL/
  );

  const cancelController = new AbortController();
  cancelController.abort(CANCEL_REASON);
  await assert.rejects(
    fetchWithManagedTimeout('https://example.com/seg.ts', {
      responseMode: 'buffer',
      cancelSignal: cancelController.signal
    }),
    /DOWNLOAD_CANCELLED/
  );

  globalThis.fetch = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
  });
  await assert.rejects(
    fetchWithManagedTimeout('https://example.com/slow.m3u8', {
      responseMode: 'text',
      timeoutMs: 15
    }),
    /FETCH_TIMEOUT/
  );
});
