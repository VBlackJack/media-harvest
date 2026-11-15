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
  DEFAULT_SETTINGS,
  IMAGE_CONVERT_FORMATS,
  MESSAGE_TYPES,
  POPUP_VIEW_MODES,
  SORT_MODES,
  STORAGE_KEYS
} from '../src/config/constants.js';
import { createPopupController } from '../src/popup/popup.js';

function createFakeNode(tagName, id = '', initialClasses = []) {
  const classes = new Set(initialClasses);
  const attrs = new Map();
  const listeners = new Map();
  const children = [];
  let selectedIdx = 0;
  let explicitValue = '';

  const node = {
    tagName: tagName.toUpperCase(),
    id,
    type: '',
    value: '',
    textContent: '',
    title: '',
    src: '',
    alt: '',
    loading: '',
    disabled: false,
    dataset: {},
    parentNode: null,
    children,
    get isConnected() {
      let cur = node;
      while (cur.parentNode) {
        cur = cur.parentNode;
      }
      return cur.id === 'ROOT';
    },
    get nextSibling() {
      if (!node.parentNode) {
        return null;
      }
      const siblings = node.parentNode.children;
      const idx = siblings.indexOf(node);
      return idx >= 0 && idx + 1 < siblings.length ? siblings[idx + 1] : null;
    },
    classList: {
      add: (...list) => list.forEach((c) => classes.add(c)),
      remove: (...list) => list.forEach((c) => classes.delete(c)),
      toggle: (c, force) => (force === undefined
        ? (classes.has(c) ? (classes.delete(c), false) : (classes.add(c), true))
        : (force ? (classes.add(c), true) : (classes.delete(c), false))),
      contains: (c) => classes.has(c)
    },
    setAttribute: (k, v) => attrs.set(k, String(v)),
    getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
    addEventListener: (ev, fn) => {
      if (!listeners.has(ev)) {
        listeners.set(ev, []);
      }
      listeners.get(ev).push(fn);
    },
    dispatchEvent: async (ev) => {
      for (const fn of listeners.get(ev.type) || []) {
        await fn(ev);
      }
    },
    appendChild: (child) => {
      if (child.parentNode) {
        const oldList = child.parentNode.children;
        const oldIdx = oldList.indexOf(child);
        if (oldIdx >= 0) {
          oldList.splice(oldIdx, 1);
        }
      }
      child.parentNode = node;
      children.push(child);
      return child;
    },
    insertBefore: (child, anchor) => {
      if (child.parentNode) {
        const oldList = child.parentNode.children;
        const oldIdx = oldList.indexOf(child);
        if (oldIdx >= 0) {
          oldList.splice(oldIdx, 1);
        }
      }
      child.parentNode = node;
      if (!anchor) {
        children.push(child);
        return child;
      }
      const anchorIdx = children.indexOf(anchor);
      if (anchorIdx < 0) {
        children.push(child);
      } else {
        children.splice(anchorIdx, 0, child);
      }
      return child;
    },
    remove: () => {
      if (node.parentNode) {
        const idx = node.parentNode.children.indexOf(node);
        if (idx >= 0) {
          node.parentNode.children.splice(idx, 1);
        }
        node.parentNode = null;
      }
    },
    append: (...nodes) => nodes.forEach((n) => node.appendChild(n)),
    replaceChildren: (...nodes) => {
      children.forEach((c) => {
        c.parentNode = null;
      });
      children.length = 0;
      nodes.forEach((n) => node.appendChild(n));
    },
    querySelector: (sel) => {
      if (sel.startsWith('.')) {
        const cls = sel.slice(1);
        return children.find((c) => c.classList.contains(cls)) || null;
      }
      return children.find((c) => c.tagName === sel.toUpperCase()) || null;
    },
    get options() {
      return children;
    },
    get selectedIndex() {
      return selectedIdx;
    },
    set selectedIndex(idx) {
      selectedIdx = idx;
      explicitValue = children[idx] ? children[idx].value : '';
    }
  };

  if (tagName === 'select') {
    Object.defineProperty(node, 'value', {
      get: () => explicitValue || (children[selectedIdx] ? children[selectedIdx].value : ''),
      set: (v) => {
        explicitValue = v;
        const found = children.findIndex((c) => c.value === v);
        if (found >= 0) {
          selectedIdx = found;
        }
      }
    });
  }

  Object.defineProperty(node, 'className', {
    get: () => Array.from(classes).join(' '),
    set: (val) => {
      classes.clear();
      for (const part of String(val).split(/\s+/).filter(Boolean)) {
        classes.add(part);
      }
    }
  });

  return node;
}

