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

import {
  DEFAULT_SETTINGS,
  LIMITS,
  MEDIA_SOURCES,
  MEDIA_TYPES,
  MESSAGE_TYPES,
  QUALITY_PREFERENCES,
  STORAGE_KEYS,
  UNIT_CONVERSIONS
} from '../config/constants.js';
import { parseDashManifest } from '../shared/dash_parser.js';
import { parseHlsPlaylist, selectBestVariant } from '../shared/hls_parser.js';
import { applyTranslations, getUiLanguage, t } from '../shared/i18n.js';
import { extractUrlExtension, isHttpUrl } from '../shared/media_classifier.js';
import { loadSettings, normalizeSettings } from '../shared/settings.js';
import { transmuxTsSegmentsToMp4 } from '../shared/ts_transmuxer.js';

const state = {
  activeTabId: null,
  activeTabUrl: '',
  filter: 'all',
  items: [],
  hasBlobVideo: false,
  settings: { ...DEFAULT_SETTINGS },
  hlsMetaByUrl: new Map(),
  cardsByUrl: new Map(),
  refreshDebounceTimer: null,
  loadGeneration: 0
};

const els = {
  mediaList: document.getElementById('mediaList'),
  hintBanner: document.getElementById('hintBanner'),
  statusBanner: document.getElementById('statusBanner'),
  downloadAllBtn: document.getElementById('downloadAllBtn'),
  refreshBtn: document.getElementById('refreshBtn'),
  reloadTabBtn: document.getElementById('reloadTabBtn'),
  clearBtn: document.getElementById('clearBtn'),
  optionsBtn: document.getElementById('optionsBtn'),
  countAll: document.getElementById('countAll'),
  countVideos: document.getElementById('countVideos'),
  countImages: document.getElementById('countImages'),
  countAudio: document.getElementById('countAudio'),
  filterBtns: Array.from(document.querySelectorAll('.filter-btn'))
};

/**
 * Formats byte counts into readable KB or MB strings.
 * @param {number} bytes
 * @returns {string}
 */
function formatBytes(bytes) {
  if (!bytes || bytes <= 0) {
    return '';
  }
  if (bytes >= UNIT_CONVERSIONS.BYTES_PER_MB) {
    return `${(bytes / UNIT_CONVERSIONS.BYTES_PER_MB).toFixed(1)} MB`;
  }
  return `${Math.max(1, Math.round(bytes / UNIT_CONVERSIONS.BYTES_PER_KB))} KB`;
}

/**
 * Formats duration in seconds as M:SS.
 * @param {number} seconds
 * @returns {string}
 */
