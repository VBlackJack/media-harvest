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

import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MESSAGE_TYPES } from '../src/config/constants.js';

const prevChrome = globalThis.chrome;
const prevFetch = globalThis.fetch;
const prevCreateObjectUrl = URL.createObjectURL;
const prevRevokeObjectUrl = URL.revokeObjectURL;

const messageHandlers = [];
const revokedUrls = [];
let blobCounter = 0;

globalThis.chrome = {
  runtime: {
    sendMessage: async () => ({ ok: true }),
    onMessage: {
      addListener: (fn) => messageHandlers.push(fn)
    }
  }
};

URL.createObjectURL = () => {
  blobCounter += 1;
  return `blob:test-offscreen/${blobCounter}`;
};

URL.revokeObjectURL = (url) => {
  revokedUrls.push(url);
};

await import('../src/offscreen/offscreen.js');

function dispatchOffscreenMessage(msg) {
  return new Promise((resolve) => {
    let settled = false;
    const sendResponse = (resp) => {
      if (!settled) {
        settled = true;
        resolve(resp);
      }
    };
    for (const fn of messageHandlers) {
      const isAsync = fn(msg, {}, sendResponse);
      if (!isAsync && settled) {
        return;
      }
    }
  });
}

beforeEach(() => {
  revokedUrls.length = 0;
  globalThis.fetch = prevFetch;
});

after(() => {
  globalThis.chrome = prevChrome;
  globalThis.fetch = prevFetch;
  URL.createObjectURL = prevCreateObjectUrl;
  URL.revokeObjectURL = prevRevokeObjectUrl;
});

test('offscreen coalesces HTTP 200 byte-range fallback into a single fetch per URL and revokes blobs cleanly', async () => {
  const fullData = new Uint8Array(60);
  fullData.fill(0x11, 0, 20);
  fullData.fill(0x22, 20, 40);
  fullData.fill(0x33, 40, 60);

  let binaryFetches = 0;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('.m3u8')) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => [
          '#EXTM3U',
          '#EXT-X-MAP:URI="combined.mp4",BYTERANGE="20@0"',
          '#EXTINF:2.0,',
          '#EXT-X-BYTERANGE:20@20',
          'combined.mp4',
          '#EXTINF:2.0,',
          '#EXT-X-BYTERANGE:20',
          'combined.mp4',
          '#EXT-X-ENDLIST'
        ].join('\n')
      };
    }
    binaryFetches += 1;
    return {
      ok: true,
      status: 200,
      headers: { get: () => String(fullData.byteLength) },
      arrayBuffer: async () => fullData.slice().buffer
    };
  };

  const buildResp = await dispatchOffscreenMessage({
    target: 'offscreen',
    type: MESSAGE_TYPES.OFFSCREEN_BUILD_HLS_BLOB,
    requestId: 'offscreen-200-test',
    playlistUrl: 'https://cdn.example.com/hls/playlist.m3u8',
    originalUrl: 'https://cdn.example.com/hls/playlist.m3u8',
    concurrency: 4
  });

  assert.equal(buildResp.ok, true);
  assert.equal(binaryFetches, 1);
  assert.equal(buildResp.byteLength, 60);

  const revokeResp = await dispatchOffscreenMessage({
    target: 'offscreen',
    type: MESSAGE_TYPES.OFFSCREEN_REVOKE_BLOB,
    blobUrl: buildResp.blobUrl
  });
  assert.equal(revokeResp.ok, true);
  assert.deepEqual(revokedUrls, [buildResp.blobUrl]);
});

test('offscreen enforces MAX_HLS_BUFFER_BYTES via Content-Length rejection (STREAM_TOO_LARGE)', async () => {
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('.m3u8')) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => ['#EXTM3U', '#EXTINF:2.0,', 'huge.ts', '#EXT-X-ENDLIST'].join('\n')
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => String(600 * 1024 * 1024) },
      arrayBuffer: async () => new ArrayBuffer(8)
    };
  };

  const resp = await dispatchOffscreenMessage({
    target: 'offscreen',
    type: MESSAGE_TYPES.OFFSCREEN_BUILD_HLS_BLOB,
    requestId: 'offscreen-too-large',
    playlistUrl: 'https://cdn.example.com/hls/huge.m3u8',
    originalUrl: 'https://cdn.example.com/hls/huge.m3u8',
    concurrency: 1
  });

  assert.equal(resp.ok, false);
  assert.equal(resp.error, 'STREAM_TOO_LARGE');
});