function createFakePopupDocument() {
  const root = createFakeNode('body', 'ROOT');
  const ids = new Map();
  const makeTracked = (tag, id, cls = []) => {
    const el = createFakeNode(tag, id, cls);
    root.appendChild(el);
    ids.set(id, el);
    return el;
  };

  makeTracked('main', 'mediaList');
  makeTracked('div', 'hintBanner', ['hidden']);
  makeTracked('div', 'statusBanner', ['hidden']);
  makeTracked('input', 'searchInput');
  makeTracked('select', 'sortSelect');
  makeTracked('button', 'viewModeBtn');
  makeTracked('select', 'imageConvertSelect', ['hidden']);
  makeTracked('div', 'selectionBar', ['hidden']);
  makeTracked('button', 'selectAllBtn');
  makeTracked('button', 'clearSelectionBtn', ['hidden']);
  makeTracked('button', 'downloadSelectedBtn');
  makeTracked('button', 'downloadAllBtn', ['hidden']);
  makeTracked('button', 'stopBatchBtn', ['hidden']);
  makeTracked('div', 'batchConfirmBar', ['hidden']);
  makeTracked('span', 'batchConfirmText');
  makeTracked('button', 'batchConfirmBtn');
  makeTracked('button', 'batchCancelBtn');
  makeTracked('button', 'refreshBtn');
  makeTracked('button', 'reloadTabBtn');
  makeTracked('button', 'clearBtn');
  makeTracked('button', 'sidePanelBtn');
  makeTracked('button', 'optionsBtn');
  makeTracked('span', 'countAll');
  makeTracked('span', 'countVideos');
  makeTracked('span', 'countImages');
  makeTracked('span', 'countSvg');
  makeTracked('span', 'countAudio');
  makeTracked('span', 'countSubtitles');

  const filterAll = makeTracked('button', 'filterAll', ['filter-btn', 'active']);
  filterAll.dataset.filter = 'all';
  const filterVideos = makeTracked('button', 'filterVideos', ['filter-btn']);
  filterVideos.dataset.filter = 'videos';
  const filterImages = makeTracked('button', 'filterImages', ['filter-btn']);
  filterImages.dataset.filter = 'images';
  const filterSvg = makeTracked('button', 'filterSvg', ['filter-btn']);
  filterSvg.dataset.filter = 'svg';
  const filterAudio = makeTracked('button', 'filterAudio', ['filter-btn']);
  filterAudio.dataset.filter = 'audio';
  const filterSubtitles = makeTracked('button', 'filterSubtitles', ['filter-btn']);
  filterSubtitles.dataset.filter = 'subtitles';

  return {
    documentElement: { lang: '' },
    getElementById: (id) => ids.get(id) || null,
    querySelectorAll: (sel) => (
      sel === '.filter-btn'
        ? [filterAll, filterVideos, filterImages, filterSvg, filterAudio, filterSubtitles]
        : []
    ),
    createElement: (tag) => createFakeNode(tag),
    createElementNS: (_ns, tag) => createFakeNode(tag)
  };
}