function formatDuration(seconds) {
  if (!seconds || seconds <= 0) {
    return '';
  }
  const mins = Math.floor(seconds / UNIT_CONVERSIONS.SECONDS_PER_MINUTE);
  const secs = Math.floor(seconds % UNIT_CONVERSIONS.SECONDS_PER_MINUTE);
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

/**
 * Fetches text or binary content with an explicit timeout signal.
 * @param {string} url
 * @param {'text' | 'arrayBuffer'} responseType
 * @returns {Promise<string | ArrayBuffer>}
 */
async function fetchWithTimeout(url, responseType, extraHeaders) {
  if (!isHttpUrl(url)) {
    throw new Error('INVALID_URL');
  }
  const controller = new AbortController();
  const timerId = setTimeout(() => controller.abort(), LIMITS.FETCH_TIMEOUT_MS);
  try {
    const options = extraHeaders
      ? { signal: controller.signal, headers: extraHeaders }
      : { signal: controller.signal };
    const response = await fetch(url, options);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    if (responseType === 'text') {
      return await response.text();
    }
    const buffer = await response.arrayBuffer();
    if (responseType === 'bufferWithStatus') {
      return { status: response.status, buffer };
    }
    return buffer;
  } finally {
    clearTimeout(timerId);
  }
}

/**
 * Fetches a single preview segment buffer, honoring byte ranges when specified.
 * @param {string} url
 * @param {{ offset: number, length: number } | null} byteRange
 * @returns {Promise<ArrayBuffer>}
 */
async function fetchPreviewSegmentBuffer(url, byteRange) {
  if (!byteRange) {
    return fetchWithTimeout(url, 'arrayBuffer');
  }
  const headers = { Range: `bytes=${byteRange.offset}-${byteRange.offset + byteRange.length - 1}` };
  const { status, buffer } = await fetchWithTimeout(url, 'bufferWithStatus', headers);
  if (status === 200) {
    return buffer.slice(byteRange.offset, byteRange.offset + byteRange.length);
  }
  return buffer;
}

/**
 * Revokes and clears a single card's preview Blob URL if present.
 * @param {object} entry
 */
function revokeCardPreviewBlob(entry) {
  if (entry && entry.previewBlobUrl) {
    URL.revokeObjectURL(entry.previewBlobUrl);
    entry.previewBlobUrl = '';
  }
}

/**
 * Revokes all temporary preview Blob URLs created during popup interaction.
 */
function revokeAllPreviewBlobs() {
  for (const entry of state.cardsByUrl.values()) {
    revokeCardPreviewBlob(entry);
  }
}

/**
 * Displays a status or error message in the popup banner.
 * @param {string} text
 * @param {boolean} [isError=false]
 */
function setStatusBanner(text, isError = false) {
  if (!text) {
    els.statusBanner.classList.add('hidden');
    els.statusBanner.classList.remove('banner-error');
    els.statusBanner.textContent = '';
    return;
  }
  els.statusBanner.textContent = text;
  els.statusBanner.classList.remove('hidden');
  els.statusBanner.classList.toggle('banner-error', isError);
}

/**
 * Maps internal error codes from background/offscreen to localized messages.
 * @param {string} errorCode
 * @returns {string}
 */
function localizeError(errorCode) {
  if (errorCode === 'ENCRYPTED_STREAM') {
    return t('popup_error_encrypted_stream');
  }
  if (errorCode === 'RESTRICTED_PAGE') {
    return t('popup_error_restricted_page');
  }
  if (errorCode === 'DOWNLOAD_CANCELLED') {
    return t('popup_status_download_cancelled');
  }
  if (errorCode === 'STREAM_TOO_LARGE') {
    const maxMb = String(Math.round(LIMITS.MAX_HLS_BUFFER_BYTES / UNIT_CONVERSIONS.BYTES_PER_MB));
    return t('popup_error_stream_too_large', [maxMb]);
  }
  return t('popup_error_download_failed', [errorCode || t('popup_error_unknown')]);
}

/**
 * Checks whether an item matches the active category filter.
 * @param {object} item
 * @param {string} filter
 * @returns {boolean}
 */
function matchesFilter(item, filter) {
  if (filter === 'all') {
    return true;
  }
  if (filter === 'videos') {
    return item.type === MEDIA_TYPES.VIDEO || item.type === MEDIA_TYPES.STREAM;
  }
  if (filter === 'images') {
    return item.type === MEDIA_TYPES.IMAGE;
  }
  if (filter === 'audio') {
    return item.type === MEDIA_TYPES.AUDIO;
  }
  return true;
}

/**
 * Updates category pill counters from the current item list.
 */
function updateCounts() {
  els.countAll.textContent = String(state.items.length);
  els.countVideos.textContent = String(
    state.items.filter((i) => i.type === MEDIA_TYPES.VIDEO || i.type === MEDIA_TYPES.STREAM).length
  );
  els.countImages.textContent = String(
    state.items.filter((i) => i.type === MEDIA_TYPES.IMAGE).length
  );
  els.countAudio.textContent = String(
    state.items.filter((i) => i.type === MEDIA_TYPES.AUDIO).length
  );
}

/**
 * Builds an inline decorative SVG play triangle icon.
 * @returns {HTMLSpanElement}
 */
function createPlayOverlay() {
  const badge = document.createElement('span');
  badge.className = 'thumb-play';
  badge.setAttribute('aria-hidden', 'true');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '12');
  svg.setAttribute('height', '12');
  svg.setAttribute('fill', 'currentColor');
  const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
  poly.setAttribute('points', '6,4 20,12 6,20');
  svg.appendChild(poly);
  badge.appendChild(svg);
  return badge;
}

/**
 * Renders the visual content inside a thumbnail container.
 * @param {HTMLElement} thumbEl
 * @param {object} item
 */
function renderThumbnailContent(thumbEl, item) {
  const isVideoLike = item.type === MEDIA_TYPES.VIDEO || item.type === MEDIA_TYPES.STREAM;
  const key = `${item.type}|${item.poster || ''}|${item.ext || ''}`;
  if (thumbEl.dataset.thumbKey === key) {
    return;
  }
  thumbEl.dataset.thumbKey = key;
  thumbEl.replaceChildren();

  if (item.type === MEDIA_TYPES.IMAGE) {
    const img = document.createElement('img');
    img.src = item.url;
    img.alt = '';
    img.loading = 'lazy';
    thumbEl.appendChild(img);
    return;
  }

  if (item.poster) {
    const img = document.createElement('img');
    img.src = item.poster;
    img.alt = '';
    thumbEl.appendChild(img);
    if (isVideoLike) {
      thumbEl.appendChild(createPlayOverlay());
    }
    return;
  }

  thumbEl.textContent = item.ext || item.type;
}

/**
 * Creates a small metadata badge pill.
 * @param {string} label
 * @param {'default' | 'accent' | 'warning'} [variant='default']
 * @returns {HTMLSpanElement}
 */
function createBadge(label, variant = 'default') {
  const span = document.createElement('span');
  if (variant === 'accent') {
    span.className = 'badge badge-accent';
  } else if (variant === 'warning') {
    span.className = 'badge badge-warning';
  } else {
    span.className = 'badge';
  }
  span.textContent = label;
  return span;
}

/**
 * Computes estimated byte size for a stream item based on selected variant or default variant.
 * @param {object} entry
 * @returns {number}
 */
