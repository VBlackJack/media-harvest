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
import { FILENAME_TEMPLATES, MESSAGE_TYPES, STORAGE_KEYS } from '../src/config/constants.js';

const prevChrome = globalThis.chrome;
const prevFetch = globalThis.fetch;

const sessionStore = new Map();
const syncStore = new Map();
const messageHandlers = [];
const downloads = [];
const cancelledDownloads = [];
const offscreenMessages = [];
let badgeText = '';
let offscreenExists = false;
let offscreenResponder = async () => ({
  ok: true,
  blobUrl: 'blob:chrome-extension://id/1',
  outputExtension: 'mp4'
});

globalThis.chrome = {
  action: {
    setBadgeBackgroundColor: async () => {},
    setBadgeText: async ({ text }) => {
      badgeText = text;
    }
  },
  storage: {
    session: {
      get: async (key) => {
        if (typeof key === 'string') {
          return sessionStore.has(key) ? { [key]: sessionStore.get(key) } : {};
        }
        const out = {};
        for (const [k, v] of sessionStore.entries()) {
          out[k] = v;
        }
        return out;
      },
      set: async (entries) => {
        for (const [k, v] of Object.entries(entries)) {
          sessionStore.set(k, v);
        }
      },
      remove: async (key) => {
        sessionStore.delete(key);
      }
    },
    sync: {
      get: async (key) => (syncStore.has(key) ? { [key]: syncStore.get(key) } : {}),
      set: async (entries) => {
        for (const [k, v] of Object.entries(entries)) {
          syncStore.set(k, v);
        }
      }
    }
  },
  webRequest: {
    onHeadersReceived: { addListener: () => {} },
    onBeforeRequest: { addListener: () => {} }
  },
  tabs: {
    onUpdated: { addListener: () => {} },
    onRemoved: { addListener: () => {} }
  },
  scripting: {
    executeScript: async () => [{
      result: {
        pageTitle: 'Sample Page',
        pageUrl: 'https://example.com/watch',
        hasBlobVideo: false,
        videoElements: [],
        items: [
          {
            url: 'https://example.com/clip.mp4',
            type: 'video',
            ext: 'mp4',
            source: 'dom',
            title: 'Sample Video'
          }
        ]
      }
    }]
  },
  downloads: {
    download: async (opts) => {
      const id = downloads.length + 1;
      downloads.push({ id, ...opts });
      return id;
    },
    cancel: async (id) => {
      cancelledDownloads.push(id);
    },
    search: async ({ id }) => [{ id, state: 'complete' }],
    onChanged: { addListener: () => {} }
  },
  runtime: {
    getURL: (rel) => `chrome-extension://test-id/${rel}`,
    getContexts: async () => (offscreenExists ? [{ contextType: 'OFFSCREEN_DOCUMENT' }] : []),
    sendMessage: async (msg) => {
      if (msg && msg.target === 'offscreen') {
        offscreenMessages.push(msg);
        return offscreenResponder(msg);
      }
      return { ok: true };
    },
    onMessage: {
      addListener: (fn) => messageHandlers.push(fn)
    }
  },
  offscreen: {
    Reason: { BLOBS: 'BLOBS' },
    createDocument: async () => {
      offscreenExists = true;
    },
    closeDocument: async () => {
      offscreenExists = false;
    }
  }
};

await import('../src/background/service_worker.js');

function dispatchRuntimeMessage(message, sender = {}) {
  return new Promise((resolve) => {
    let responded = false;
    const sendResponse = (resp) => {
      if (!responded) {
        responded = true;
        resolve(resp);
      }
    };
    for (const handler of messageHandlers) {
      const isAsync = handler(message, sender, sendResponse);
      if (!isAsync && responded) {
        return;
      }
    }
  });
}