test('popup controller filters, searches, sorts, bounds INSPECT_HLS concurrency, and passes promptSaveAs', async () => {
  const doc = createFakePopupDocument();
  const winListeners = new Map();
  const sentMessages = [];
  let activeInspects = 0;
  let maxActiveInspects = 0;

  const items = [
    {
      url: 'https://cdn.example.com/small.jpg',
      type: 'image',
      isStream: false,
      source: 'dom',
      suggestedFilename: 'small.jpg',
      sizeBytes: 200
    },
    {
      url: 'https://cdn.example.com/s1.m3u8',
      type: 'stream',
      isStream: true,
      source: 'network',
      suggestedFilename: 'alpha.mp4'
    },
    {
      url: 'https://cdn.example.com/s2.m3u8',
      type: 'stream',
      isStream: true,
      source: 'network',
      suggestedFilename: 'beta.mp4'
    },
    {
      url: 'https://cdn.example.com/s3.m3u8',
      type: 'stream',
      isStream: true,
      source: 'network',
      suggestedFilename: 'gamma.mp4'
    },
    {
      url: 'https://cdn.example.com/s4.m3u8',
      type: 'stream',
      isStream: true,
      source: 'network',
      suggestedFilename: 'delta.mp4'
    }
  ];

  const chromeApi = {
    tabs: {
      query: async () => [{ id: 10, url: 'https://example.com/watch' }],
      onUpdated: { addListener: () => {}, removeListener: () => {} },
      onRemoved: { addListener: () => {}, removeListener: () => {} }
    },
    runtime: {
      onMessage: { addListener: () => {} },
      sendMessage: async (msg) => {
        sentMessages.push(msg);
        if (msg.type === MESSAGE_TYPES.GET_MEDIA_FOR_TAB) {
          return { ok: true, items, hasBlobVideo: false };
        }
        if (msg.type === MESSAGE_TYPES.INSPECT_HLS) {
          activeInspects += 1;
          maxActiveInspects = Math.max(maxActiveInspects, activeInspects);
          await new Promise((resolve) => setTimeout(resolve, 10));
          activeInspects -= 1;
          return {
            ok: true,
            streamFormat: 'hls',
            encrypted: false,
            isDynamic: false,
            totalDurationSec: 30,
            variants: [{ url: msg.url, bandwidth: 1000000, estimatedBytes: 4096 }]
          };
        }
        if (msg.type === MESSAGE_TYPES.DOWNLOAD_MEDIA) {
          return { ok: true, downloadId: 1, requestId: msg.payload.requestId };
        }
        return { ok: true };
      }
    }
  };

  const controller = createPopupController({
    documentRef: doc,
    windowRef: { addEventListener: (ev, fn) => winListeners.set(ev, fn) },
    chromeApi,
    loadSettingsFn: async () => ({ ...DEFAULT_SETTINGS, promptSaveAs: true }),
    translateFn: (k, args = []) => (args.length ? `${k}:${args.join(',')}` : k),
    getUiLanguageFn: () => 'en',
    applyTranslationsFn: () => {},
    batchDelayMs: 0
  });

  await controller.init();
  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.ok(maxActiveInspects <= 3 && maxActiveInspects >= 2);
  assert.equal(controller.els.countAll.textContent, '5');
  assert.equal(controller.els.countVideos.textContent, '4');
  assert.equal(controller.els.countImages.textContent, '1');
  assert.equal(winListeners.has('pagehide'), true);

  // Filter + search narrows visible cards cleanly
  controller.els.searchInput.value = 'gamma';
  await controller.els.searchInput.dispatchEvent({ type: 'input' });
  const visibleCards = controller.els.mediaList.children.filter((c) => !c.classList.contains('hidden'));
  assert.equal(visibleCards.length, 1);

  // Triggering download forwards promptSaveAs=true
  const gammaEntry = controller.state.cardsByUrl.get('https://cdn.example.com/s3.m3u8');
  await controller.triggerDownload(gammaEntry, gammaEntry.item.url);
  const dlMsg = sentMessages.find((m) => m.type === MESSAGE_TYPES.DOWNLOAD_MEDIA);
  assert.equal(dlMsg.payload.saveAs, true);
});