function getEstimatedStreamBytes(entry) {
  const meta = state.hlsMetaByUrl.get(entry.item.url);
  if (!meta || !Array.isArray(meta.variants) || meta.variants.length === 0) {
    return entry.item.estimatedBytes || 0;
  }
  const selectedUrl = entry.qualitySelect && !entry.qualitySelect.classList.contains('hidden')
    ? entry.qualitySelect.value
    : '';
  const selectedVariant = meta.variants.find((v) => v.url === selectedUrl) || meta.variants[0];
  return (selectedVariant && selectedVariant.estimatedBytes) || 0;
}

/**
 * Renders the metadata badges for a media card.
 * @param {HTMLElement} badgesEl
 * @param {object} item
 * @param {object | null} [entry=null]
 */
function renderBadges(badgesEl, item, entry = null) {
  badgesEl.replaceChildren();
  const meta = state.hlsMetaByUrl.get(item.url);
  const isDash = extractUrlExtension(item.url) === 'mpd' || (meta && meta.streamFormat === 'dash');
  if (item.isStream) {
    badgesEl.appendChild(createBadge(t(isDash ? 'popup_badge_dash' : 'popup_badge_stream'), 'accent'));
  } else if (item.ext) {
    badgesEl.appendChild(createBadge(item.ext.toUpperCase()));
  }
  if (item.width && item.height) {
    badgesEl.appendChild(createBadge(`${item.width}x${item.height}`));
  }
  const durationText = formatDuration(item.duration);
  if (durationText) {
    badgesEl.appendChild(createBadge(durationText));
  }
  const sizeText = formatBytes(item.sizeBytes);
  if (sizeText) {
    badgesEl.appendChild(createBadge(sizeText));
  }
  if (item.isStream && entry) {
    const estBytes = getEstimatedStreamBytes(entry);
    const thresholdBytes = state.settings.largeStreamWarningMb * UNIT_CONVERSIONS.BYTES_PER_MB;
    if (thresholdBytes > 0 && estBytes >= thresholdBytes) {
      badgesEl.appendChild(createBadge(t('popup_badge_large_stream'), 'warning'));
    }
  }
  badgesEl.appendChild(
    createBadge(item.source === MEDIA_SOURCES.NETWORK ? t('popup_badge_network') : t('popup_badge_dom'))
  );
}

/**
 * Fetches a short fMP4/TS HLS or DASH preview clip as a Blob URL.
 * @param {string} selectedUrl
 * @param {string} originalItemUrl
 * @returns {Promise<string>}
 */
async function buildStreamPreviewUrl(selectedUrl, originalItemUrl) {
  const looksDash = selectedUrl.includes('#dash-video-') || extractUrlExtension(originalItemUrl) === 'mpd';
  if (looksDash) {
    const rootText = await fetchWithTimeout(originalItemUrl, 'text');
    const parsedDash = parseDashManifest(rootText, originalItemUrl);
    if (parsedDash.encrypted) {
      throw new Error('ENCRYPTED_STREAM');
    }
    const chosen = parsedDash.variants.find((v) => v.url === selectedUrl) ||
      parsedDash.variants[parsedDash.variants.length - 1] ||
      parsedDash.variants[0];
    if (!chosen || chosen.segments.length === 0) {
      throw new Error('PREVIEW_UNAVAILABLE');
    }
    if (chosen.isProgressive) {
      if (!isHttpUrl(chosen.segments[0].url)) {
        throw new Error('INVALID_URL');
      }
      return chosen.segments[0].url;
    }
    const clipUrls = chosen.initSegmentUrl
      ? [chosen.initSegmentUrl, ...chosen.segments.slice(0, LIMITS.PREVIEW_HLS_SEGMENTS).map((s) => s.url)]
      : chosen.segments.slice(0, LIMITS.PREVIEW_HLS_SEGMENTS).map((s) => s.url);
    const buffers = await Promise.all(clipUrls.map((segmentUrl) => fetchWithTimeout(segmentUrl, 'arrayBuffer')));
    const mime = chosen.mimeType === 'video/webm' ? 'video/webm' : 'video/mp4';
    return URL.createObjectURL(new Blob(buffers, { type: mime }));
  }

  let targetUrl = selectedUrl;
  const rootText = await fetchWithTimeout(targetUrl, 'text');
  let parsed = parseHlsPlaylist(rootText, targetUrl);

  if (parsed.encrypted) {
    throw new Error('ENCRYPTED_STREAM');
  }

  if (parsed.isMaster) {
    const lowestOrFirst = parsed.variants[parsed.variants.length - 1] || selectBestVariant(parsed.variants);
    if (!lowestOrFirst) {
      throw new Error('PREVIEW_UNAVAILABLE');
    }
    targetUrl = lowestOrFirst.url;
    const variantText = await fetchWithTimeout(targetUrl, 'text');
    parsed = parseHlsPlaylist(variantText, targetUrl);
    if (parsed.encrypted) {
      throw new Error('ENCRYPTED_STREAM');
    }
  }

  if (parsed.segments.length === 0) {
    throw new Error('PREVIEW_UNAVAILABLE');
  }

  const leadingSegments = parsed.segments.slice(0, LIMITS.PREVIEW_HLS_SEGMENTS);
  const requests = parsed.initSegmentUrl
    ? [
        { url: parsed.initSegmentUrl, byteRange: parsed.initSegmentByteRange || null },
        ...leadingSegments.map((s) => ({ url: s.url, byteRange: s.byteRange || null }))
      ]
    : leadingSegments.map((s) => ({ url: s.url, byteRange: s.byteRange || null }));

  const buffers = await Promise.all(
    requests.map((req) => fetchPreviewSegmentBuffer(req.url, req.byteRange))
  );

  const outputBuffers = parsed.initSegmentUrl
    ? buffers
    : [transmuxTsSegmentsToMp4(buffers)];

  const blob = new Blob(outputBuffers, { type: 'video/mp4' });
  return URL.createObjectURL(blob);
}

