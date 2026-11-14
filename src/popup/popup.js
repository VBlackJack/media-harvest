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

import { LIMITS, MEDIA_SOURCES, MEDIA_TYPES, MESSAGE_TYPES } from '../config/constants.js';
import { applyTranslations, t } from '../shared/i18n.js';

const BYTES_PER_KB = 1024;
const BYTES_PER_MB = 1024 * 1024;
const BITS_PER_KBPS = 1000;

const state = {
  activeTabId: null,
  activeTabUrl: '',
  filter: 'all',
  items: [],
  hasBlobVideo: false,
  hlsMetaByUrl: new Map(),
  progressNodes: new Map()
};

const els = {
  mediaList: document.getElementById('mediaList'),
  hintBanner: document.getElementById('hintBanner'),
  statusBanner: document.getElementById('statusBanner'),
  downloadAllBtn: document.getElementById('downloadAllBtn'),
  refreshBtn: document.getElementById('refreshBtn'),
  clearBtn: document.getElementById('clearBtn'),
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
  if (bytes >= BYTES_PER_MB) {
    return `${(bytes / BYTES_PER_MB).toFixed(1)} MB`;
  }
  return `${Math.max(1, Math.round(bytes / BYTES_PER_KB))} KB`;
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
  return t('popup_error_download_failed', [errorCode || 'unknown']);
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
 * Builds the thumbnail element for a media card without unsafe HTML injection.
 * @param {object} item
 * @returns {HTMLElement}
 */
function createThumbnail(item) {
  const thumb = document.createElement('div');
  thumb.className = 'thumb';

  if (item.type === MEDIA_TYPES.IMAGE) {
    const img = document.createElement('img');
    img.src = item.url;
    img.alt = '';
    img.loading = 'lazy';
    thumb.appendChild(img);
    return thumb;
  }

  if (item.poster) {
    const img = document.createElement('img');
    img.src = item.poster;
    img.alt = '';
    thumb.appendChild(img);
    return thumb;
  }

  thumb.textContent = item.ext || item.type;
  return thumb;
}

/**
 * Creates a small metadata badge pill.
 * @param {string} label
 * @param {boolean} [accent=false]
 * @returns {HTMLSpanElement}
 */
function createBadge(label, accent = false) {
  const span = document.createElement('span');
  span.className = accent ? 'badge badge-accent' : 'badge';
  span.textContent = label;
  return span;
}

/**
 * Triggers a download request via the background service worker.
 * @param {object} item
 * @param {string | undefined} selectedPlaylistUrl
 * @param {HTMLButtonElement} btn
 * @param {HTMLElement} progressEl
 */
async function triggerDownload(item, selectedPlaylistUrl, btn, progressEl) {
  btn.disabled = true;
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
        saveAs: false
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
    progressEl.className = 'error-line';
    progressEl.textContent = localizeError(err.message);
    progressEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
  }
}

/**
 * Inspects HLS master playlists on demand to expose quality options and audio warnings.
 * @param {object} item
 * @param {HTMLSelectElement} selectEl
 * @param {HTMLButtonElement} downloadBtn
 * @param {HTMLElement} noticeEl
 */
async function hydrateHlsVariants(item, selectEl, downloadBtn, noticeEl) {
  let meta = state.hlsMetaByUrl.get(item.url);
  if (!meta) {
    try {
      const response = await chrome.runtime.sendMessage({
        type: MESSAGE_TYPES.INSPECT_HLS,
        url: item.url
      });
      if (!response || !response.ok) {
        return;
      }
      meta = response;
      state.hlsMetaByUrl.set(item.url, meta);
    } catch {
      return;
    }
  }

  if (meta.encrypted) {
    downloadBtn.disabled = true;
    noticeEl.className = 'error-line';
    noticeEl.textContent = t('popup_error_encrypted_stream');
    noticeEl.classList.remove('hidden');
    return;
  }

  if (Array.isArray(meta.variants) && meta.variants.length > 0) {
    selectEl.replaceChildren();
    for (const variant of meta.variants) {
      const option = document.createElement('option');
      option.value = variant.url;
      const bitrateKbps = variant.bandwidth ? `${Math.round(variant.bandwidth / BITS_PER_KBPS)} kbps` : '';
      option.textContent = [variant.resolution, bitrateKbps].filter(Boolean).join(' - ') || t('popup_quality_best');
      selectEl.appendChild(option);
    }
    selectEl.classList.remove('hidden');
  }

  if (Array.isArray(meta.audioTracks) && meta.audioTracks.length > 0) {
    noticeEl.className = 'progress-line';
    noticeEl.textContent = t('popup_status_hls_separate_audio');
    noticeEl.classList.remove('hidden');

    const firstAudio = meta.audioTracks[0];
    if (firstAudio && !state.items.some((existing) => existing.url === firstAudio.url)) {
      state.items.push({
        url: firstAudio.url,
        type: MEDIA_TYPES.AUDIO,
        ext: 'm3u8',
        isStream: true,
        source: MEDIA_SOURCES.NETWORK,
        width: 0,
        height: 0,
        sizeBytes: 0,
        suggestedFilename: `${item.suggestedFilename.replace(/\.[^.]+$/, '')}_audio.ts`
      });
      updateCounts();
      renderList();
    }
  }
}

/**
 * Renders the filtered media card list into the popup.
 */