test('popup controller requires in-DOM confirmation at BATCH_CONFIRM_THRESHOLD and supports stopping mid-batch', async () => {
  const doc = createFakePopupDocument();
  const downloadedUrls = [];
  let stopTriggered = false;

  const manyImages = Array.from({ length: 12 }, (_, idx) => ({
    url: `https://cdn.example.com/img_${idx}.jpg`,
    type: 'image',
    isStream: false,
    source: 'dom',
    suggestedFilename: `img_${idx}.jpg`
  }));

  let controller;
  const chromeApi = {
    tabs: {
      query: async () => [{ id: 11, url: 'https://example.com/gallery' }],
      onUpdated: { addListener: () => {}, removeListener: () => {} },
      onRemoved: { addListener: () => {}, removeListener: () => {} }
    },
    runtime: {
      onMessage: { addListener: () => {} },
      sendMessage: async (msg) => {
        if (msg.type === MESSAGE_TYPES.GET_MEDIA_FOR_TAB) {
          return { ok: true, items: manyImages, hasBlobVideo: false };
        }
        if (msg.type === MESSAGE_TYPES.DOWNLOAD_MEDIA) {
          downloadedUrls.push(msg.payload.url);
          if (downloadedUrls.length === 2 && !stopTriggered) {
            stopTriggered = true;
            await controller.els.stopBatchBtn.dispatchEvent({ type: 'click' });
          }
          return { ok: true, downloadId: downloadedUrls.length };
        }
        return { ok: true };
      }
    }
  };

  controller = createPopupController({
    documentRef: doc,
    windowRef: { addEventListener: () => {} },
    chromeApi,
    loadSettingsFn: async () => DEFAULT_SETTINGS,
    translateFn: (k, args = []) => (args.length ? `${k}:${args.join(',')}` : k),
    getUiLanguageFn: () => 'en',
    applyTranslationsFn: () => {},
    batchDelayMs: 0
  });

  await controller.init();
  assert.equal(controller.els.downloadAllBtn.classList.contains('hidden'), false);
  assert.equal(controller.els.batchConfirmBar.classList.contains('hidden'), true);

  await controller.els.downloadAllBtn.dispatchEvent({ type: 'click' });
  assert.equal(controller.els.batchConfirmBar.classList.contains('hidden'), false);
  assert.equal(controller.els.batchConfirmText.textContent, 'popup_confirm_download_all:12');
  assert.equal(downloadedUrls.length, 0);

  await controller.els.batchConfirmBtn.dispatchEvent({ type: 'click' });
  assert.equal(downloadedUrls.length, 2);
  assert.equal(controller.els.statusBanner.textContent, 'popup_status_download_cancelled');
});