/**
 * Closes and cleans up any active video preview inside a card entry.
 * @param {object} entry
 */
function closeCardPreview(entry) {
  const activeVideo = entry.previewBox.querySelector('video');
  if (activeVideo) {
    activeVideo.pause();
    activeVideo.removeAttribute('src');
    activeVideo.load();
  }
  revokeCardPreviewBlob(entry);
  entry.previewBox.replaceChildren();
  entry.previewBox.classList.add('hidden');
  if (entry.previewBtn) {
    entry.previewBtn.textContent = t('popup_action_preview');
  }
}

/**
 * Toggles an inline video preview player inside a media card.
 * @param {object} entry
 */
async function toggleVideoPreview(entry) {
  const { item, qualitySelect, previewBtn, previewBox } = entry;
  if (!previewBox.classList.contains('hidden')) {
    closeCardPreview(entry);
    return;
  }

  previewBtn.disabled = true;
  previewBox.replaceChildren();
  const note = document.createElement('div');
  note.className = 'preview-note';
  note.textContent = t('popup_preview_loading');
  previewBox.appendChild(note);
  previewBox.classList.remove('hidden');

  try {
    const selectedUrl = !qualitySelect.classList.contains('hidden') ? qualitySelect.value : item.url;
    let playableUrl = item.url;
    if (item.isStream) {
      const previewUrl = await buildStreamPreviewUrl(selectedUrl, item.url);
      if (!entry.card.isConnected || previewBox.classList.contains('hidden')) {
        if (previewUrl.startsWith('blob:')) {
          URL.revokeObjectURL(previewUrl);
        }
        return;
      }
      if (previewUrl.startsWith('blob:')) {
        revokeCardPreviewBlob(entry);
        entry.previewBlobUrl = previewUrl;
      }
      playableUrl = previewUrl;
    } else if (!entry.card.isConnected || previewBox.classList.contains('hidden')) {
      return;
    }

    const video = document.createElement('video');
    video.className = 'preview-video';
    video.controls = true;
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    if (item.poster) {
      video.poster = item.poster;
    }
    video.src = playableUrl;
    video.addEventListener('error', () => {
      previewBox.replaceChildren();
      const errNote = document.createElement('div');
      errNote.className = 'preview-note';
      errNote.textContent = t('popup_preview_unavailable');
      previewBox.appendChild(errNote);
    });

    previewBox.replaceChildren(video);
    previewBtn.textContent = t('popup_action_hide_preview');
  } catch (err) {
    if (!entry.card.isConnected || previewBox.classList.contains('hidden')) {
      return;
    }
    previewBox.replaceChildren();
    const errNote = document.createElement('div');
    errNote.className = 'preview-note';
    errNote.textContent = err.message === 'ENCRYPTED_STREAM'
      ? t('popup_error_encrypted_stream')
      : t('popup_preview_unavailable');
    previewBox.appendChild(errNote);
    previewBtn.textContent = t('popup_action_hide_preview');
  } finally {
    previewBtn.disabled = false;
  }
}

/**
 * Triggers a download request via the background service worker.
 * @param {object} entry
 * @param {string | undefined} selectedPlaylistUrl
 */