function renderList() {
  state.progressNodes.clear();
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

  els.mediaList.replaceChildren();
  if (visible.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = t('popup_status_empty');
    els.mediaList.appendChild(empty);
    return;
  }

  for (const item of visible) {
    const card = document.createElement('article');
    card.className = 'media-card';

    const row = document.createElement('div');
    row.className = 'media-row';
    row.appendChild(createThumbnail(item));

    const meta = document.createElement('div');
    meta.className = 'meta';

    const nameEl = document.createElement('div');
    nameEl.className = 'filename';
    nameEl.textContent = item.suggestedFilename || item.url;
    nameEl.title = item.url;
    meta.appendChild(nameEl);

    const badges = document.createElement('div');
    badges.className = 'badges';
    if (item.isStream) {
      badges.appendChild(createBadge(t('popup_badge_stream'), true));
    } else if (item.ext) {
      badges.appendChild(createBadge(item.ext.toUpperCase()));
    }
    if (item.width && item.height) {
      badges.appendChild(createBadge(`${item.width}x${item.height}`));
    }
    const sizeText = formatBytes(item.sizeBytes);
    if (sizeText) {
      badges.appendChild(createBadge(sizeText));
    }
    badges.appendChild(
      createBadge(item.source === MEDIA_SOURCES.NETWORK ? t('popup_badge_network') : t('popup_badge_dom'))
    );
    meta.appendChild(badges);
    row.appendChild(meta);
    card.appendChild(row);

    const controls = document.createElement('div');
    controls.className = 'controls';

    const qualitySelect = document.createElement('select');
    qualitySelect.className = 'quality-select hidden';
    qualitySelect.setAttribute('aria-label', t('popup_quality_select_label'));
    controls.appendChild(qualitySelect);

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'icon-btn';
    copyBtn.title = t('popup_action_copy_url');
    copyBtn.setAttribute('aria-label', t('popup_action_copy_url'));
    const copySvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
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
    copyBtn.addEventListener('click', async () => {
      await navigator.clipboard.writeText(item.url);
      copyBtn.title = t('popup_action_copied');
    });
    controls.appendChild(copyBtn);

    const downloadBtn = document.createElement('button');
    downloadBtn.type = 'button';
    downloadBtn.className = 'btn btn-primary';
    downloadBtn.textContent = t('popup_action_download');
    controls.appendChild(downloadBtn);
    card.appendChild(controls);

    const progressEl = document.createElement('div');
    progressEl.className = 'progress-line hidden';
    card.appendChild(progressEl);
    state.progressNodes.set(item.url, progressEl);

    downloadBtn.addEventListener('click', () => {
      const chosenUrl = !qualitySelect.classList.contains('hidden') ? qualitySelect.value : item.url;
      triggerDownload(item, chosenUrl, downloadBtn, progressEl);
    });

    if (item.isStream && item.type === MEDIA_TYPES.STREAM) {
      hydrateHlsVariants(item, qualitySelect, downloadBtn, progressEl);
    }

    els.mediaList.appendChild(card);
  }
}

/**
 * Loads media items for the currently active Chrome tab.
 */
async function loadActiveTabMedia() {
  setStatusBanner(t('popup_status_loading'));
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
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

    if (!response || !response.ok) {
      throw new Error((response && response.error) || 'NO_ACTIVE_TAB');
    }

    state.items = response.items || [];
    state.hasBlobVideo = Boolean(response.hasBlobVideo);
    setStatusBanner('');
    updateCounts();
    renderList();
  } catch (err) {
    state.items = [];
    updateCounts();
    renderList();
    const message = err.message === 'NO_ACTIVE_TAB'
      ? t('popup_error_no_active_tab')
      : localizeError(err.message);
    setStatusBanner(message, true);
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.type !== MESSAGE_TYPES.DOWNLOAD_PROGRESS) {
    return;
  }
  const node = state.progressNodes.get(message.url);
  if (!node) {
    return;
  }
  node.className = 'progress-line';
  node.textContent = t('popup_status_hls_segments', [String(message.done), String(message.total)]);
  node.classList.remove('hidden');
});

for (const btn of els.filterBtns) {
  btn.addEventListener('click', () => {
    state.filter = btn.dataset.filter || 'all';
    for (const candidate of els.filterBtns) {
      candidate.classList.toggle('active', candidate === btn);
    }
    renderList();
  });
}

els.refreshBtn.addEventListener('click', loadActiveTabMedia);

els.clearBtn.addEventListener('click', async () => {
  if (typeof state.activeTabId !== 'number') {
    return;
  }
  await chrome.runtime.sendMessage({
    type: MESSAGE_TYPES.CLEAR_MEDIA_FOR_TAB,
    tabId: state.activeTabId
  });
  await loadActiveTabMedia();
});

els.downloadAllBtn.addEventListener('click', async () => {
  const directItems = state.items.filter(
    (item) => matchesFilter(item, state.filter) && !item.isStream
  );
  els.downloadAllBtn.disabled = true;
  try {
    for (const item of directItems) {
      await chrome.runtime.sendMessage({
        type: MESSAGE_TYPES.DOWNLOAD_MEDIA,
        payload: {
          url: item.url,
          isStream: false,
          filename: item.suggestedFilename,
          saveAs: false
        }
      });
      await new Promise((resolve) => setTimeout(resolve, LIMITS.BATCH_DOWNLOAD_DELAY_MS));
    }
    setStatusBanner(t('popup_status_download_started'));
  } finally {
    els.downloadAllBtn.disabled = false;
  }
});

applyTranslations(document);
loadActiveTabMedia();