test('popup controller reattaches active builds, handles filtered empty state reset, and summarizes partial batch failures', async () => {
  const doc = createFakePopupDocument();
  const items = [
    {
      url: 'https://cdn.example.com/live.m3u8',
      type: 'stream',
      isStream: true,
      source: 'network',
      suggestedFilename: 'live.mp4'
    },
    {
      url: 'https://cdn.example.com/ok.jpg',
      type: 'image',
      isStream: false,
      source: 'dom',
      suggestedFilename: 'ok.jpg'
    },
    {
      url: 'https://cdn.example.com/bad.jpg',
      type: 'image',
      isStream: false,
      source: 'dom',
      suggestedFilename: 'bad.jpg'
    }
  ];

  const chromeApi = {
    tabs: {
      query: async () => [{ id: 15, url: 'https://example.com/feed' }],
      onUpdated: { addListener: () => {}, removeListener: () => {} },
      onRemoved: { addListener: () => {}, removeListener: () => {} }
    },
    runtime: {
      onMessage: { addListener: () => {} },
      sendMessage: async (msg) => {
        if (msg.type === MESSAGE_TYPES.GET_MEDIA_FOR_TAB) {
          return { ok: true, items, hasBlobVideo: false };
        }
        if (msg.type === MESSAGE_TYPES.GET_ACTIVE_BUILDS) {
          return {
            ok: true,
            builds: [{ requestId: 'req-bg-1', url: 'https://cdn.example.com/live.m3u8', done: 4, total: 10 }]
          };
        }
        if (msg.type === MESSAGE_TYPES.INSPECT_HLS) {
          return { ok: false, error: 'FETCH_TIMEOUT' };
        }
        if (msg.type === MESSAGE_TYPES.DOWNLOAD_MEDIA) {
          if (msg.payload.url.endsWith('bad.jpg')) {
            return { ok: false, error: 'HTTP 403' };
          }
          return { ok: true, downloadId: 9 };
        }
        return { ok: true };
      }
    }
  };

  const controller = createPopupController({
    documentRef: doc,
    windowRef: { addEventListener: () => {} },
    chromeApi,
    loadSettingsFn: async () => DEFAULT_SETTINGS,
    translateFn: (k, args = []) => (args.length ? `${k}:${args.join(',')}` : k),
    getUiLanguageFn: () => 'en',
    applyTranslationsFn: () => {},
    batchDelayMs: 0
  });

  await controller.init();

  // Reattached active build preserves progress and cancel control across popup reopen
  const streamEntry = controller.state.cardsByUrl.get('https://cdn.example.com/live.m3u8');
  assert.equal(streamEntry.activeRequestId, 'req-bg-1');
  assert.equal(streamEntry.cancelBtn.classList.contains('hidden'), false);
  assert.equal(streamEntry.progressEl.textContent, 'popup_status_hls_segments:4,10');

  controller.handleRuntimeMessage({
    type: MESSAGE_TYPES.DOWNLOAD_FINISHED,
    requestId: 'req-bg-1',
    url: 'https://cdn.example.com/live.m3u8',
    ok: true
  });
  assert.equal(streamEntry.activeRequestId, '');
  assert.equal(streamEntry.cancelBtn.classList.contains('hidden'), true);
  assert.equal(streamEntry.downloadBtn.disabled, false);

  // Empty search state displays filter-specific message and Reset filters restores items
  controller.els.searchInput.value = 'no-match-query';
  await controller.els.searchInput.dispatchEvent({ type: 'input' });
  const emptyEl = controller.els.mediaList.querySelector('.empty-state');
  assert.ok(emptyEl);
  assert.equal(emptyEl.children[0].textContent, 'popup_status_filter_empty');
  await emptyEl.children[1].dispatchEvent({ type: 'click' });
  assert.equal(controller.els.searchInput.value, '');
  assert.equal(controller.els.mediaList.querySelector('.empty-state'), null);

  // Batch download reports partial failure count
  await controller.executeBatchDownloads(items.slice(1));
  assert.equal(
    controller.els.statusBanner.textContent,
    'popup_status_batch_partial:1,1,popup_error_download_failed:HTTP 403'
  );
});