async function triggerDownload(entry, selectedPlaylistUrl) {
  const { item, downloadBtn, cancelBtn, progressEl } = entry;
  const requestId = `dl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  entry.activeRequestId = requestId;
  downloadBtn.disabled = true;
  if (item.isStream && cancelBtn) {
    cancelBtn.disabled = false;
    cancelBtn.classList.remove('hidden');
  }
  progressEl.className = 'progress-line';
  progressEl.textContent = item.isStream ? t('popup_status_hls_preparing') : '';
  progressEl.classList.toggle('hidden', !item.isStream);

  try {
    const response = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.DOWNLOAD_MEDIA,
      payload: {
        url: item.url,
        playlistUrl: selectedPlaylistUrl || item.url,
        isStream: Boolean(item.isStream),
        filename: item.suggestedFilename,
        saveAs: false,
        requestId
      }
    });

    if (!response || !response.ok) {
      throw new Error((response && response.error) || 'DOWNLOAD_FAILED');
    }
    setStatusBanner(t('popup_status_download_started'));
    if (item.isStream) {
      progressEl.classList.add('hidden');
    }
  } catch (err) {
    if (err && err.message === 'DOWNLOAD_CANCELLED') {
      progressEl.className = 'progress-line';
      progressEl.textContent = localizeError(err.message);
      progressEl.classList.remove('hidden');
      setStatusBanner(t('popup_status_download_cancelled'));
    } else {
      progressEl.className = 'error-line';
      progressEl.textContent = localizeError(err.message);
      progressEl.classList.remove('hidden');
    }
  } finally {
    if (entry.activeRequestId === requestId) {
      entry.activeRequestId = '';
    }
    if (cancelBtn) {
      cancelBtn.classList.add('hidden');
      cancelBtn.disabled = false;
    }
    downloadBtn.disabled = false;
  }
}

/**
 * Inspects HLS/DASH manifests on demand to expose quality options, warnings, and encrypted state.
 * @param {object} entry
 */
async function hydrateHlsVariants(entry) {
  if (entry.hlsHydrated) {
    return;
  }
  entry.hlsHydrated = true;

  const { item, qualitySelect, downloadBtn, progressEl } = entry;
  let meta = state.hlsMetaByUrl.get(item.url);
  if (!meta) {
    try {
      const response = await chrome.runtime.sendMessage({
        type: MESSAGE_TYPES.INSPECT_HLS,
        url: item.url
      });
      if (!response || !response.ok) {
        entry.hlsHydrated = false;
        return;
      }
      meta = response;
      state.hlsMetaByUrl.set(item.url, meta);
    } catch {
      entry.hlsHydrated = false;
      return;
    }
  }

  if (meta.encrypted) {
    downloadBtn.disabled = true;
    progressEl.className = 'error-line';
    progressEl.textContent = t('popup_error_encrypted_stream');
    progressEl.classList.remove('hidden');
    return;
  }

  if (Array.isArray(meta.variants) && meta.variants.length > 0) {
    qualitySelect.replaceChildren();
    for (const variant of meta.variants) {
      const option = document.createElement('option');
      option.value = variant.url;
      const bitrateKbps = variant.bandwidth
        ? `${Math.round(variant.bandwidth / UNIT_CONVERSIONS.BITS_PER_KBPS)} kbps`
        : '';
      const estSize = variant.estimatedBytes ? `(~${formatBytes(variant.estimatedBytes)})` : '';
      option.textContent = [variant.resolution, bitrateKbps, estSize].filter(Boolean).join(' ')
        || t('popup_quality_best');
      qualitySelect.appendChild(option);
    }
    if (state.settings.defaultQuality === QUALITY_PREFERENCES.LOWEST) {
      qualitySelect.selectedIndex = qualitySelect.options.length - 1;
    } else {
      qualitySelect.selectedIndex = 0;
    }
    qualitySelect.classList.remove('hidden');
  }

  if (meta.totalDurationSec && !item.duration) {
    item.duration = meta.totalDurationSec;
  }
  renderBadges(entry.badgesEl, item, entry);
}

/**
 * Builds the copy-URL icon button with visible copied feedback.
 * @param {object} entry
 * @returns {HTMLButtonElement}
 */
function createCopyButton(entry) {
  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'icon-btn';
  copyBtn.title = t('popup_action_copy_url');
  copyBtn.setAttribute('aria-label', t('popup_action_copy_url'));

  const copySvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  copySvg.setAttribute('aria-hidden', 'true');
  copySvg.setAttribute('viewBox', '0 0 24 24');
  copySvg.setAttribute('width', '14');
  copySvg.setAttribute('height', '14');
  copySvg.setAttribute('fill', 'none');
  copySvg.setAttribute('stroke', 'currentColor');
  copySvg.setAttribute('stroke-width', '2');
  const copyRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  copyRect.setAttribute('x', '9');
  copyRect.setAttribute('y', '9');
  copyRect.setAttribute('width', '13');
  copyRect.setAttribute('height', '13');
  copyRect.setAttribute('rx', '2');
  const copyPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  copyPath.setAttribute('d', 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1');
  copySvg.append(copyRect, copyPath);
  copyBtn.appendChild(copySvg);

  let resetTimer = null;
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(entry.item.url);
      copyBtn.title = t('popup_action_copied');
      copyBtn.classList.add('is-copied');
      setStatusBanner(t('popup_action_copied'));
      clearTimeout(resetTimer);
      resetTimer = setTimeout(() => {
        copyBtn.title = t('popup_action_copy_url');
        copyBtn.classList.remove('is-copied');
      }, LIMITS.COPY_FEEDBACK_MS);
    } catch (err) {
      setStatusBanner(localizeError(err && err.message), true);
    }
  });

  return copyBtn;
}

/**
 * Creates a reusable media card entry with bound listeners reading entry.item.
 * @param {object} item
 * @returns {object}
 */
function createMediaCard(item) {
  const isVideoLike = item.type === MEDIA_TYPES.VIDEO || item.type === MEDIA_TYPES.STREAM;
  const card = document.createElement('article');
  card.className = 'media-card';

  const row = document.createElement('div');
  row.className = 'media-row';

  const thumbEl = document.createElement(isVideoLike ? 'button' : 'div');
  if (isVideoLike) {
    thumbEl.type = 'button';
    thumbEl.className = 'thumb thumb-btn is-clickable';
    thumbEl.setAttribute('aria-label', t('popup_action_preview'));
  } else {
    thumbEl.className = 'thumb';
  }
  renderThumbnailContent(thumbEl, item);
  row.appendChild(thumbEl);

  const meta = document.createElement('div');
  meta.className = 'meta';

  const nameEl = document.createElement('div');
  nameEl.className = 'filename';
  nameEl.textContent = item.suggestedFilename || item.url;
  nameEl.title = item.url;
  meta.appendChild(nameEl);

  const badgesEl = document.createElement('div');
  badgesEl.className = 'badges';
  renderBadges(badgesEl, item);
  meta.appendChild(badgesEl);

  row.appendChild(meta);
  card.appendChild(row);

  const previewBox = document.createElement('div');
  previewBox.className = 'preview-box hidden';
  card.appendChild(previewBox);

  const controls = document.createElement('div');
  controls.className = 'controls';

  const qualitySelect = document.createElement('select');
  qualitySelect.className = 'quality-select hidden';
  qualitySelect.setAttribute('aria-label', t('popup_quality_select_label'));
  controls.appendChild(qualitySelect);

  const entry = {
    item,
    card,
    thumbEl,
    nameEl,
    badgesEl,
    previewBox,
    qualitySelect,
    previewBtn: null,
    downloadBtn: null,
    cancelBtn: null,
    progressEl: null,
    previewBlobUrl: '',
    activeRequestId: '',
    hlsHydrated: false
  };

  renderBadges(badgesEl, item, entry);

  qualitySelect.addEventListener('change', () => {
    renderBadges(entry.badgesEl, entry.item, entry);
  });

  if (isVideoLike) {
    const previewBtn = document.createElement('button');
    previewBtn.type = 'button';
    previewBtn.className = 'action-chip';
    previewBtn.textContent = t('popup_action_preview');
    const handlePreview = () => toggleVideoPreview(entry);
    previewBtn.addEventListener('click', handlePreview);
    thumbEl.addEventListener('click', handlePreview);
    controls.appendChild(previewBtn);
    entry.previewBtn = previewBtn;
  }

  controls.appendChild(createCopyButton(entry));

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'btn btn-cancel hidden';
  cancelBtn.textContent = t('popup_action_cancel');
  cancelBtn.addEventListener('click', () => {
    if (!entry.activeRequestId) {
      return;
    }
    cancelBtn.disabled = true;
    chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.CANCEL_DOWNLOAD,
      requestId: entry.activeRequestId
    }).catch(() => {});
  });
  controls.appendChild(cancelBtn);

  const downloadBtn = document.createElement('button');
  downloadBtn.type = 'button';
  downloadBtn.className = 'btn btn-primary';
  downloadBtn.textContent = t('popup_action_download');
  controls.appendChild(downloadBtn);
  card.appendChild(controls);

  const progressEl = document.createElement('div');
  progressEl.className = 'progress-line hidden';
  card.appendChild(progressEl);

  entry.downloadBtn = downloadBtn;
  entry.cancelBtn = cancelBtn;
  entry.progressEl = progressEl;

  downloadBtn.addEventListener('click', () => {
    const chosenUrl = !qualitySelect.classList.contains('hidden') ? qualitySelect.value : entry.item.url;
    triggerDownload(entry, chosenUrl);
  });

  if (item.isStream && item.type === MEDIA_TYPES.STREAM) {
    hydrateHlsVariants(entry);
  }

  return entry;
}

/**
 * Updates an existing card entry in place without disturbing active previews or selects.
 * @param {object} entry
 * @param {object} nextItem
 */
function updateCardEntry(entry, nextItem) {
  entry.item = nextItem;
  entry.nameEl.textContent = nextItem.suggestedFilename || nextItem.url;
  entry.nameEl.title = nextItem.url;
  renderThumbnailContent(entry.thumbEl, nextItem);
  renderBadges(entry.badgesEl, nextItem, entry);
  if (nextItem.isStream && nextItem.type === MEDIA_TYPES.STREAM && !entry.hlsHydrated) {
    hydrateHlsVariants(entry);
  }
}

/**
 * Updates banners and reconciles the media card list without destroying active card state.
 */
function renderList() {
  const visible = state.items.filter((item) => matchesFilter(item, state.filter));
  const directVisible = visible.filter((item) => !item.isStream);

  if (directVisible.length > 1) {
    els.downloadAllBtn.textContent = t('popup_action_download_all', [String(directVisible.length)]);
    els.downloadAllBtn.classList.remove('hidden');
  } else {
    els.downloadAllBtn.classList.add('hidden');
  }

  const hasCapturedStream = state.items.some(
    (i) => i.type === MEDIA_TYPES.STREAM || i.type === MEDIA_TYPES.VIDEO
  );
  if (state.hasBlobVideo && !hasCapturedStream) {
    els.hintBanner.textContent = t('popup_hint_blob_detected');
    els.hintBanner.classList.remove('hidden');
  } else {
    els.hintBanner.classList.add('hidden');
  }

  const activeUrls = new Set(state.items.map((item) => item.url));
  for (const [url, entry] of state.cardsByUrl.entries()) {
    if (!activeUrls.has(url)) {
      closeCardPreview(entry);
      entry.card.remove();
      state.cardsByUrl.delete(url);
    }
  }

  const existingEmpty = els.mediaList.querySelector('.empty-state');
  if (visible.length === 0) {
    for (const entry of state.cardsByUrl.values()) {
      closeCardPreview(entry);
      entry.card.classList.add('hidden');
    }
    if (!existingEmpty) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = t('popup_status_empty');
      els.mediaList.appendChild(empty);
    }
    return;
  }

  if (existingEmpty) {
    existingEmpty.remove();
  }

  const visibleUrls = new Set(visible.map((item) => item.url));
  for (const [url, entry] of state.cardsByUrl.entries()) {
    if (!visibleUrls.has(url)) {
      closeCardPreview(entry);
      entry.card.classList.add('hidden');
    }
  }

  const orderedEntries = visible.map((item) => {
    let entry = state.cardsByUrl.get(item.url);
    if (entry) {
      updateCardEntry(entry, item);
    } else {
      entry = createMediaCard(item);
      state.cardsByUrl.set(item.url, entry);
    }
    entry.card.classList.remove('hidden');
    return entry;
  });

  // Insert only newly created cards in position so existing playing <video> nodes are never moved
  for (let i = orderedEntries.length - 1; i >= 0; i -= 1) {
    const entry = orderedEntries[i];
    if (entry.card.isConnected) {
      continue;
    }
    let anchor = null;
    for (let j = i + 1; j < orderedEntries.length; j += 1) {
      if (orderedEntries[j].card.isConnected) {
        anchor = orderedEntries[j].card;
        break;
      }
    }
    els.mediaList.insertBefore(entry.card, anchor);
  }
}

/**
 * Loads media items for the currently active Chrome tab.
 * @param {{ showLoading?: boolean }} [options]
 */
async function loadActiveTabMedia({ showLoading = true } = {}) {
  state.loadGeneration += 1;
  const generation = state.loadGeneration;

  els.refreshBtn.classList.add('is-spinning');
  els.refreshBtn.disabled = true;
  if (showLoading) {
    setStatusBanner(t('popup_status_loading'));
  }

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (generation !== state.loadGeneration) {
      return;
    }
    if (!tab || typeof tab.id !== 'number') {
      throw new Error('NO_ACTIVE_TAB');
    }

    state.activeTabId = tab.id;
    state.activeTabUrl = tab.url || '';

    const response = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.GET_MEDIA_FOR_TAB,
      tabId: tab.id,
      tabUrl: state.activeTabUrl
    });
    if (generation !== state.loadGeneration) {
      return;
    }

    if (!response || !response.ok) {
      throw new Error((response && response.error) || 'NO_ACTIVE_TAB');
    }

    state.items = response.items || [];
    state.hasBlobVideo = Boolean(response.hasBlobVideo);
    if (showLoading) {
      setStatusBanner('');
    }
    updateCounts();
    renderList();
  } catch (err) {
    if (generation !== state.loadGeneration) {
      return;
    }
    state.items = [];
    updateCounts();
    renderList();
    const message = err.message === 'NO_ACTIVE_TAB'
      ? t('popup_error_no_active_tab')
      : localizeError(err.message);
    setStatusBanner(message, true);
  } finally {
    if (generation === state.loadGeneration) {
      els.refreshBtn.classList.remove('is-spinning');
      els.refreshBtn.disabled = false;
    }
  }
}

/**
 * Clears captured streams and reloads the active tab so streams are captured cleanly.
 */
async function reloadActiveTabAndCapture() {
  if (typeof state.activeTabId !== 'number') {
    await loadActiveTabMedia();
    return;
  }

  const targetTabId = state.activeTabId;
  els.reloadTabBtn.disabled = true;
  setStatusBanner(t('popup_status_reloading_tab'));

  try {
    const clearResp = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.CLEAR_MEDIA_FOR_TAB,
      tabId: targetTabId
    });
    if (!clearResp || !clearResp.ok) {
      throw new Error((clearResp && clearResp.error) || 'CLEAR_FAILED');
    }
  } catch (err) {
    els.reloadTabBtn.disabled = false;
    setStatusBanner(localizeError(err.message), true);
    return;
  }

  let settled = false;
  let timeoutId = null;

  const cleanup = () => {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(timeoutId);
    chrome.tabs.onUpdated.removeListener(onTabUpdated);
    chrome.tabs.onRemoved.removeListener(onTabRemoved);
    els.reloadTabBtn.disabled = false;
  };

  const onTabUpdated = (updatedTabId, changeInfo) => {
    if (updatedTabId === targetTabId && changeInfo.status === 'complete') {
      cleanup();
      loadActiveTabMedia({ showLoading: false });
    }
  };

  const onTabRemoved = (removedTabId) => {
    if (removedTabId === targetTabId) {
      cleanup();
    }
  };

  timeoutId = setTimeout(() => {
    cleanup();
    loadActiveTabMedia({ showLoading: false });
  }, LIMITS.RELOAD_TIMEOUT_MS);

  chrome.tabs.onUpdated.addListener(onTabUpdated);
  chrome.tabs.onRemoved.addListener(onTabRemoved);
  try {
    await chrome.tabs.reload(targetTabId);
  } catch (err) {
    cleanup();
    setStatusBanner(localizeError(err.message), true);
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (!message) {
    return;
  }

  if (message.type === MESSAGE_TYPES.DOWNLOAD_PROGRESS) {
    let entry = null;
    if (message.requestId) {
      for (const candidate of state.cardsByUrl.values()) {
        if (candidate.activeRequestId === message.requestId) {
          entry = candidate;
          break;
        }
      }
    } else if (message.url) {
      entry = state.cardsByUrl.get(message.url) || null;
    }
    if (!entry) {
      return;
    }
    entry.progressEl.className = 'progress-line';
    entry.progressEl.textContent = message.total > 0 && message.done >= message.total
      ? t('popup_status_hls_muxing')
      : t('popup_status_hls_segments', [String(message.done), String(message.total)]);
    entry.progressEl.classList.remove('hidden');
    return;
  }

  if (message.type === MESSAGE_TYPES.MEDIA_UPDATED && message.tabId === state.activeTabId) {
    clearTimeout(state.refreshDebounceTimer);
    state.refreshDebounceTimer = setTimeout(() => {
      loadActiveTabMedia({ showLoading: false });
    }, LIMITS.MEDIA_UPDATE_DEBOUNCE_MS);
  }
});

for (const btn of els.filterBtns) {
  btn.addEventListener('click', () => {
    state.filter = btn.dataset.filter || 'all';
    for (const candidate of els.filterBtns) {
      const isActive = candidate === btn;
      candidate.classList.toggle('active', isActive);
      candidate.setAttribute('aria-selected', String(isActive));
    }
    renderList();
  });
}

els.refreshBtn.addEventListener('click', () => loadActiveTabMedia({ showLoading: true }));
els.reloadTabBtn.addEventListener('click', reloadActiveTabAndCapture);

els.clearBtn.addEventListener('click', async () => {
  if (typeof state.activeTabId !== 'number') {
    return;
  }
  try {
    const response = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.CLEAR_MEDIA_FOR_TAB,
      tabId: state.activeTabId
    });
    if (!response || !response.ok) {
      throw new Error((response && response.error) || 'CLEAR_FAILED');
    }
    await loadActiveTabMedia();
  } catch (err) {
    setStatusBanner(localizeError(err.message), true);
  }
});

els.downloadAllBtn.addEventListener('click', async () => {
  const directItems = state.items.filter(
    (item) => matchesFilter(item, state.filter) && !item.isStream
  );
  els.downloadAllBtn.disabled = true;
  let lastError = '';

  try {
    for (const item of directItems) {
      try {
        const response = await chrome.runtime.sendMessage({
          type: MESSAGE_TYPES.DOWNLOAD_MEDIA,
          payload: {
            url: item.url,
            isStream: false,
            filename: item.suggestedFilename,
            saveAs: false
          }
        });
        if (!response || !response.ok) {
          lastError = (response && response.error) || 'DOWNLOAD_FAILED';
        }
      } catch (err) {
        lastError = err.message || 'DOWNLOAD_FAILED';
      }
      await new Promise((resolve) => setTimeout(resolve, LIMITS.BATCH_DOWNLOAD_DELAY_MS));
    }

    if (lastError) {
      setStatusBanner(localizeError(lastError), true);
    } else {
      setStatusBanner(t('popup_status_download_started'));
    }
  } finally {
    els.downloadAllBtn.disabled = false;
  }
});

if (els.optionsBtn) {
  els.optionsBtn.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });
}

if (chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'sync' || !changes[STORAGE_KEYS.USER_SETTINGS]) {
      return;
    }
    state.settings = normalizeSettings(changes[STORAGE_KEYS.USER_SETTINGS].newValue);
    for (const entry of state.cardsByUrl.values()) {
      renderBadges(entry.badgesEl, entry.item, entry);
    }
  });
}

window.addEventListener('unload', revokeAllPreviewBlobs);

document.documentElement.lang = getUiLanguage();
applyTranslations(document);
loadSettings()
  .then((settings) => {
    state.settings = settings;
  })
  .catch(() => {})
  .finally(() => {
    loadActiveTabMedia();
  });
