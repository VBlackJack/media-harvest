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

  // Compatible audio/webm on WebM DASH variant must NOT show video-only warning badge
  const muxableWebmMeta = {
    ...meta,
    audioTracks: [
      { url: 'https://cdn.example.com/vod/manifest.mpd#dash-audio-opus', groupId: 'dash-audio', language: 'en', name: 'English', mimeType: 'audio/webm' }
    ]
  };
  hlsMetaByUrl.set(item.url, muxableWebmMeta);
  entry.qualitySelect.selectedIndex = 0;
  applyStreamMetadata(entry, muxableWebmMeta, {
    documentRef: doc,
    translateFn,
    hlsMetaByUrl,
    getSettings: () => DEFAULT_SETTINGS
  });
  const muxedWebmBadges = entry.badgesEl.children.map((b) => b.textContent);
  assert.equal(muxedWebmBadges.includes('popup_badge_video_only'), false);
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

  // Copy URL button copies the direct or selected variant URL with visual feedback
  let copiedUrl = '';
  let statusReported = '';
  const copyableCard = createMediaCard(
    {
      url: 'https://cdn.example.com/clip.mp4',
      type: 'video',
      ext: 'mp4',
      isStream: false,
      source: 'network',
      suggestedFilename: 'clip.mp4'
    },
    {
      documentRef: doc,
      translateFn: (k) => k,
      hlsMetaByUrl: metaMap,
      getSettings: () => DEFAULT_SETTINGS,
      writeClipboardFn: async (text) => { copiedUrl = text; },
      onStatus: (msg) => { statusReported = msg; }
    }
  );
  assert.ok(copyableCard.copyBtn);
  await copyableCard.copyBtn.dispatchEvent({ type: 'click' });
  assert.equal(copiedUrl, 'https://cdn.example.com/clip.mp4');
  assert.equal(copyableCard.copyBtn.classList.contains('is-copied'), true);
  assert.equal(statusReported, 'popup_action_copied');
  assert.equal(copyableCard.nameEl.title, 'clip.mp4\nhttps://cdn.example.com/clip.mp4');

  // AES-128 badge and browser audio extraction action on stream card
  const audioExtractCalls = [];
  const aesStreamEntry = createMediaCard(
    {
      url: 'https://cdn.example.com/aes/master.m3u8',
      type: 'stream',
      ext: 'm3u8',
      isStream: true,
      source: 'network',
      suggestedFilename: 'aes_video.mp4'
    },
    {
      documentRef: doc,
      translateFn: (k) => k,
      hlsMetaByUrl: metaMap,
      getSettings: () => DEFAULT_SETTINGS,
      isCompanionAvailable: () => false,
      onExtractAudio: (entry, chosenUrl, chosenAudioUrl, useCompanion) => {
        audioExtractCalls.push({ url: chosenUrl, audioUrl: chosenAudioUrl, useCompanion });
      }
    }
  );
  assert.ok(aesStreamEntry.audioExtractBtn);
  assert.equal(aesStreamEntry.audioExtractBtn.classList.contains('hidden'), true);

  const aesMeta = {
    encrypted: false,
    decryptableAes128: true,
    isDynamic: false,
    variants: [{ resolution: '1280x720', bandwidth: 1500000, estimatedBytes: 3000000, url: 'https://cdn.example.com/aes/720.m3u8' }],
    audioTracks: [{ groupId: 'aud', name: 'English', language: 'en', url: 'https://cdn.example.com/aes/aud.m3u8' }]
  };
  metaMap.set(aesStreamEntry.item.url, aesMeta);
  applyStreamMetadata(
    aesStreamEntry,
    aesMeta,
    {
      documentRef: doc,
      translateFn: (k) => k,
      hlsMetaByUrl: metaMap,
      getSettings: () => DEFAULT_SETTINGS,
      isCompanionAvailable: () => false
    }
  );
  assert.ok(aesStreamEntry.badgesEl.children.some((c) => c.textContent === 'popup_badge_aes128'));
  assert.equal(aesStreamEntry.audioExtractBtn.classList.contains('hidden'), false);
  await aesStreamEntry.audioExtractBtn.dispatchEvent({ type: 'click' });
  assert.equal(audioExtractCalls.length, 1);
  assert.equal(audioExtractCalls[0].useCompanion, false);

  // SVG card shows SVG checkerboard thumbnail, Copy SVG action, and PNG/JPG convert chips
  let copiedSvgMarkup = '';
  const convertCalls = [];
  const rawSvgMarkup = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M2 2h20v20H2z"/></svg>';
  const svgCard = createMediaCard(
    {
      url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(rawSvgMarkup)}`,
      type: 'image',
      ext: 'svg',
      width: 24,
      height: 24,
      isStream: false,
      source: 'dom',
      svgMarkup: rawSvgMarkup,
      suggestedFilename: 'logo.svg'
    },
    {
      documentRef: doc,
      translateFn: (k) => k,
      hlsMetaByUrl: metaMap,
      getSettings: () => DEFAULT_SETTINGS,
      writeClipboardFn: async (text) => { copiedSvgMarkup = text; },
      onConvertImage: (entry, fmt) => convertCalls.push({ url: entry.item.url, fmt })
    }
  );
  assert.equal(svgCard.thumbEl.classList.contains('thumb-svg'), true);
  assert.ok(!svgCard.copyBtn);
  assert.ok(svgCard.copySvgBtn);
  await svgCard.copySvgBtn.dispatchEvent({ type: 'click' });
  assert.equal(copiedSvgMarkup, rawSvgMarkup);
  assert.equal(svgCard.copySvgBtn.classList.contains('is-copied'), true);
  assert.ok(svgCard.convertPngBtn);
  assert.ok(svgCard.convertJpgBtn);
  await svgCard.convertPngBtn.dispatchEvent({ type: 'click' });
  await svgCard.convertJpgBtn.dispatchEvent({ type: 'click' });
  assert.deepEqual(convertCalls.map((c) => c.fmt), ['png', 'jpg']);

  // Live HLS stream enables Record live + Stop & Save instead of blocking like live DASH
  const liveDownloads = [];
  const stopLiveCalls = [];
  const liveHlsCard = createMediaCard(
    {
      url: 'https://cdn.example.com/live/master.m3u8',
      type: 'stream',
      ext: 'm3u8',
      isStream: true,
      source: 'network',
      suggestedFilename: 'live_stream.mp4'
    },
    {
      documentRef: doc,
      translateFn: (k) => k,
      hlsMetaByUrl: metaMap,
      getSettings: () => DEFAULT_SETTINGS,
      onDownload: (entry, chosenUrl, chosenAudioUrl, opts) => liveDownloads.push({ entry, chosenUrl, opts }),
      onStopRecord: (reqId) => stopLiveCalls.push(reqId)
    }
  );
  const liveHlsMeta = {
    encrypted: false,
    isDynamic: true,
    streamFormat: 'hls',
    variants: [{ url: 'https://cdn.example.com/live/720.m3u8', resolution: '1280x720', bandwidth: 2000000 }],
    audioTracks: []
  };
  metaMap.set(liveHlsCard.item.url, liveHlsMeta);
  applyStreamMetadata(liveHlsCard, liveHlsMeta, {
    documentRef: doc,
    translateFn: (k) => k,
    hlsMetaByUrl: metaMap,
    getSettings: () => DEFAULT_SETTINGS
  });
  assert.equal(liveHlsCard.item.isBlocked, false);
  assert.equal(liveHlsCard.item.canRecordLive, true);
  assert.equal(liveHlsCard.downloadBtn.disabled, false);
  assert.equal(liveHlsCard.downloadBtn.textContent, 'popup_action_record_live');
  assert.equal(liveHlsCard.selectCheckbox.disabled, true);
  await liveHlsCard.downloadBtn.dispatchEvent({ type: 'click' });
  assert.equal(liveDownloads.length, 1);
  assert.equal(liveDownloads[0].opts.recordLive, true);

  assert.ok(liveHlsCard.stopRecordBtn);
  liveHlsCard.activeRequestId = 'live_req_99';
  await liveHlsCard.stopRecordBtn.dispatchEvent({ type: 'click' });
  assert.deepEqual(stopLiveCalls, ['live_req_99']);
  assert.equal(liveHlsCard.stopRecordBtn.disabled, true);

  // Live DASH stream with explicit streamFormat='dash' enables Record live DVR mode
  const liveDashCard = createMediaCard(
    {
      url: 'https://cdn.example.com/live/manifest.mpd',
      type: 'stream',
      ext: 'mpd',
      isStream: true,
      source: 'network',
      suggestedFilename: 'live_dash.mp4'
    },
    {
      documentRef: doc,
      translateFn: (k) => k,
      hlsMetaByUrl: metaMap,
      getSettings: () => DEFAULT_SETTINGS
    }
  );
  const liveDashMeta = {
    encrypted: false,
    isDynamic: true,
    streamFormat: 'dash',
    variants: [{ id: 'v720', url: 'https://cdn.example.com/live/manifest.mpd#v720', resolution: '1280x720' }],
    audioTracks: []
  };
  metaMap.set(liveDashCard.item.url, liveDashMeta);
  applyStreamMetadata(liveDashCard, liveDashMeta, {
    documentRef: doc,
    translateFn: (k) => k,
    hlsMetaByUrl: metaMap,
    getSettings: () => DEFAULT_SETTINGS
  });
  assert.equal(liveDashCard.item.isBlocked, false);
  assert.equal(liveDashCard.item.canRecordLive, true);
  assert.equal(liveDashCard.downloadBtn.textContent, 'popup_action_record_live');

  // Image card thumbnail triggers lightbox callback when clicked
  const lightboxCalls = [];
  const imgCard = createMediaCard(
    {
      url: 'https://cdn.example.com/photo.jpg',
      type: 'image',
      ext: 'jpg',
      width: 1200,
      height: 800,
      isStream: false,
      source: 'dom',
      suggestedFilename: 'photo.jpg'
    },
    {
      documentRef: doc,
      translateFn: (k) => k,
      hlsMetaByUrl: metaMap,
      getSettings: () => DEFAULT_SETTINGS,
      onOpenLightbox: (entry) => lightboxCalls.push(entry)
    }
  );
  assert.equal(imgCard.thumbEl.tagName, 'BUTTON');
  await imgCard.thumbEl.dispatchEvent({ type: 'click' });
  assert.equal(lightboxCalls.length, 1);
  assert.equal(lightboxCalls[0].item.url, 'https://cdn.example.com/photo.jpg');

  // Autonomous .m4a extraction is enabled for muxed non-DRM MP4 streams & MP4 MSE cards without companion
  const muxedAudioCalls = [];
  const muxedStreamCard = createMediaCard(
    {
      url: 'https://cdn.example.com/muxed/master.m3u8',
      type: 'stream',
      ext: 'm3u8',
      isStream: true,
      source: 'network',
      suggestedFilename: 'muxed.mp4'
    },
    {
      documentRef: doc,
      translateFn: (k) => k,
      hlsMetaByUrl: metaMap,
      getSettings: () => DEFAULT_SETTINGS,
      isCompanionAvailable: () => false,
      onExtractAudio: (_entry, chosenUrl, chosenAudioUrl, useCompanion) => {
        muxedAudioCalls.push({ chosenUrl, chosenAudioUrl, useCompanion });
      }
    }
  );
  assert.equal(muxedStreamCard.audioExtractBtn.classList.contains('hidden'), true);
  const muxedMeta = {
    encrypted: false,
    isDynamic: false,
    variants: [{ url: 'https://cdn.example.com/muxed/720.m3u8', resolution: '1280x720', bandwidth: 1200000 }],
    audioTracks: []
  };
  metaMap.set(muxedStreamCard.item.url, muxedMeta);
  applyStreamMetadata(muxedStreamCard, muxedMeta, {
    documentRef: doc,
    translateFn: (k) => k,
    hlsMetaByUrl: metaMap,
    getSettings: () => DEFAULT_SETTINGS,
    isCompanionAvailable: () => false
  });
  assert.equal(muxedStreamCard.audioExtractBtn.classList.contains('hidden'), false);
  await muxedStreamCard.audioExtractBtn.dispatchEvent({ type: 'click' });
  assert.deepEqual(muxedAudioCalls, [
    { chosenUrl: 'https://cdn.example.com/muxed/720.m3u8', chosenAudioUrl: '', useCompanion: false }
  ]);

  const mseAudioCalls = [];
  const mseMp4Card = createMediaCard(
    {
      url: 'mse://mse_7',
      type: 'video',
      ext: 'mp4',
      isStream: false,
      isMse: true,
      mseId: 'mse_7',
      source: 'mse',
      suggestedFilename: 'capture.mp4'
    },
    {
      documentRef: doc,
      translateFn: (k) => k,
      hlsMetaByUrl: metaMap,
      getSettings: () => DEFAULT_SETTINGS,
      isCompanionAvailable: () => false,
      onExtractAudio: (_entry, chosenUrl, chosenAudioUrl, useCompanion) => {
        mseAudioCalls.push({ chosenUrl, chosenAudioUrl, useCompanion });
      }
    }
  );
  assert.ok(mseMp4Card.audioExtractBtn);
  assert.equal(mseMp4Card.audioExtractBtn.classList.contains('hidden'), false);
  await mseMp4Card.audioExtractBtn.dispatchEvent({ type: 'click' });
  assert.equal(mseAudioCalls.length, 1);
  assert.equal(mseAudioCalls[0].useCompanion, false);

  // Oversized >512 MB non-DRM stream exposes direct disk saver button and forwards job callback
  const largeSaverCalls = [];
  const hugeStreamCard = createMediaCard(
    {
      url: 'https://cdn.example.com/4k/master.m3u8',
      type: 'stream',
      ext: 'm3u8',
      isStream: true,
      source: 'network',
      suggestedFilename: 'movie_4k.mp4'
    },
    {
      documentRef: doc,
      translateFn: (k) => k,
      hlsMetaByUrl: metaMap,
      getSettings: () => DEFAULT_SETTINGS,
      onSaveLargeStream: (_entry, chosenUrl, chosenAudioUrl) => {
        largeSaverCalls.push({ chosenUrl, chosenAudioUrl });
      }
    }
  );
  assert.ok(hugeStreamCard.saveLargeBtn);
  assert.equal(hugeStreamCard.saveLargeBtn.classList.contains('hidden'), true);
  const hugeMeta = {
    encrypted: false,
    isDynamic: false,
    variants: [{ url: 'https://cdn.example.com/4k/2160.m3u8', resolution: '3840x2160', bandwidth: 12000000, estimatedBytes: 800 * 1024 * 1024 }],
    audioTracks: []
  };
  metaMap.set(hugeStreamCard.item.url, hugeMeta);
  applyStreamMetadata(hugeStreamCard, hugeMeta, {
    documentRef: doc,
    translateFn: (k) => k,
    hlsMetaByUrl: metaMap,
    getSettings: () => DEFAULT_SETTINGS
  });
  assert.equal(hugeStreamCard.saveLargeBtn.classList.contains('hidden'), false);
  await hugeStreamCard.saveLargeBtn.dispatchEvent({ type: 'click' });
  assert.deepEqual(largeSaverCalls, [{ chosenUrl: 'https://cdn.example.com/4k/2160.m3u8', chosenAudioUrl: '' }]);

  // WAV export setting unlocks native browser audio extraction on direct HTTP MP4 cards without companion
  const wavDirectCalls = [];
  const directMp4Card = createMediaCard(
    {
      url: 'https://cdn.example.com/clip.mp4',
      type: 'video',
      ext: 'mp4',
      isStream: false,
      isMse: false,
      source: 'network',
      suggestedFilename: 'clip.mp4'
    },
    {
      documentRef: doc,
      translateFn: (k) => k,
      hlsMetaByUrl: metaMap,
      getSettings: () => ({ ...DEFAULT_SETTINGS, audioExportFormat: 'wav' }),
      isCompanionAvailable: () => false,
      onExtractAudio: (_entry, chosenUrl, chosenAudioUrl, useCompanion) => {
        wavDirectCalls.push({ chosenUrl, chosenAudioUrl, useCompanion });
      }
    }
  );
  assert.ok(directMp4Card.audioExtractBtn);
  assert.equal(directMp4Card.audioExtractBtn.classList.contains('hidden'), false);
  await directMp4Card.audioExtractBtn.dispatchEvent({ type: 'click' });
  assert.deepEqual(wavDirectCalls, [{ chosenUrl: 'https://cdn.example.com/clip.mp4', chosenAudioUrl: '', useCompanion: false }]);

  // Opus export setting also unlocks browser audio extraction, and oversized (>512 MB) progressive MP4 exposes direct saver
  const largeDirectCalls = [];
  const hugeProgressiveCard = createMediaCard(
    {
      url: 'https://cdn.example.com/huge_raw.mp4',
      type: 'video',
      ext: 'mp4',
      isStream: false,
      isMse: false,
      sizeBytes: 600 * 1024 * 1024,
      source: 'network',
      suggestedFilename: 'huge_raw.mp4'
    },
    {
      documentRef: doc,
      translateFn: (k) => k,
      hlsMetaByUrl: metaMap,
      getSettings: () => ({ ...DEFAULT_SETTINGS, audioExportFormat: 'opus' }),
      isCompanionAvailable: () => false,
      onSaveLargeStream: (_entry, chosenUrl) => largeDirectCalls.push(chosenUrl)
    }
  );
  assert.equal(hugeProgressiveCard.audioExtractBtn.classList.contains('hidden'), false);
  assert.equal(hugeProgressiveCard.saveLargeBtn.classList.contains('hidden'), false);
  await hugeProgressiveCard.saveLargeBtn.dispatchEvent({ type: 'click' });
  assert.deepEqual(largeDirectCalls, ['https://cdn.example.com/huge_raw.mp4']);
});