test('popup controller supports multi-select mixed batches, subtitles filter, side panel open, and UI state persistence', async () => {
  const localStore = {
    [STORAGE_KEYS.POPUP_UI_STATE]: { filter: 'subtitles', sortBy: SORT_MODES.SIZE_DESC }
  };
  const items = [
    {
      url: 'https://cdn.example.com/captions.vtt',
      type: 'subtitle',
      ext: 'vtt',
      isStream: false,
      source: 'dom',
      suggestedFilename: 'captions.vtt',
      sizeBytes: 2048
    },
    {
      url: 'https://cdn.example.com/hls/master.m3u8',
      type: 'stream',
      ext: 'm3u8',
      isStream: true,
      source: 'network',
      suggestedFilename: 'video.mp4',
      sizeBytes: 5000000
    },
    {
      url: 'https://cdn.example.com/cover.jpg',
      type: 'image',
      ext: 'jpg',
      isStream: false,
      source: 'dom',
      suggestedFilename: 'cover.jpg',
      sizeBytes: 120000
    }
  ];

  const openedSidePanels = [];
  let winClosed = false;
  const downloadPayloads = [];
  const doc = createFakePopupDocument();

  const chromeApi = {
    storage: {
      local: {
        get: async (key) => ({ [key]: localStore[key] }),
        set: async (obj) => {
          Object.assign(localStore, obj);
        }
      }
    },
    windows: {
      getCurrent: async () => ({ id: 99 })
    },
    sidePanel: {
      open: async (opts) => openedSidePanels.push(opts)
    },
    tabs: {
      query: async () => [{ id: 21, windowId: 99, url: 'https://example.com/watch' }],
      onUpdated: { addListener: () => {}, removeListener: () => {} },
      onRemoved: { addListener: () => {}, removeListener: () => {} }
    },
    runtime: {
      onMessage: { addListener: () => {} },
      sendMessage: async (msg) => {
        if (msg.type === MESSAGE_TYPES.GET_MEDIA_FOR_TAB) {
          return { ok: true, items, hasBlobVideo: false };
        }
        if (msg.type === MESSAGE_TYPES.INSPECT_HLS) {
          return {
            ok: true,
            encrypted: false,
            isDynamic: false,
            variants: [{ url: 'https://cdn.example.com/hls/720.m3u8', resolution: '1280x720', bandwidth: 1500000 }],
            audioTracks: [],
            subtitles: []
          };
        }
        if (msg.type === MESSAGE_TYPES.DOWNLOAD_MEDIA) {
          downloadPayloads.push(msg.payload);
          return { ok: true, downloadId: downloadPayloads.length };
        }
        return { ok: true };
      }
    }
  };

  const controller = createPopupController({
    documentRef: doc,
    windowRef: {
      addEventListener: () => {},
      close: () => {
        winClosed = true;
      }
    },
    chromeApi,
    loadSettingsFn: async () => DEFAULT_SETTINGS,
    translateFn: (k, args = []) => (args.length ? `${k}:${args.join(',')}` : k),
    getUiLanguageFn: () => 'en',
    applyTranslationsFn: () => {},
    batchDelayMs: 0
  });

  await controller.init();

  // Restored filter='subtitles' and sortBy='size_desc' cleanly
  assert.equal(controller.state.filter, 'subtitles');
  assert.equal(controller.state.sortBy, SORT_MODES.SIZE_DESC);
  assert.equal(controller.els.countSubtitles.textContent, '1');
  assert.equal(controller.els.mediaList.children.filter((c) => !c.classList.contains('hidden')).length, 1);

  // Switch back to 'all', verify persistence updated
  await controller.els.filterBtns[0].dispatchEvent({ type: 'click' });
  assert.equal(localStore[STORAGE_KEYS.POPUP_UI_STATE].filter, 'all');
  assert.equal(controller.els.selectionBar.classList.contains('hidden'), false);
  assert.equal(controller.els.downloadSelectedBtn.disabled, true);

  // Select all, then deselect cover.jpg so only subtitle + HLS stream remain selected
  await controller.els.selectAllBtn.dispatchEvent({ type: 'click' });
  assert.equal(controller.els.downloadSelectedBtn.disabled, false);
  assert.equal(controller.els.downloadSelectedBtn.textContent, 'popup_action_download_selected:3');
  assert.equal(controller.els.selectAllBtn.textContent, 'popup_action_deselect_all');
  assert.equal(controller.els.clearSelectionBtn.classList.contains('hidden'), false);

  const coverEntry = controller.state.cardsByUrl.get('https://cdn.example.com/cover.jpg');
  coverEntry.selectCheckbox.checked = false;
  await coverEntry.selectCheckbox.dispatchEvent({ type: 'change' });
  assert.equal(controller.els.downloadSelectedBtn.textContent, 'popup_action_download_selected:2');

  // Clear selection resets all checkboxes and selection state
  await controller.els.clearSelectionBtn.dispatchEvent({ type: 'click' });
  assert.equal(controller.state.selectedUrls.size, 0);
  assert.equal(controller.els.clearSelectionBtn.classList.contains('hidden'), true);

  // Re-select for batch download
  await controller.els.selectAllBtn.dispatchEvent({ type: 'click' });
  coverEntry.selectCheckbox.checked = false;
  await coverEntry.selectCheckbox.dispatchEvent({ type: 'change' });

  await controller.els.downloadSelectedBtn.dispatchEvent({ type: 'click' });
  assert.equal(downloadPayloads.length, 2);
  assert.equal(downloadPayloads[0].isStream, true);
  assert.equal(downloadPayloads[0].playlistUrl, 'https://cdn.example.com/hls/720.m3u8');
  assert.equal(downloadPayloads[1].isStream, false);
  assert.equal(downloadPayloads[1].url, 'https://cdn.example.com/captions.vtt');

  // Side panel button opens panel for current window and closes popup
  await controller.els.sidePanelBtn.dispatchEvent({ type: 'click' });
  assert.deepEqual(openedSidePanels, [{ windowId: 99 }]);
  assert.equal(winClosed, true);
});

