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
import { BADGE_CONFIG, FILENAME_TEMPLATES, MESSAGE_TYPES, STORAGE_KEYS } from '../src/config/constants.js';

const prevChrome = globalThis.chrome;
const prevFetch = globalThis.fetch;

const sessionStore = new Map();
const syncStore = new Map();
const messageHandlers = [];
const downloadChangedHandlers = [];
const downloads = [];
const cancelledDownloads = [];
const offscreenMessages = [];
let downloadSearchState = 'complete';
let badgeText = '';
let badgeColor = '';
const badgeHistory = [];
let offscreenExists = false;
let offscreenResponder = async () => ({
  ok: true,
  blobUrl: 'blob:chrome-extension://id/1',
  outputExtension: 'mp4'
});

const dnrUpdates = [];
const tabMessages = [];
const nativeMessages = [];
const runtimeBroadcasts = [];
const nativePorts = [];
let nativeResponder = async (msg) => {
  if (msg && msg.action === 'ping') {
    return { ok: true, ytDlpVersion: '2026.01.01', ffmpegAvailable: true };
  }
  return { ok: true, outputDir: 'C:\\Users\\Test\\Downloads\\MediaHarvest' };
};

globalThis.chrome = {
  action: {
    setBadgeBackgroundColor: async ({ color }) => {
      badgeColor = color;
    },
    setBadgeText: async ({ text }) => {
      badgeText = text;
      badgeHistory.push({ color: badgeColor, text });
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
    onRemoved: { addListener: () => {} },
    sendMessage: async (tabId, msg, opts) => {
      tabMessages.push({ tabId, msg, opts });
      return { ok: true, blobUrl: 'blob:chrome-extension://id/mse1', outputExtension: 'mp4' };
    }
  },
  declarativeNetRequest: {
    updateSessionRules: async (update) => {
      dnrUpdates.push(update);
    }
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
    search: async ({ id }) => [{ id, state: downloadSearchState }],
    onChanged: {
      addListener: (fn) => downloadChangedHandlers.push(fn)
    }
  },
  runtime: {
    id: 'test-ext-id',
    getURL: (rel) => `chrome-extension://test-id/${rel}`,
    getContexts: async () => (offscreenExists ? [{ contextType: 'OFFSCREEN_DOCUMENT' }] : []),
    sendMessage: async (msg) => {
      if (msg && msg.target === 'offscreen') {
        offscreenMessages.push(msg);
        return offscreenResponder(msg);
      }
      runtimeBroadcasts.push(msg);
      return { ok: true };
    },
    sendNativeMessage: async (hostName, msg) => {
      nativeMessages.push({ hostName, msg });
      return nativeResponder(msg);
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
  runtimeBroadcasts.length = 0;
  nativePorts.length = 0;
  delete globalThis.chrome.runtime.connectNative;
  badgeText = '';
  downloadSearchState = 'complete';
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
  const activeResp = await dispatchRuntimeMessage({ type: MESSAGE_TYPES.GET_ACTIVE_BUILDS });
  assert.equal(activeResp.ok, true);
  assert.equal(activeResp.builds.length, 1);
  assert.equal(activeResp.builds[0].requestId, 'req-cancel-test');
  assert.equal(activeResp.builds[0].url, 'https://cdn.example.com/vod/manifest.mpd');

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

test('service_worker handles DOWNLOAD_TWEET_VIDEO, CLEAR_MEDIA_FOR_TAB, and downloads.onChanged blob cleanup', async () => {
  syncStore.set(STORAGE_KEYS.USER_SETTINGS, { promptSaveAs: true });
  sessionStore.set(`${STORAGE_KEYS.TAB_MEDIA_PREFIX}77`, [
    {
      url: 'https://video.twimg.com/ext_tw_video/987654321/pu/vid/720x1280/clip.mp4',
      type: 'video',
      ext: 'mp4',
      isStream: false
    }
  ]);

  const tweetResp = await dispatchRuntimeMessage(
    {
      type: MESSAGE_TYPES.DOWNLOAD_TWEET_VIDEO,
      payload: {
        mediaId: '987654321',
        authorHandle: 'creator',
        tweetId: '555666'
      }
    },
    { tab: { id: 77, url: 'https://x.com/creator/status/555666' } }
  );
  assert.equal(tweetResp.ok, true);
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].filename, 'creator_555666.mp4');
  assert.equal(downloads[0].saveAs, true);

  const clearResp = await dispatchRuntimeMessage({
    type: MESSAGE_TYPES.CLEAR_MEDIA_FOR_TAB,
    tabId: 77
  });
  assert.equal(clearResp.ok, true);
  assert.equal(sessionStore.has(`${STORAGE_KEYS.TAB_MEDIA_PREFIX}77`), false);

  downloadSearchState = 'in_progress';
  const streamResp = await dispatchRuntimeMessage({
    type: MESSAGE_TYPES.DOWNLOAD_MEDIA,
    payload: {
      url: 'https://cdn.example.com/hls/master.m3u8',
      playlistUrl: 'https://cdn.example.com/hls/master.m3u8',
      isStream: true,
      filename: 'stream.mp4'
    }
  });
  assert.equal(streamResp.ok, true);
  const blobKey = `${STORAGE_KEYS.DOWNLOAD_BLOB_PREFIX}${streamResp.downloadId}`;
  assert.equal(sessionStore.get(blobKey), 'blob:chrome-extension://id/1');

  assert.equal(downloadChangedHandlers.length > 0, true);
  for (const listener of downloadChangedHandlers) {
    listener({ id: streamResp.downloadId, state: { current: 'complete' } });
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(sessionStore.has(blobKey), false);
  assert.ok(
    offscreenMessages.some(
      (m) => m.type === MESSAGE_TYPES.OFFSCREEN_REVOKE_BLOB && m.blobUrl === 'blob:chrome-extension://id/1'
    )
  );
});

test('service_worker propagates HLS subtitles and live flag, downloads HLS subtitles, and preserves folder templates', async () => {
  globalThis.fetch = async (url) => {
    const key = String(url);
    if (key.endsWith('master_live.m3u8')) {
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        text: async () => [
          '#EXTM3U',
          '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",LANGUAGE="fr",NAME="French",DEFAULT=YES,URI="subs/fr.m3u8"',
          '#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720,SUBTITLES="subs"',
          'live_variant.m3u8'
        ].join('\n')
      };
    }
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => ['#EXTM3U', '#EXTINF:2.0,', 'seg1.ts'].join('\n')
    };
  };

  const inspectResp = await dispatchRuntimeMessage({
    type: MESSAGE_TYPES.INSPECT_HLS,
    url: 'https://cdn.example.com/hls/master_live.m3u8'
  });
  assert.equal(inspectResp.ok, true);
  assert.equal(inspectResp.isDynamic, true);
  assert.equal(inspectResp.subtitles.length, 1);
  assert.equal(inspectResp.subtitles[0].url, 'https://cdn.example.com/hls/subs/fr.m3u8');

  syncStore.set(STORAGE_KEYS.USER_SETTINGS, { filenameTemplate: FILENAME_TEMPLATES.HOST_FOLDER });
  offscreenResponder = async () => ({
    ok: true,
    blobUrl: 'blob:chrome-extension://id/sub1',
    outputExtension: 'vtt'
  });

  const subDlResp = await dispatchRuntimeMessage({
    type: MESSAGE_TYPES.DOWNLOAD_HLS_SUBTITLE,
    payload: {
      subtitleUrl: 'https://cdn.example.com/hls/subs/fr.m3u8',
      filename: 'example.com/clip_subtitles',
      allowFolders: true
    }
  });
  assert.equal(subDlResp.ok, true);
  assert.equal(downloads[0].filename, 'example.com/clip_subtitles.vtt');
  assert.ok(
    offscreenMessages.some(
      (m) => m.type === MESSAGE_TYPES.OFFSCREEN_BUILD_SUBTITLE_BLOB && m.subtitleUrl === 'https://cdn.example.com/hls/subs/fr.m3u8'
    )
  );
});

test('service_worker handles MSE capture/export, DOWNLOAD_SITE_VIDEO, DNR Referer rules, and Native Companion', async () => {
  dnrUpdates.length = 0;
  tabMessages.length = 0;
  nativeMessages.length = 0;

  for (const handler of messageHandlers) {
    handler(
      {
        type: MESSAGE_TYPES.MSE_STREAM_UPDATED,
        stream: {
          mseId: 'mse_55',
          url: 'mse://mse_55',
          mimeType: 'video/mp4',
          videoMime: 'video/mp4',
          audioMime: 'audio/mp4',
          totalBytes: 120000,
          duration: 15,
          title: 'Social Clip',
          pageUrl: 'https://www.instagram.com/reel/abc'
        }
      },
      { tab: { id: 88 }, frameId: 2 },
      () => {}
    );
  }
  await new Promise((resolve) => setTimeout(resolve, 20));

  const tabMediaResp = await dispatchRuntimeMessage({
    type: MESSAGE_TYPES.GET_MEDIA_FOR_TAB,
    tabId: 88,
    tabUrl: 'https://www.instagram.com/reel/abc'
  });
  assert.equal(tabMediaResp.ok, true);
  assert.ok(tabMediaResp.items.some((item) => item.isMse && item.mseId === 'mse_55'));

  const siteResp = await dispatchRuntimeMessage(
    {
      type: MESSAGE_TYPES.DOWNLOAD_SITE_VIDEO,
      payload: {
        requestId: 'site_req_1',
        siteId: 'instagram',
        title: 'Instagram Reel Title',
        pageUrl: 'https://www.instagram.com/reel/abc'
      }
    },
    { tab: { id: 88, url: 'https://www.instagram.com/reel/abc' } }
  );
  assert.equal(siteResp.ok, true);
  assert.equal(tabMessages.length, 1);
  assert.equal(tabMessages[0].tabId, 88);
  assert.equal(tabMessages[0].msg.type, MESSAGE_TYPES.EXPORT_MSE_STREAM);
  assert.equal(tabMessages[0].msg.mseId, 'mse_55');
  assert.equal(tabMessages[0].opts.frameId, 2);

  await dispatchRuntimeMessage({
    type: MESSAGE_TYPES.INSPECT_HLS,
    url: 'https://cdn-protected.example.org/hls/master.m3u8',
    referer: 'https://player.example.com/watch/123'
  }).catch(() => {});
  assert.ok(dnrUpdates.some((u) => Array.isArray(u.addRules) && u.addRules[0].action.requestHeaders[0].value === 'https://player.example.com/watch/123'));
  assert.ok(dnrUpdates.some((u) => Array.isArray(u.removeRuleIds) && u.removeRuleIds.length === 1 && !u.addRules));

  const pingResp = await dispatchRuntimeMessage({ type: MESSAGE_TYPES.CHECK_COMPANION });
  assert.equal(pingResp.ok, true);
  assert.equal(pingResp.available, true);
  assert.equal(pingResp.ytDlpVersion, '2026.01.01');

  const dlCompanionResp = await dispatchRuntimeMessage({
    type: MESSAGE_TYPES.DOWNLOAD_WITH_COMPANION,
    payload: {
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      referer: 'https://www.youtube.com/'
    }
  });
  assert.equal(dlCompanionResp.ok, true);
  assert.equal(nativeMessages[1].msg.action, 'download');
});

test('service_worker applies same-origin/CDN DNR rules, correlates multi-video blobUrl, and streams connectNative progress', async () => {
  dnrUpdates.length = 0;
  tabMessages.length = 0;
  runtimeBroadcasts.length = 0;

  // Same-origin HLS request must still install an initiator-scoped *://*/* DNR rule
  await dispatchRuntimeMessage({
    type: MESSAGE_TYPES.INSPECT_HLS,
    url: 'https://player.example.com/cdn/master.m3u8',
    referer: 'https://player.example.com/watch/1'
  }).catch(() => {});

  const addEntry = dnrUpdates.find((u) => Array.isArray(u.addRules));
  assert.ok(addEntry);
  assert.equal(addEntry.addRules[0].condition.urlFilter, '*://*/*');
  assert.deepEqual(addEntry.addRules[0].condition.initiatorDomains, ['test-ext-id']);

  // Multi-video feed correlation via blobUrl must pick matching MSE item over unrelated network MP4 or larger MSE item
  sessionStore.set(`${STORAGE_KEYS.TAB_MEDIA_PREFIX}91`, [
    {
      url: 'https://cdn.instagram.com/unrelated_large.mp4',
      type: 'video',
      ext: 'mp4',
      sizeBytes: 900000
    }
  ]);
  for (const handler of messageHandlers) {
    handler(
      {
        type: MESSAGE_TYPES.MSE_STREAM_UPDATED,
        stream: {
          mseId: 'mse_first',
          url: 'mse://mse_first',
          blobUrl: 'blob:https://www.instagram.com/vid-1',
          mimeType: 'video/mp4',
          totalBytes: 500000,
          pageUrl: 'https://www.instagram.com/'
        }
      },
      { tab: { id: 91 }, frameId: 0 },
      () => {}
    );
    handler(
      {
        type: MESSAGE_TYPES.MSE_STREAM_UPDATED,
        stream: {
          mseId: 'mse_second',
          url: 'mse://mse_second',
          blobUrl: 'blob:https://www.instagram.com/vid-2',
          mimeType: 'video/mp4',
          totalBytes: 120000,
          pageUrl: 'https://www.instagram.com/'
        }
      },
      { tab: { id: 91 }, frameId: 3 },
      () => {}
    );
  }
  await new Promise((resolve) => setTimeout(resolve, 25));

  const siteResp = await dispatchRuntimeMessage(
    {
      type: MESSAGE_TYPES.DOWNLOAD_SITE_VIDEO,
      payload: {
        requestId: 'site_req_blob',
        siteId: 'instagram',
        pageUrl: 'https://www.instagram.com/',
        blobUrl: 'blob:https://www.instagram.com/vid-2'
      }
    },
    { tab: { id: 91, url: 'https://www.instagram.com/' } }
  );
  assert.equal(siteResp.ok, true);
  assert.equal(tabMessages.length, 1);
  assert.equal(tabMessages[0].msg.mseId, 'mse_second');
  assert.equal(tabMessages[0].opts.frameId, 3);

  // connectNative streaming progress + enableCompanionCookies flag
  syncStore.set(STORAGE_KEYS.USER_SETTINGS, { enableCompanionCookies: true });
  globalThis.chrome.runtime.connectNative = (hostName) => {
    const messageListeners = [];
    const disconnectListeners = [];
    const posted = [];
    const port = {
      hostName,
      posted,
      onMessage: { addListener: (fn) => messageListeners.push(fn) },
      onDisconnect: { addListener: (fn) => disconnectListeners.push(fn) },
      disconnect: () => {},
      postMessage: (msg) => {
        posted.push(msg);
        queueMicrotask(() => {
          for (const fn of messageListeners) {
            fn({ event: 'progress', percent: 45 });
            fn({ event: 'done', ok: true, outputDir: 'C:\\Downloads\\MediaHarvest' });
          }
        });
      }
    };
    nativePorts.push(port);
    return port;
  };

  const dlStreamResp = await dispatchRuntimeMessage({
    type: MESSAGE_TYPES.DOWNLOAD_WITH_COMPANION,
    payload: {
      url: 'https://vimeo.com/123456',
      referer: 'https://vimeo.com/'
    }
  });
  assert.equal(dlStreamResp.ok, true);
  assert.equal(nativePorts.length, 1);
  assert.equal(nativePorts[0].posted[0].cookiesBrowser, 'chrome');
  assert.equal(nativePorts[0].posted[0].streamProgress, true);
  assert.ok(runtimeBroadcasts.some((m) => m.type === MESSAGE_TYPES.COMPANION_PROGRESS && m.percent === 45));

  // Image conversion via OFFSCREEN_CONVERT_IMAGE routes offscreen blob to chrome.downloads.download
  const prevOffscreenResponder = offscreenResponder;
  offscreenResponder = async (msg) => ({
    ok: true,
    blobUrl: 'blob:chrome-extension://id/conv-png',
    outputExtension: msg.targetFormat || 'png'
  });
  try {
    const convResp = await dispatchRuntimeMessage({
      type: MESSAGE_TYPES.DOWNLOAD_MEDIA,
      payload: {
        url: 'data:image/svg+xml;charset=utf-8,%3Csvg%3E%3C%2Fsvg%3E',
        convertTo: 'png',
        width: 48,
        height: 48,
        filename: 'logo.png',
        requestId: 'req_conv_svg_1'
      }
    });
    assert.equal(convResp.ok, true);
    assert.ok(offscreenMessages.some((m) => m.type === MESSAGE_TYPES.OFFSCREEN_CONVERT_IMAGE && m.targetFormat === 'png'));
    assert.ok(downloads.some((d) => d.url === 'blob:chrome-extension://id/conv-png' && d.filename === 'logo.png'));
  } finally {
    offscreenResponder = prevOffscreenResponder;
  }

  // Live HLS DVR recording dispatches OFFSCREEN_RECORD_HLS_LIVE and STOP_LIVE_RECORD forwards stop signal
  offscreenMessages.length = 0;
  const liveResp = await dispatchRuntimeMessage({
    type: MESSAGE_TYPES.DOWNLOAD_MEDIA,
    payload: {
      url: 'https://cdn.example.com/live/stream.m3u8',
      playlistUrl: 'https://cdn.example.com/live/720.m3u8',
      isStream: true,
      recordLive: true,
      filename: 'live_show.mp4',
      requestId: 'req_live_1'
    }
  });
  assert.equal(liveResp.ok, true);
  assert.ok(offscreenMessages.some((m) => m.type === MESSAGE_TYPES.OFFSCREEN_RECORD_HLS_LIVE && m.requestId === 'req_live_1'));

  const stopResp = await dispatchRuntimeMessage({
    type: MESSAGE_TYPES.STOP_LIVE_RECORD,
    requestId: 'req_live_1'
  });
  assert.equal(stopResp.ok, true);
  assert.ok(offscreenMessages.some((m) => m.type === MESSAGE_TYPES.OFFSCREEN_STOP_LIVE_RECORD && m.requestId === 'req_live_1'));

  // Live DVR recording updates badge to red REC while active and restores count after completion
  badgeHistory.length = 0;
  downloads.length = 0;
  offscreenMessages.length = 0;
  let releaseLiveBuild;
  offscreenResponder = (msg) => {
    if (msg && msg.type === MESSAGE_TYPES.OFFSCREEN_RECORD_HLS_LIVE) {
      return new Promise((resolve) => {
        releaseLiveBuild = resolve;
      });
    }
    return Promise.resolve({ ok: true });
  };
  const liveBadgePromise = dispatchRuntimeMessage({
    type: MESSAGE_TYPES.DOWNLOAD_MEDIA,
    payload: {
      url: 'https://cdn.example.com/live/channel.m3u8',
      playlistUrl: 'https://cdn.example.com/live/720.m3u8',
      isStream: true,
      recordLive: true,
      tabId: 12,
      filename: 'channel.mp4',
      requestId: 'req_live_badge'
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(badgeHistory.some((b) => b.text === BADGE_CONFIG.REC_TEXT && b.color === BADGE_CONFIG.REC_COLOR));
  releaseLiveBuild({ ok: true, blobUrl: 'blob:chrome-extension://id/live-badge', outputExtension: 'mp4' });
  const liveBadgeResp = await liveBadgePromise;
  assert.equal(liveBadgeResp.ok, true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(badgeColor, BADGE_CONFIG.BACKGROUND_COLOR);
  assert.notEqual(badgeText, BADGE_CONFIG.REC_TEXT);

  // EXPORT_BATCH_ZIP invokes OFFSCREEN_BUILD_ZIP_BLOB and downloads archive.zip
  offscreenResponder = async () => ({
    ok: true,
    blobUrl: 'blob:chrome-extension://id/batch-zip-1',
    outputExtension: 'zip'
  });
  const zipResp = await dispatchRuntimeMessage({
    type: MESSAGE_TYPES.EXPORT_BATCH_ZIP,
    payload: {
      items: [{ url: 'https://cdn.example.com/a.jpg', filename: 'a.jpg', ext: 'jpg' }],
      filename: 'gallery',
      referer: 'https://example.com/',
      requestId: 'req_zip_1'
    }
  });
  assert.equal(zipResp.ok, true);
  assert.ok(offscreenMessages.some((m) => m.type === MESSAGE_TYPES.OFFSCREEN_BUILD_ZIP_BLOB && m.requestId === 'req_zip_1'));
  assert.ok(downloads.some((d) => d.filename === 'gallery.zip'));

  // START_TAB_CAPTURE requests chrome.tabCapture streamId, marks REC badge, exposes GET_ACTIVE_BUILDS, and STOP_TAB_CAPTURE stops it
  badgeHistory.length = 0;
  downloads.length = 0;
  offscreenMessages.length = 0;
  let capturedStreamTargetTab = null;
  let releaseTabCap;
  globalThis.chrome.tabCapture = {
    getMediaStreamId: async ({ targetTabId }) => {
      capturedStreamTargetTab = targetTabId;
      return 'stream_id_tab_44';
    }
  };
  offscreenResponder = (msg) => {
    if (msg && msg.type === MESSAGE_TYPES.OFFSCREEN_START_TAB_CAPTURE) {
      return new Promise((resolve) => {
        releaseTabCap = resolve;
      });
    }
    return Promise.resolve({ ok: true });
  };
  const capPromise = dispatchRuntimeMessage({
    type: MESSAGE_TYPES.START_TAB_CAPTURE,
    payload: {
      tabId: 44,
      tabUrl: 'https://example.com/watch',
      title: 'Live Broadcast',
      requestId: 'req_tabcap_1'
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(capturedStreamTargetTab, 44);
  assert.ok(offscreenMessages.some((m) => m.type === MESSAGE_TYPES.OFFSCREEN_START_TAB_CAPTURE && m.streamId === 'stream_id_tab_44'));
  assert.ok(badgeHistory.some((b) => b.text === BADGE_CONFIG.REC_TEXT && b.color === BADGE_CONFIG.REC_COLOR));

  const buildsSnap = await dispatchRuntimeMessage({ type: MESSAGE_TYPES.GET_ACTIVE_BUILDS });
  assert.equal(buildsSnap.ok, true);
  assert.ok(buildsSnap.builds.some((b) => b.requestId === 'req_tabcap_1' && b.isTabCapture === true));

  const stopCapResp = await dispatchRuntimeMessage({
    type: MESSAGE_TYPES.STOP_TAB_CAPTURE,
    requestId: 'req_tabcap_1'
  });
  assert.equal(stopCapResp.ok, true);
  assert.ok(offscreenMessages.some((m) => m.type === MESSAGE_TYPES.OFFSCREEN_STOP_TAB_CAPTURE && m.requestId === 'req_tabcap_1'));

  releaseTabCap({ ok: true, blobUrl: 'blob:chrome-extension://id/tab-cap-1', outputExtension: 'webm' });
  const capDoneResp = await capPromise;
  assert.equal(capDoneResp.ok, true);
  assert.ok(downloads.some((d) => d.filename === 'Live_Broadcast.webm'));
  delete globalThis.chrome.tabCapture;
});

test('service_worker DOWNLOAD_SITE_VIDEO prefers matching muxed stream or companion audio over split video-only URLs', async () => {
  offscreenMessages.length = 0;

  // Case 1: Reddit DASH_720.mp4 video-only directVideoUrl with matching HLSPlaylist.m3u8 in tab network media
  sessionStore.set(`${STORAGE_KEYS.TAB_MEDIA_PREFIX}101`, [
    {
      url: 'https://v.redd.it/xyz123/DASH_720.mp4?source=fallback',
      type: 'video',
      ext: 'mp4',
      isStream: false
    },
    {
      url: 'https://v.redd.it/xyz123/HLSPlaylist.m3u8?a=1',
      type: 'stream',
      ext: 'mp4',
      isStream: true
    }
  ]);

  const respStream = await dispatchRuntimeMessage(
    {
      type: MESSAGE_TYPES.DOWNLOAD_SITE_VIDEO,
      payload: {
        requestId: 'site_reddit_stream',
        siteId: 'reddit',
        pageUrl: 'https://www.reddit.com/r/videos/comments/xyz123/',
        directVideoUrl: 'https://v.redd.it/xyz123/DASH_720.mp4?source=fallback'
      }
    },
    { tab: { id: 101, url: 'https://www.reddit.com/r/videos/comments/xyz123/' } }
  );
  assert.equal(respStream.ok, true);
  const streamBuildMsg = offscreenMessages.find((m) => m.requestId === 'site_reddit_stream');
  assert.ok(streamBuildMsg);
  assert.equal(streamBuildMsg.playlistUrl, 'https://v.redd.it/xyz123/HLSPlaylist.m3u8?a=1');

  // Case 2: Split DASH_720.mp4 + DASH_AUDIO_128.mp4 without manifest pairs progressiveMux cleanly
  offscreenMessages.length = 0;
  sessionStore.set(`${STORAGE_KEYS.TAB_MEDIA_PREFIX}102`, [
    {
      url: 'https://v.redd.it/abc456/DASH_720.mp4',
      type: 'video',
      ext: 'mp4',
      isStream: false
    },
    {
      url: 'https://v.redd.it/abc456/DASH_AUDIO_128.mp4',
      type: 'audio',
      ext: 'mp4',
      isStream: false
    }
  ]);

  const respPaired = await dispatchRuntimeMessage(
    {
      type: MESSAGE_TYPES.DOWNLOAD_SITE_VIDEO,
      payload: {
        requestId: 'site_reddit_paired',
        siteId: 'reddit',
        pageUrl: 'https://www.reddit.com/r/videos/comments/abc456/',
        directVideoUrl: 'https://v.redd.it/abc456/DASH_720.mp4'
      }
    },
    { tab: { id: 102, url: 'https://www.reddit.com/r/videos/comments/abc456/' } }
  );
  assert.equal(respPaired.ok, true);
  const pairedBuildMsg = offscreenMessages.find((m) => m.requestId === 'site_reddit_paired');
  assert.ok(pairedBuildMsg);
  assert.equal(pairedBuildMsg.progressiveMux, true);
  assert.equal(pairedBuildMsg.originalUrl, 'https://v.redd.it/abc456/DASH_720.mp4');
  assert.equal(pairedBuildMsg.audioUrl, 'https://v.redd.it/abc456/DASH_AUDIO_128.mp4');
});
