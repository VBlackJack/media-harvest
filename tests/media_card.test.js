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
import { DEFAULT_SETTINGS, LIMITS, QUALITY_PREFERENCES, UNIT_CONVERSIONS } from '../src/config/constants.js';
import {
  applyStreamMetadata,
  createMediaCard,
  markInspectionFailed,
  updateCardEntry
} from '../src/popup/media_card.js';

function createMockNode(tagName) {
  const classes = new Set();
  const attrs = new Map();
  const listeners = new Map();
  const children = [];
  let selectedIdx = 0;
  let explicitValue = '';

  const node = {
    tagName: tagName.toUpperCase(),
    type: '',
    className: '',
    title: '',
    textContent: '',
    src: '',
    alt: '',
    loading: '',
    disabled: false,
    dataset: {},
    parentNode: null,
    children,
    classList: {
      add: (...list) => list.forEach((c) => classes.add(c)),
      remove: (...list) => list.forEach((c) => classes.delete(c)),
      toggle: (c, force) => (force === undefined
        ? (classes.has(c) ? (classes.delete(c), false) : (classes.add(c), true))
        : (force ? (classes.add(c), true) : (classes.delete(c), false))),
      contains: (c) => classes.has(c)
    },
    set classNameValue(val) {
      node.className = val;
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
      child.parentNode = node;
      children.push(child);
      return child;
    },
    append: (...nodes) => {
      for (const child of nodes) {
        node.appendChild(child);
      }
    },
    replaceChildren: (...nodes) => {
      for (const oldChild of children) {
        oldChild.parentNode = null;
      }
      children.length = 0;
      for (const child of nodes) {
        node.appendChild(child);
      }
    },
    querySelector: () => null,
    get options() {
      return children;
    },
    get selectedIndex() {
      return selectedIdx;
    },
    set selectedIndex(idx) {
      selectedIdx = idx;
      explicitValue = children[idx] ? children[idx].value : '';
    },
    get value() {
      return explicitValue || (children[selectedIdx] ? children[selectedIdx].value : '');
    },
    set value(v) {
      explicitValue = v;
      const found = children.findIndex((c) => c.value === v);
      if (found >= 0) {
        selectedIdx = found;
      }
    }
  };

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

function createFakeDoc() {
  return {
    createElement: (tag) => createMockNode(tag),
    createElementNS: (_ns, tag) => createMockNode(tag)
  };
}

test('createMediaCard hydrates multi-track DASH audio selection, WebM video-only badge, and >512 MB cap warning', async () => {
  const doc = createFakeDoc();
  const hlsMetaByUrl = new Map();
  const downloads = [];
  const translateFn = (key, args = []) => (args.length ? `${key}:${args.join(',')}` : key);

  const item = {
    url: 'https://cdn.example.com/vod/manifest.mpd',
    type: 'stream',
    isStream: true,
    source: 'network',
    suggestedFilename: 'movie.mp4'
  };

  const entry = createMediaCard(item, {
    documentRef: doc,
    translateFn,
    hlsMetaByUrl,
    getSettings: () => ({ ...DEFAULT_SETTINGS, defaultQuality: QUALITY_PREFERENCES.BEST }),
    onDownload: (e, playlistUrl, audioUrl) => downloads.push({ url: e.item.url, playlistUrl, audioUrl }),
    onHydrateRequest: () => {}
  });

  const tooBigBytes = LIMITS.MAX_HLS_BUFFER_BYTES + UNIT_CONVERSIONS.BYTES_PER_MB;
  const meta = {
    streamFormat: 'dash',
    encrypted: false,
    isDynamic: false,
    totalDurationSec: 300,
    variants: [
      {
        url: 'https://cdn.example.com/vod/manifest.mpd#dash-video-vp9',
        resolution: '1920x1080',
        bandwidth: 8000000,
        mimeType: 'video/webm',
        audioGroup: 'dash-audio',
        estimatedBytes: tooBigBytes
      },
      {
        url: 'https://cdn.example.com/vod/manifest.mpd#dash-video-sd',
        resolution: '640x360',
        bandwidth: 500000,
        mimeType: 'video/mp4',
        audioGroup: 'dash-audio',
        estimatedBytes: 1024 * 1024
      }
    ],
    audioTracks: [
      { url: 'https://cdn.example.com/vod/manifest.mpd#dash-audio-en', groupId: 'dash-audio', language: 'en', name: 'English' },
      { url: 'https://cdn.example.com/vod/manifest.mpd#dash-audio-fr', groupId: 'dash-audio', language: 'fr', name: 'French' }
    ]
  };
  hlsMetaByUrl.set(item.url, meta);

  applyStreamMetadata(entry, meta, {
    documentRef: doc,
    translateFn,
    hlsMetaByUrl,
    getSettings: () => DEFAULT_SETTINGS
  });

  assert.equal(entry.qualitySelect.classList.contains('hidden'), false);
  assert.equal(entry.audioSelect.classList.contains('hidden'), false);
  assert.equal(entry.audioSelect.options.length, 2);
  assert.equal(entry.showingCapWarning, true);
  assert.ok(entry.progressEl.textContent.startsWith('popup_warning_exceeds_limit:'));

  const badgeLabels = entry.badgesEl.children.map((b) => b.textContent);
  assert.ok(badgeLabels.some((l) => l.startsWith('popup_badge_exceeds_limit:')));
  assert.ok(badgeLabels.includes('popup_badge_video_only'));

  // Switching to smaller MP4 variant clears cap warning and selects chosen French audio track
  entry.qualitySelect.selectedIndex = 1;
  await entry.qualitySelect.dispatchEvent({ type: 'change' });
  assert.equal(entry.showingCapWarning, false);
  assert.equal(entry.progressEl.classList.contains('hidden'), true);

  entry.audioSelect.selectedIndex = 1;
  await entry.downloadBtn.dispatchEvent({ type: 'click' });
  assert.deepEqual(downloads, [
    {
      url: item.url,
      playlistUrl: 'https://cdn.example.com/vod/manifest.mpd#dash-video-sd',
      audioUrl: 'https://cdn.example.com/vod/manifest.mpd#dash-audio-fr'
    }
  ]);
});

test('markInspectionFailed exposes retry button that re-enqueues hydration', async () => {
  const doc = createFakeDoc();
  let hydrateCount = 0;

  const entry = createMediaCard(
    {
      url: 'https://cdn.example.com/live/master.m3u8',
      type: 'stream',
      isStream: true,
      source: 'network',
      suggestedFilename: 'stream.mp4'
    },
    {
      documentRef: doc,
      translateFn: (k) => k,
      hlsMetaByUrl: new Map(),
      getSettings: () => DEFAULT_SETTINGS,
      onHydrateRequest: () => {
        hydrateCount += 1;
      }
    }
  );

  assert.equal(hydrateCount, 1);
  markInspectionFailed(entry, 'FETCH_TIMEOUT', {
    documentRef: doc,
    translateFn: (k, args = []) => (args.length ? `${k}:${args.join(',')}` : k)
  });
  assert.equal(entry.retryInspectBtn.classList.contains('hidden'), false);
  assert.equal(entry.progressEl.classList.contains('hidden'), false);
  assert.equal(entry.progressEl.textContent, 'popup_error_inspect_failed:popup_error_fetch_timeout');

  await entry.retryInspectBtn.dispatchEvent({ type: 'click' });
  assert.equal(entry.retryInspectBtn.classList.contains('hidden'), true);
  assert.equal(entry.progressEl.classList.contains('hidden'), true);
  assert.equal(hydrateCount, 2);

  applyStreamMetadata(
    entry,
    { encrypted: true, isDynamic: false, variants: [] },
    { documentRef: doc, translateFn: (k) => k, hlsMetaByUrl: new Map(), getSettings: () => DEFAULT_SETTINGS }
  );
  assert.equal(entry.downloadBtn.disabled, true);
  assert.equal(entry.previewBtn.disabled, true);
  assert.equal(entry.thumbEl.disabled, true);

  updateCardEntry(
    entry,
    {
      url: 'https://cdn.example.com/live/master.m3u8',
      type: 'stream',
      isStream: true,
      source: 'network',
      suggestedFilename: 'updated_name.mp4'
    },
    {
      documentRef: doc,
      translateFn: (k) => k,
      hlsMetaByUrl: new Map(),
      getSettings: () => DEFAULT_SETTINGS
    }
  );
  assert.equal(entry.nameEl.textContent, 'updated_name.mp4');
});

test('createMediaCard supports HLS subtitles, live stream blocking, audio preview, and quality refresh', async () => {
  const doc = createFakeDoc();
  let refreshedCount = 0;
  const subDownloads = [];
  const selectionEvents = [];
  const metaMap = new Map();

  const streamEntry = createMediaCard(
    {
      url: 'https://cdn.example.com/hls/master.m3u8',
      type: 'stream',
      isStream: true,
      source: 'network',
      suggestedFilename: 'movie.mp4'
    },
    {
      documentRef: doc,
      translateFn: (k) => k,
      hlsMetaByUrl: metaMap,
      getSettings: () => DEFAULT_SETTINGS,
      refreshPreviewFn: () => {
        refreshedCount += 1;
      },
      onDownloadSubtitle: (_entry, subUrl) => subDownloads.push(subUrl),
      onSelectionChange: (entry, checked) => selectionEvents.push({ url: entry.item.url, checked })
    }
  );

  const meta = {
    encrypted: false,
    isDynamic: false,
    variants: [
      { url: 'https://cdn.example.com/hls/1080.m3u8', resolution: '1920x1080', bandwidth: 4000000, estimatedBytes: 5000000 },
      { url: 'https://cdn.example.com/hls/480.m3u8', resolution: '854x480', bandwidth: 900000, estimatedBytes: 1200000 }
    ],
    audioTracks: [],
    subtitles: [
      { groupId: 'subs', language: 'fr', name: 'French', url: 'https://cdn.example.com/hls/subs_fr.m3u8', isDefault: true }
    ],
    totalDurationSec: 10
  };
  metaMap.set(streamEntry.item.url, meta);
  applyStreamMetadata(streamEntry, meta, {
    documentRef: doc,
    translateFn: (k) => k,
    hlsMetaByUrl: metaMap,
    getSettings: () => DEFAULT_SETTINGS
  });

  assert.equal(streamEntry.subtitleSelect.classList.contains('hidden'), false);
  assert.equal(streamEntry.subtitleBtn.classList.contains('hidden'), false);
  assert.ok(streamEntry.badgesEl.children.some((b) => b.textContent === 'popup_badge_subtitles'));

  await streamEntry.subtitleBtn.dispatchEvent({ type: 'click' });
  assert.deepEqual(subDownloads, ['https://cdn.example.com/hls/subs_fr.m3u8']);

  streamEntry.qualitySelect.selectedIndex = 1;
  await streamEntry.qualitySelect.dispatchEvent({ type: 'change' });
  assert.equal(refreshedCount, 1);

  streamEntry.selectCheckbox.checked = true;
  await streamEntry.selectCheckbox.dispatchEvent({ type: 'change' });
  assert.equal(selectionEvents[0].checked, true);

  applyStreamMetadata(
    streamEntry,
    { encrypted: false, isDynamic: true, variants: [] },
    {
      documentRef: doc,
      translateFn: (k) => k,
      hlsMetaByUrl: metaMap,
      getSettings: () => DEFAULT_SETTINGS,
      onSelectionChange: (entry, checked) => selectionEvents.push({ url: entry.item.url, checked })
    }
  );
  assert.equal(streamEntry.selectCheckbox.disabled, true);
  assert.equal(streamEntry.selectCheckbox.checked, false);
  assert.equal(streamEntry.downloadBtn.disabled, true);

  // Audio card creates clickable Preview button
  const audioEntry = createMediaCard(
    {
      url: 'https://cdn.example.com/song.mp3',
      type: 'audio',
      ext: 'mp3',
      isStream: false,
      source: 'dom',
      suggestedFilename: 'song.mp3'
    },
    {
      documentRef: doc,
      translateFn: (k) => k,
      hlsMetaByUrl: metaMap,
      getSettings: () => DEFAULT_SETTINGS
    }
  );
  assert.ok(audioEntry.previewBtn);
  assert.equal(audioEntry.thumbEl.tagName, 'BUTTON');

  const companionCalls = [];
  const mseEntry = createMediaCard(
    {
      url: 'mse://mse_1',
      type: 'video',
      ext: 'mp4',
      isStream: false,
      isMse: true,
      mseId: 'mse_1',
      capped: true,
      source: 'dom',
      suggestedFilename: 'buffered.mp4'
    },
    {
      documentRef: doc,
      translateFn: (k) => k,
      hlsMetaByUrl: metaMap,
      getSettings: () => DEFAULT_SETTINGS,
      isCompanionAvailable: () => true
    }
  );
  assert.equal(mseEntry.previewBtn, null);
  assert.equal(mseEntry.thumbEl.tagName, 'DIV');
  assert.ok(mseEntry.badgesEl.children.some((c) => c.textContent === 'popup_badge_mse'));
  assert.ok(mseEntry.badgesEl.children.some((c) => c.textContent === 'popup_badge_mse_capped'));

  const directWithCompanion = createMediaCard(
    {
      url: 'https://cdn.example.com/heavy.mp4',
      type: 'video',
      ext: 'mp4',
      isStream: false,
      source: 'network',
      suggestedFilename: 'heavy.mp4'
    },
    {
      documentRef: doc,
      translateFn: (k) => k,
      hlsMetaByUrl: metaMap,
      getSettings: () => DEFAULT_SETTINGS,
      isCompanionAvailable: () => true,
      onCompanionDownload: (entry, targetUrl) => companionCalls.push({ url: entry.item.url, targetUrl })
    }
  );
  assert.ok(directWithCompanion.companionBtn);
  assert.equal(directWithCompanion.companionBtn.classList.contains('hidden'), false);
  await directWithCompanion.companionBtn.dispatchEvent({ type: 'click' });
  assert.equal(companionCalls.length, 1);
  assert.equal(companionCalls[0].targetUrl, 'https://cdn.example.com/heavy.mp4');
});