test('popup controller handles keyboard shortcuts, clear confirmation, and empty state guidance', async () => {
  const doc = createFakePopupDocument();
  let mediaList = [
    {
      url: 'https://cdn.example.com/video.mp4',
      type: 'video',
      source: 'dom',
      suggestedFilename: 'video.mp4'
    }
  ];

  const chromeApi = {
    tabs: {
      query: async () => [{ id: 10, url: 'https://example.com' }]
    },
    runtime: {
      onMessage: { addListener: () => {} },
      sendMessage: async (msg) => {
        if (msg.type === MESSAGE_TYPES.GET_MEDIA_FOR_TAB) {
          return { ok: true, items: mediaList, hasBlobVideo: false };
        }
        if (msg.type === MESSAGE_TYPES.CLEAR_MEDIA_FOR_TAB) {
          mediaList = [];
          return { ok: true };
        }
        return { ok: true };
      }
    },
    storage: {
      local: {
        get: async () => ({}),
        set: async () => {}
      },
      sync: {
        get: async () => ({})
      }
    }
  };

  const controller = createPopupController({
    documentRef: doc,
    windowRef: { addEventListener: () => {} },
    chromeApi,
    loadSettingsFn: async () => DEFAULT_SETTINGS,
    translateFn: (k) => k,
    getUiLanguageFn: () => 'en',
    applyTranslationsFn: () => {}
  });

  await controller.init();
  assert.equal(controller.state.items.length, 1);

  // Slash focuses search input
  let searchFocused = false;
  controller.els.searchInput.focus = () => { searchFocused = true; };
  controller.handleGlobalKeyDown({ key: '/', preventDefault: () => {} });
  assert.equal(searchFocused, true);

  // Escape clears search when focused
  doc.activeElement = controller.els.searchInput;
  controller.els.searchInput.value = 'findme';
  controller.state.searchQuery = 'findme';
  controller.handleGlobalKeyDown({ key: 'Escape' });
  assert.equal(controller.els.searchInput.value, '');
  assert.equal(controller.state.searchQuery, '');

  // Escape dismisses batch confirmation
  controller.state.pendingBatchItems = mediaList;
  assert.ok(controller.state.pendingBatchItems);
  controller.handleGlobalKeyDown({ key: 'Escape' });
  assert.equal(controller.state.pendingBatchItems, null);

  // Clear button acknowledges with status banner
  await controller.els.clearBtn.dispatchEvent({ type: 'click' });
  assert.equal(controller.els.statusBanner.textContent, 'popup_status_cleared');
  assert.equal(controller.els.statusBanner.classList.contains('hidden'), false);

  // Empty state displays both base message and playback guidance hint
  const emptyState = controller.els.mediaList.children.find((c) => c.classList.contains('empty-state'));
  assert.ok(emptyState);
  assert.equal(emptyState.children.length, 2);
  assert.equal(emptyState.children[0].textContent, 'popup_status_empty');
  assert.equal(emptyState.children[1].textContent, 'popup_status_empty_hint');
});

