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
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(import.meta.dirname, '..');
const HOOK_CODE = fs.readFileSync(path.join(ROOT, 'src/content/mse_hook.js'), 'utf8');
const BRIDGE_CODE = fs.readFileSync(path.join(ROOT, 'src/content/mse_bridge.js'), 'utf8');

function createMseHarness({ enableMseCapture = true } = {}) {
  const messageListeners = [];
  const runtimeListeners = [];
  const storageListeners = [];
  const runtimeMessages = [];
  const postedMessages = [];

  class FakeSourceBuffer {
    appendBuffer() {}
  }

  class FakeMediaSource {
    constructor() {
      this.duration = 42.4;
    }
    addSourceBuffer() {
      return new FakeSourceBuffer();
    }
    endOfStream() {}
  }

  const fakeWindow = {
    location: { href: 'https://player.example.com/watch?v=42' },
    MediaSource: FakeMediaSource,
    SourceBuffer: FakeSourceBuffer,
    URL: {
      createObjectURL: () => 'blob:https://player.example.com/1111'
    },
    addEventListener: (ev, fn) => {
      if (ev === 'message') {
        messageListeners.push(fn);
      }
    },
    postMessage: (data) => {
      postedMessages.push(data);
      queueMicrotask(() => {
        for (const fn of messageListeners) {
          fn({ source: fakeWindow, data });
        }
      });
    }
  };

  const sandbox = {
    window: fakeWindow,
    document: { title: 'Test Player Stream' },
    chrome: {
      storage: {
        sync: {
          get: (_key, cb) => cb({ user_settings: { enableMseCapture } })
        },
        onChanged: {
          addListener: (fn) => storageListeners.push(fn)
        }
      },
      runtime: {
        sendMessage: async (msg) => {
          runtimeMessages.push(msg);
          if (msg && msg.type === 'OFFSCREEN_BUILD_MSE_BLOB' && msg.action === 'finalize') {
            return { ok: true, blobUrl: 'blob:chrome-extension://id/muxed', outputExtension: 'mp4', byteLength: 8 };
          }
          return { ok: true };
        },
        onMessage: {
          addListener: (fn) => runtimeListeners.push(fn)
        }
      }
    },
    ArrayBuffer,
    Uint8Array,
    Map,
    WeakMap,
    Math,
    Date,
    Number,
    Promise,
    String,
    btoa: (str) => Buffer.from(str, 'binary').toString('base64'),
    setTimeout,
    clearTimeout
  };
  fakeWindow.window = fakeWindow;

  vm.runInNewContext(BRIDGE_CODE, sandbox, { filename: 'mse_bridge.js' });
  vm.runInNewContext(HOOK_CODE, sandbox, { filename: 'mse_hook.js' });

  const dispatchExport = (msg) => new Promise((resolve) => {
    let handled = false;
    for (const fn of runtimeListeners) {
      const isAsync = fn(msg, {}, (res) => {
        handled = true;
        resolve(res);
      });
      if (!isAsync && !handled) {
        continue;
      }
    }
  });

  return {
    fakeWindow,
    sandbox,
    runtimeMessages,
    postedMessages,
    storageListeners,
    dispatchExport
  };
}