beforeEach(() => {
  sessionStore.clear();
  syncStore.clear();
  downloads.length = 0;
  cancelledDownloads.length = 0;
  offscreenMessages.length = 0;
  badgeText = '';
  offscreenExists = false;
  offscreenResponder = async () => ({
    ok: true,
    blobUrl: 'blob:chrome-extension://id/1',
    outputExtension: 'mp4'
  });
  globalThis.fetch = prevFetch;
});

after(() => {
  globalThis.chrome = prevChrome;
  globalThis.fetch = prevFetch;
});

test('service_worker GET_MEDIA_FOR_TAB applies filenameTemplate and updates badge', async () => {
  syncStore.set(STORAGE_KEYS.USER_SETTINGS, {
    filenameTemplate: FILENAME_TEMPLATES.HOST_STEM
  });

  const resp = await dispatchRuntimeMessage({
    type: MESSAGE_TYPES.GET_MEDIA_FOR_TAB,
    tabId: 42,
    tabUrl: 'https://www.example.com/watch'
  });

  assert.equal(resp.ok, true);
  assert.equal(resp.items.length, 1);
  assert.equal(resp.items[0].suggestedFilename, 'example.com_clip.mp4');
  assert.equal(badgeText, '1');
});

test('service_worker INSPECT_HLS parses DASH .mpd manifests and CANCEL_DOWNLOAD aborts active stream build', async () => {
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('.mpd')) {
      return {
        ok: true,
        status: 200,
        text: async () => `
          <MPD type="static" mediaPresentationDuration="PT10S">
            <Period>
              <AdaptationSet mimeType="video/mp4">
                <SegmentTemplate timescale="1" duration="5" initialization="init.mp4" media="seg-$Number$.m4s" startNumber="1"/>
                <Representation id="hd" bandwidth="2000000" width="1280" height="720"/>
              </AdaptationSet>
            </Period>
          </MPD>`
      };
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  };

  const inspectResp = await dispatchRuntimeMessage({
    type: MESSAGE_TYPES.INSPECT_HLS,
    url: 'https://cdn.example.com/vod/manifest.mpd'
  });
  assert.equal(inspectResp.ok, true);
  assert.equal(inspectResp.streamFormat, 'dash');
  assert.equal(inspectResp.variants.length, 1);
  assert.equal(inspectResp.variants[0].resolution, '1280x720');
  assert.equal(inspectResp.totalDurationSec, 10);

  let releaseBuild;
  offscreenResponder = (msg) => {
    if (msg.type === MESSAGE_TYPES.OFFSCREEN_BUILD_HLS_BLOB) {
      return new Promise((resolve) => {
        releaseBuild = resolve;
      });
    }
    if (msg.type === MESSAGE_TYPES.OFFSCREEN_CANCEL_BUILD && releaseBuild) {
      releaseBuild({ ok: false, error: 'DOWNLOAD_CANCELLED' });
    }
    return Promise.resolve({ ok: true });
  };

  const downloadPromise = dispatchRuntimeMessage({
    type: MESSAGE_TYPES.DOWNLOAD_MEDIA,
    payload: {
      url: 'https://cdn.example.com/vod/manifest.mpd',
      playlistUrl: 'https://cdn.example.com/vod/manifest.mpd#dash-video-hd',
      isStream: true,
      filename: 'video.mp4',
      requestId: 'req-cancel-test'
    }
  });

  await new Promise((resolve) => setTimeout(resolve, 15));
  const cancelResp = await dispatchRuntimeMessage({
    type: MESSAGE_TYPES.CANCEL_DOWNLOAD,
    requestId: 'req-cancel-test'
  });
  assert.equal(cancelResp.ok, true);

  const downloadResp = await downloadPromise;
  assert.equal(downloadResp.ok, false);
  assert.equal(downloadResp.error, 'DOWNLOAD_CANCELLED');
  assert.ok(
    offscreenMessages.some(
      (m) => m.type === MESSAGE_TYPES.OFFSCREEN_CANCEL_BUILD && m.requestId === 'req-cancel-test'
    )
  );
});