test('popup controller manages SVG filter, gallery grid persistence, and image conversion', async () => {
  const doc = createFakePopupDocument();
  const savedUiStates = [];
  const downloadPayloads = [];
  const items = [
    {
      url: 'https://cdn.example.com/photo.webp',
      type: 'image',
      ext: 'webp',
      isStream: false,
      source: 'dom',
      suggestedFilename: 'photo.webp'
    },
    {
      url: 'data:image/svg+xml;charset=utf-8,%3Csvg%3E%3Crect%2F%3E%3C%2Fsvg%3E',
      type: 'image',
      ext: 'svg',
      width: 32,
      height: 32,
      isStream: false,
      source: 'dom',
      svgMarkup: '<svg><rect/></svg>',
      suggestedFilename: 'logo.svg'
    }
  ];

  const chromeApi = {
    tabs: {
      query: async () => [{ id: 12, url: 'https://example.com' }]
    },
    runtime: {
      onMessage: { addListener: () => {} },
      sendMessage: async (msg) => {
        if (msg.type === MESSAGE_TYPES.GET_MEDIA_FOR_TAB) {
          return { ok: true, items, hasBlobVideo: false };
        }
        if (msg.type === MESSAGE_TYPES.DOWNLOAD_MEDIA) {
          downloadPayloads.push(msg.payload);
          return { ok: true };
        }
        return { ok: true };
      }
    },
    storage: {
      local: {
        get: async () => ({
          [STORAGE_KEYS.POPUP_UI_STATE]: {
            filter: 'all',
            sortBy: SORT_MODES.DEFAULT,
            viewMode: POPUP_VIEW_MODES.GRID
          }
        }),
        set: async (obj) => {
          savedUiStates.push(obj[STORAGE_KEYS.POPUP_UI_STATE]);
        }
      },
      sync: {
        get: async () => ({})
      }
    }
  };

  const controller = createPopupController({
    documentRef: doc,
    windowRef: { addEventListener: () => {} },
    chromeApi,
    loadSettingsFn: async () => DEFAULT_SETTINGS,
    translateFn: (k) => k,
    getUiLanguageFn: () => 'en',
    applyTranslationsFn: () => {}
  });

  await controller.init();
  assert.equal(controller.els.countSvg.textContent, '1');
  assert.equal(controller.els.mediaList.classList.contains('is-grid'), true);
  assert.equal(controller.els.imageConvertSelect.classList.contains('hidden'), false);

  // Toggling viewMode switches back to list and persists viewMode
  await controller.els.viewModeBtn.dispatchEvent({ type: 'click' });
  assert.equal(controller.state.viewMode, POPUP_VIEW_MODES.LIST);
  assert.equal(controller.els.mediaList.classList.contains('is-grid'), false);
  assert.equal(savedUiStates.at(-1).viewMode, POPUP_VIEW_MODES.LIST);

  // Switching to SVG filter hides non-SVG images
  await doc.getElementById('filterSvg').dispatchEvent({ type: 'click' });
  assert.equal(controller.state.filter, 'svg');
  assert.equal(controller.state.cardsByUrl.get('https://cdn.example.com/photo.webp').card.classList.contains('hidden'), true);
  assert.equal(controller.state.cardsByUrl.get('data:image/svg+xml;charset=utf-8,%3Csvg%3E%3Crect%2F%3E%3C%2Fsvg%3E').card.classList.contains('hidden'), false);

  // Clicking PNG convert chip dispatches convertTo='png' with .png filename
  const svgEntry = controller.state.cardsByUrl.get('data:image/svg+xml;charset=utf-8,%3Csvg%3E%3Crect%2F%3E%3C%2Fsvg%3E');
  await svgEntry.convertPngBtn.dispatchEvent({ type: 'click' });
  assert.equal(downloadPayloads.length, 1);
  assert.equal(downloadPayloads[0].convertTo, IMAGE_CONVERT_FORMATS.PNG);
  assert.equal(downloadPayloads[0].filename, 'logo.png');
  assert.ok(downloadPayloads[0].requestId);
});