test('mse_hook captures video and audio SourceBuffer chunks and mse_bridge exports via OFFSCREEN_BUILD_MSE_BLOB', async () => {
  const harness = createMseHarness();
  const ms = new harness.fakeWindow.MediaSource();
  harness.fakeWindow.URL.createObjectURL(ms);
  const videoSb = ms.addSourceBuffer('video/mp4; codecs="avc1.42E01E"');
  const audioSb = ms.addSourceBuffer('audio/mp4; codecs="mp4a.40.2"');

  const bigVideo = new Uint8Array(40 * 1024);
  bigVideo.fill(0x41);
  const bigAudio = new Uint8Array(4 * 1024);
  bigAudio.fill(0x42);

  videoSb.appendBuffer(bigVideo);
  audioSb.appendBuffer(bigAudio);

  await new Promise((resolve) => setTimeout(resolve, 650));

  const streamUpdates = harness.runtimeMessages.filter((m) => m.type === 'MSE_STREAM_UPDATED');
  const streamUpdate = streamUpdates[streamUpdates.length - 1];
  assert.ok(streamUpdate);
  assert.equal(streamUpdate.stream.totalBytes, 44 * 1024);
  assert.equal(streamUpdate.stream.videoMime, 'video/mp4; codecs="avc1.42E01E"');
  assert.equal(streamUpdate.stream.audioMime, 'audio/mp4; codecs="mp4a.40.2"');

  const exportResp = await harness.dispatchExport({
    type: 'EXPORT_MSE_STREAM',
    requestId: 'req_mse_test',
    mseId: streamUpdate.stream.mseId
  });
  assert.equal(exportResp.ok, true);
  assert.equal(exportResp.blobUrl, 'blob:chrome-extension://id/muxed');

  const appends = harness.runtimeMessages.filter(
    (m) => m.type === 'OFFSCREEN_BUILD_MSE_BLOB' && m.action === 'append'
  );
  assert.equal(appends.length, 2);
  assert.equal(appends[0].track, 'video');
  assert.equal(appends[1].track, 'audio');
  const finalize = harness.runtimeMessages.find(
    (m) => m.type === 'OFFSCREEN_BUILD_MSE_BLOB' && m.action === 'finalize'
  );
  assert.ok(finalize);
  assert.equal(finalize.videoMime, 'video/mp4; codecs="avc1.42E01E"');
});

test('mse_hook stops capturing and clears chunks when disabled via storage.onChanged', async () => {
  const harness = createMseHarness();
  for (const listener of harness.storageListeners) {
    listener({ user_settings: { newValue: { enableMseCapture: false } } }, 'sync');
  }
  await new Promise((resolve) => setTimeout(resolve, 20));

  const ms = new harness.fakeWindow.MediaSource();
  const sb = ms.addSourceBuffer('video/mp4');
  const payload = new Uint8Array(40 * 1024);
  sb.appendBuffer(payload);
  await new Promise((resolve) => setTimeout(resolve, 40));

  const updates = harness.runtimeMessages.filter((m) => m.type === 'MSE_STREAM_UPDATED');
  assert.equal(updates.length, 0);
});

test('mse_hook resets track buffer on quality switch ftyp init and flushes short streams on endOfStream', async () => {
  const harness = createMseHarness();
  const ms = new harness.fakeWindow.MediaSource();
  harness.fakeWindow.URL.createObjectURL(ms);
  const videoSb = ms.addSourceBuffer('video/mp4; codecs="avc1.42E01E"');

  const initBox = (size) => {
    const buf = new Uint8Array(size);
    // 'ftyp' at bytes 4..7
    buf[4] = 0x66;
    buf[5] = 0x74;
    buf[6] = 0x79;
    buf[7] = 0x70;
    return buf;
  };
  const moofBox = (size) => {
    const buf = new Uint8Array(size);
    // 'moof' at bytes 4..7
    buf[4] = 0x6d;
    buf[5] = 0x6f;
    buf[6] = 0x6f;
    buf[7] = 0x66;
    return buf;
  };

  videoSb.appendBuffer(initBox(64));
  videoSb.appendBuffer(moofBox(40 * 1024));
  // Quality switch injects a fresh init header after media fragments
  videoSb.appendBuffer(initBox(32));
  videoSb.appendBuffer(moofBox(1024));
  // Force-flush short new clip (< 32 KB threshold) via endOfStream
  ms.endOfStream();

  await new Promise((resolve) => setTimeout(resolve, 30));

  const updates = harness.runtimeMessages.filter((m) => m.type === 'MSE_STREAM_UPDATED');
  const latest = updates[updates.length - 1];
  assert.ok(latest);
  assert.equal(latest.stream.totalBytes, 1056);
  assert.equal(latest.stream.blobUrl, 'blob:https://player.example.com/1111');
});
