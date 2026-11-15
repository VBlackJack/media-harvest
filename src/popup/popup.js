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
  DEFAULT_FILENAMES,
  DEFAULT_SETTINGS,
  LIMITS,
  MEDIA_TYPES,
  MESSAGE_TYPES,
  SORT_MODES,
  STORAGE_KEYS
} from '../config/constants.js';
import { applyTranslations, getUiLanguage, t } from '../shared/i18n.js';
import { isFolderFilenameTemplate, loadSettings, normalizeSettings } from '../shared/settings.js';
import {
  applyStreamMetadata,
  createMediaCard,
  markInspectionFailed,
  renderBadges,
  updateCardEntry,
  updateStreamLimitWarning
} from './media_card.js';
import {
  localizeError,
  matchesFilter,
  matchesSearch,
  runWithConcurrency,
  sortMediaItems
} from './popup_helpers.js';
import {
  closeCardPreview,
  revokeCardPreviewBlob
} from './preview_player.js';
import { runBatchDownloads } from './batch_runner.js';

/**
 * Resolves popup DOM element references from the active document.
 * @param {Document} doc
 * @returns {object}
 */
export function collectPopupElements(doc) {
  return {
    mediaList: doc.getElementById('mediaList'),
    hintBanner: doc.getElementById('hintBanner'),
    statusBanner: doc.getElementById('statusBanner'),
    searchInput: doc.getElementById('searchInput'),
    sortSelect: doc.getElementById('sortSelect'),
    selectionBar: doc.getElementById('selectionBar'),
    selectAllBtn: doc.getElementById('selectAllBtn'),
    downloadSelectedBtn: doc.getElementById('downloadSelectedBtn'),
    downloadAllBtn: doc.getElementById('downloadAllBtn'),
    companionPageBtn: doc.getElementById('companionPageBtn'),
    stopBatchBtn: doc.getElementById('stopBatchBtn'),
    batchConfirmBar: doc.getElementById('batchConfirmBar'),
    batchConfirmText: doc.getElementById('batchConfirmText'),
    batchConfirmBtn: doc.getElementById('batchConfirmBtn'),
    batchCancelBtn: doc.getElementById('batchCancelBtn'),
    refreshBtn: doc.getElementById('refreshBtn'),
    reloadTabBtn: doc.getElementById('reloadTabBtn'),
    clearBtn: doc.getElementById('clearBtn'),
    sidePanelBtn: doc.getElementById('sidePanelBtn'),
    optionsBtn: doc.getElementById('optionsBtn'),
    countAll: doc.getElementById('countAll'),
    countVideos: doc.getElementById('countVideos'),
    countImages: doc.getElementById('countImages'),
    countAudio: doc.getElementById('countAudio'),
    countSubtitles: doc.getElementById('countSubtitles'),
    filterBtns: Array.from(doc.querySelectorAll('.filter-btn'))
  };
}

/**
 * Creates the popup controller managing tab media state, filtering, sorting, previews, and downloads.
 * @param {object} [deps={}]
 * @returns {object}
 */
export function createPopupController(deps = {}) {
  const doc = deps.documentRef || document;
  const win = deps.windowRef || window;
  const chromeApi = deps.chromeApi || chrome;
  const loadSettingsFn = deps.loadSettingsFn || loadSettings;
  const normalizeSettingsFn = deps.normalizeSettingsFn || normalizeSettings;
  const translateFn = deps.translateFn || t;
  const getLangFn = deps.getUiLanguageFn || getUiLanguage;
  const applyI18nFn = deps.applyTranslationsFn || applyTranslations;
  const batchDelayMs = typeof deps.batchDelayMs === 'number'
    ? deps.batchDelayMs
    : LIMITS.BATCH_DOWNLOAD_DELAY_MS;

  const state = {
    activeTabId: null,
    activeTabUrl: '',
    filter: 'all',
    searchQuery: '',
    sortBy: SORT_MODES.DEFAULT,
    items: [],
    hasBlobVideo: false,
    settings: { ...DEFAULT_SETTINGS },
    hlsMetaByUrl: new Map(),
    cardsByUrl: new Map(),
    refreshDebounceTimer: null,
    loadGeneration: 0,
    lastLoadError: false,
    hasActiveBuildSnapshot: false,
    activeBuildsByUrl: new Map(),
    localPendingRequestIds: new Set(),
    hydrationQueue: [],
    hydrationScheduled: false,
    selectedUrls: new Set(),
    activeBatchRequestId: '',
    batchRunning: false,
    batchAbortRequested: false,
    pendingBatchItems: null,
    companionAvailable: false
  };

  const els = collectPopupElements(doc);

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
   * Hides any open in-DOM batch download confirmation prompt.
   */
  function hideBatchConfirm() {
    state.pendingBatchItems = null;
    if (els.batchConfirmBar) {
      els.batchConfirmBar.classList.add('hidden');
    }
  }

  const VALID_FILTERS = new Set(['all', 'videos', 'images', 'audio', 'subtitles']);
  const VALID_SORTS = new Set(Object.values(SORT_MODES));

  /**
   * Restores persisted filter category and sort order from local extension storage.
   */
  async function restorePopupUiState() {
    if (!chromeApi.storage || !chromeApi.storage.local) {
      return;
    }
    try {
      const stored = await chromeApi.storage.local.get(STORAGE_KEYS.POPUP_UI_STATE);
      const saved = stored && stored[STORAGE_KEYS.POPUP_UI_STATE];
      if (!saved || typeof saved !== 'object') {
        return;
      }
      if (typeof saved.filter === 'string' && VALID_FILTERS.has(saved.filter)) {
        state.filter = saved.filter;
      }
      if (typeof saved.sortBy === 'string' && VALID_SORTS.has(saved.sortBy)) {
        state.sortBy = saved.sortBy;
      }
      applyActiveFilterUi();
      if (els.sortSelect) {
        els.sortSelect.value = state.sortBy;
      }
    } catch {
      // Ignore storage read failures and retain default view state
    }
  }

  /**
   * Saves the active filter category and sort order to local extension storage.
   */
  function persistPopupUiState() {
    if (!chromeApi.storage || !chromeApi.storage.local) {
      return;
    }
    try {
      const result = chromeApi.storage.local.set({
        [STORAGE_KEYS.POPUP_UI_STATE]: {
          filter: state.filter,
          sortBy: state.sortBy
        }
      });
      if (result && typeof result.catch === 'function') {
        result.catch(() => {});
      }
    } catch {
      // Non-fatal if local storage is unavailable
    }
  }

  /**
   * Synchronizes filter pill active styles and aria-pressed state with state.filter.
   */
  function applyActiveFilterUi() {
    for (const btn of els.filterBtns) {
      const isActive = (btn.dataset.filter || 'all') === state.filter;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-pressed', String(isActive));
    }
  }

  /**
   * Returns true if an item can be targeted by checkbox selection and batch download.
   * @param {object} item
   * @returns {boolean}
   */
  function isItemSelectable(item) {
    return Boolean(item && item.url && !item.isBlocked);
  }

  /**
   * Updates multi-select bar labels and button states from current selection and visible items.
   * @param {Array<object>} visible
   */
  function updateSelectionControls(visible) {
    if (!els.selectionBar || !els.selectAllBtn || !els.downloadSelectedBtn) {
      return;
    }
    const selectableVisible = visible.filter(isItemSelectable);
    if (state.batchRunning || state.pendingBatchItems || selectableVisible.length === 0) {
      els.selectionBar.classList.add('hidden');
      return;
    }

    els.selectionBar.classList.remove('hidden');
    const allVisibleSelected = selectableVisible.every((item) => state.selectedUrls.has(item.url));
    els.selectAllBtn.textContent = translateFn(
      allVisibleSelected ? 'popup_action_deselect_all' : 'popup_action_select_all'
    );

    const selectedTargets = state.items.filter(
      (item) => isItemSelectable(item) && state.selectedUrls.has(item.url)
    );
    els.downloadSelectedBtn.textContent = translateFn(
      'popup_action_download_selected',
      [String(selectedTargets.length)]
    );
    els.downloadSelectedBtn.disabled = selectedTargets.length === 0;
  }

  /**
   * Updates batch action controls to match pending/running/idle state.
   * @param {Array<object>} directVisible
   * @param {Array<object>} visible
   */
  function updateBatchControls(directVisible, visible = directVisible) {
    updateSelectionControls(visible);
    if (state.batchRunning) {
      els.downloadAllBtn.classList.add('hidden');
      els.batchConfirmBar.classList.add('hidden');
      els.stopBatchBtn.classList.remove('hidden');
      return;
    }
    els.stopBatchBtn.classList.add('hidden');
    els.stopBatchBtn.disabled = false;

    if (state.pendingBatchItems) {
      els.downloadAllBtn.classList.add('hidden');
      els.batchConfirmBar.classList.remove('hidden');
      return;
    }

    if (directVisible.length > 1) {
      els.downloadAllBtn.textContent = translateFn('popup_action_download_all', [String(directVisible.length)]);
      els.downloadAllBtn.classList.remove('hidden');
    } else {
      els.downloadAllBtn.classList.add('hidden');
    }
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
    if (els.countSubtitles) {
      els.countSubtitles.textContent = String(
        state.items.filter((i) => i.type === MEDIA_TYPES.SUBTITLE).length
      );
    }
  }

  /**
   * Filters and sorts the current media list based on active category, search query, and sort mode.
   * @returns {Array<object>}
   */
  function getVisibleItems() {
    const filtered = state.items.filter(
      (item) => matchesFilter(item, state.filter) && matchesSearch(item, state.searchQuery)
    );
    return sortMediaItems(filtered, state.sortBy, state.hlsMetaByUrl);
  }

  /**
   * Formats segment download or muxing progress text.
   * @param {number} done
   * @param {number} total
   * @returns {string}
   */
  function formatProgressText(done, total) {
    if (total > 0 && done >= total) {
      return translateFn('popup_status_hls_muxing');
    }
    if (total > 0) {
      return translateFn('popup_status_hls_segments', [String(done), String(total)]);
    }
    return translateFn('popup_status_hls_preparing');
  }

  /**
   * Attaches an active background stream build state onto a rendered media card.
   * @param {object} entry
   * @param {{ requestId: string, done?: number, total?: number }} build
   */
  function applyActiveBuildState(entry, build) {
    if (!entry || !build || !build.requestId) {
      return;
    }
    entry.activeRequestId = build.requestId;
    entry.showingCapWarning = false;
    entry.downloadBtn.disabled = true;
    if (entry.item.isStream && entry.cancelBtn) {
      entry.cancelBtn.disabled = false;
      entry.cancelBtn.classList.remove('hidden');
    }
    entry.progressEl.className = 'progress-line';
    entry.progressEl.textContent = formatProgressText(build.done || 0, build.total || 0);
    entry.progressEl.classList.remove('hidden');
  }

  /**
   * Clears active category filter and search query back to all detected items.
   */
  function resetFilters() {
    state.filter = 'all';
    state.searchQuery = '';
    if (els.searchInput) {
      els.searchInput.value = '';
    }
    applyActiveFilterUi();
    persistPopupUiState();
    hideBatchConfirm();
    renderList();
  }

  /**
   * Triggers a download request via the background service worker.
   * @param {object} entry
   * @param {string | undefined} selectedPlaylistUrl
   * @param {string} [selectedAudioUrl='']
   */
  async function triggerDownload(entry, selectedPlaylistUrl, selectedAudioUrl = '') {
    const { item, downloadBtn, cancelBtn, progressEl } = entry;
    const isOffscreenBuild = Boolean(item.isStream || item.isMse);
    const requestId = `dl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    entry.activeRequestId = requestId;
    entry.showingCapWarning = false;
    state.localPendingRequestIds.add(requestId);
    setStatusBanner('');
    downloadBtn.disabled = true;
    if (isOffscreenBuild && cancelBtn) {
      cancelBtn.disabled = false;
      cancelBtn.classList.remove('hidden');
    }
    progressEl.className = 'progress-line';
    progressEl.textContent = isOffscreenBuild ? translateFn('popup_status_hls_preparing') : '';
    progressEl.classList.toggle('hidden', !isOffscreenBuild);

    let failed = false;
    try {
      const response = await chromeApi.runtime.sendMessage({
        type: MESSAGE_TYPES.DOWNLOAD_MEDIA,
        payload: {
          url: item.url,
          playlistUrl: selectedPlaylistUrl || item.url,
          audioUrl: selectedAudioUrl || '',
          isStream: Boolean(item.isStream),
          isMse: Boolean(item.isMse),
          mseId: item.mseId || '',
          frameId: typeof item.frameId === 'number' ? item.frameId : undefined,
          ext: item.ext || '',
          referer: item.referer || state.activeTabUrl || '',
          tabId: typeof state.activeTabId === 'number' ? state.activeTabId : -1,
          filename: item.suggestedFilename,
          allowFolders: isFolderFilenameTemplate(state.settings.filenameTemplate),
          saveAs: Boolean(state.settings.promptSaveAs),
          requestId
        }
      });

      if (!response || !response.ok) {
        throw new Error((response && response.error) || 'DOWNLOAD_FAILED');
      }
      setStatusBanner(translateFn('popup_status_download_started'));
      if (isOffscreenBuild) {
        progressEl.classList.add('hidden');
      }
    } catch (err) {
      failed = true;
      if (err && err.message === 'DOWNLOAD_CANCELLED') {
        progressEl.className = 'progress-line';
        progressEl.textContent = localizeError(err.message, translateFn);
        progressEl.classList.remove('hidden');
        setStatusBanner(translateFn('popup_status_download_cancelled'));
      } else {
        progressEl.className = 'error-line';
        progressEl.textContent = localizeError(err.message, translateFn);
        progressEl.classList.remove('hidden');
      }
    } finally {
      state.localPendingRequestIds.delete(requestId);
      if (entry.activeRequestId === requestId) {
        entry.activeRequestId = '';
      }
      if (cancelBtn) {
        cancelBtn.classList.add('hidden');
        cancelBtn.disabled = false;
      }
      downloadBtn.disabled = false;
      if (!failed) {
        updateStreamLimitWarning(entry, cardContext);
      }
    }
  }

  /**
   * Enqueues a stream card entry for bounded manifest inspection.
   * @param {object} entry
   */
  function enqueueStreamHydration(entry) {
    if (entry.hlsHydrated) {
      return;
    }
    entry.hlsHydrated = true;
    state.hydrationQueue.push(entry);
    if (!state.hydrationScheduled) {
      state.hydrationScheduled = true;
      queueMicrotask(flushHydrationQueue);
    }
  }

  /**
   * Triggers a download for an HLS subtitle track from a stream card.
   * @param {object} entry
   * @param {string} subtitleUrl
   */
  async function triggerSubtitleDownload(entry, subtitleUrl) {
    if (!subtitleUrl) {
      return;
    }
    const baseName = (entry.item.suggestedFilename || DEFAULT_FILENAMES.BASE).replace(/\.[^./\\]+$/, '');
    const stem = `${baseName}_subtitles`;
    if (entry.subtitleBtn) {
      entry.subtitleBtn.disabled = true;
    }
    setStatusBanner(translateFn('popup_status_hls_preparing'));
    try {
      const response = await chromeApi.runtime.sendMessage({
        type: MESSAGE_TYPES.DOWNLOAD_HLS_SUBTITLE,
        payload: {
          subtitleUrl,
          filename: stem,
          allowFolders: isFolderFilenameTemplate(state.settings.filenameTemplate),
          saveAs: Boolean(state.settings.promptSaveAs)
        }
      });
      if (!response || !response.ok) {
        throw new Error((response && response.error) || 'DOWNLOAD_FAILED');
      }
      setStatusBanner(translateFn('popup_status_download_started'));
    } catch (err) {
      setStatusBanner(localizeError(err && err.message, translateFn), true);
    } finally {
      if (entry.subtitleBtn) {
        entry.subtitleBtn.disabled = false;
      }
    }
  }

  /**
   * Sends a target URL or page URL to the local Native Messaging companion (yt-dlp/ffmpeg).
   * @param {object | null} entry
   * @param {string} targetUrl
   */
  async function triggerCompanionDownload(entry, targetUrl) {
    const resolvedUrl = targetUrl || state.activeTabUrl;
    if (!resolvedUrl) {
      return;
    }
    if (entry && entry.companionBtn) {
      entry.companionBtn.disabled = true;
    }
    if (els.companionPageBtn && !entry) {
      els.companionPageBtn.disabled = true;
    }
    setStatusBanner(translateFn('popup_status_companion_started'));
    try {
      const response = await chromeApi.runtime.sendMessage({
        type: MESSAGE_TYPES.DOWNLOAD_WITH_COMPANION,
        payload: {
          url: resolvedUrl,
          referer: state.activeTabUrl || '',
          filename: entry && entry.item ? entry.item.suggestedFilename : '',
          quality: state.settings.defaultQuality
        }
      });
      if (!response || !response.ok) {
        throw new Error((response && response.error) || 'COMPANION_FAILED');
      }
      setStatusBanner(translateFn('popup_status_companion_done'));
    } catch (err) {
      setStatusBanner(localizeError(err && err.message, translateFn), true);
    } finally {
      if (entry && entry.companionBtn) {
        entry.companionBtn.disabled = false;
      }
      if (els.companionPageBtn && !entry) {
        els.companionPageBtn.disabled = false;
      }
    }
  }

  /**
   * Refreshes availability of the optional yt-dlp/ffmpeg Native Messaging companion.
   */
  async function refreshCompanionAvailability() {
    if (!chromeApi.runtime || typeof chromeApi.runtime.sendMessage !== 'function') {
      return;
    }
    try {
      const status = await chromeApi.runtime.sendMessage({ type: MESSAGE_TYPES.CHECK_COMPANION });
      state.companionAvailable = Boolean(status && status.ok && status.available);
    } catch {
      state.companionAvailable = false;
    }
    if (els.companionPageBtn) {
      els.companionPageBtn.classList.toggle('hidden', !state.companionAvailable);
    }
    for (const entry of state.cardsByUrl.values()) {
      if (entry.companionBtn) {
        entry.companionBtn.classList.toggle('hidden', !state.companionAvailable);
      }
    }
  }

  const cardContext = {
    documentRef: doc,
    translateFn,
    hlsMetaByUrl: state.hlsMetaByUrl,
    getSettings: () => state.settings,
    isCompanionAvailable: () => state.companionAvailable,
    onCompanionDownload: (entry, targetUrl) => triggerCompanionDownload(entry, targetUrl),
    isSelected: (url) => state.selectedUrls.has(url),
    onSelectionChange: (entry, checked) => {
      if (checked && isItemSelectable(entry.item)) {
        state.selectedUrls.add(entry.item.url);
      } else {
        state.selectedUrls.delete(entry.item.url);
      }
      const visibleNow = getVisibleItems();
      updateBatchControls(visibleNow.filter((item) => !item.isStream), visibleNow);
    },
    onDownload: triggerDownload,
    onDownloadSubtitle: triggerSubtitleDownload,
    onCancel: (requestId) => {
      chromeApi.runtime.sendMessage({
        type: MESSAGE_TYPES.CANCEL_DOWNLOAD,
        requestId
      }).catch(() => {});
    },
    onStatus: setStatusBanner,
    onHydrateRequest: enqueueStreamHydration
  };

  /**
   * Inspects a single stream entry's manifest and updates card variants/status.
   * @param {object} entry
   */
  async function inspectStreamEntry(entry) {
    if (!entry.card.isConnected) {
      entry.hlsHydrated = false;
      return;
    }

    let meta = state.hlsMetaByUrl.get(entry.item.url);
    if (!meta) {
      try {
        const response = await chromeApi.runtime.sendMessage({
          type: MESSAGE_TYPES.INSPECT_HLS,
          url: entry.item.url,
          referer: entry.item.referer || state.activeTabUrl || ''
        });
        if (!response || !response.ok) {
          entry.hlsHydrated = false;
          markInspectionFailed(entry, (response && response.error) || 'INVALID_DASH_MANIFEST', cardContext);
          return;
        }
        meta = response;
        state.hlsMetaByUrl.set(entry.item.url, meta);
      } catch (err) {
        entry.hlsHydrated = false;
        markInspectionFailed(entry, (err && err.message) || '', cardContext);
        return;
      }
    }

    if (entry.card.isConnected) {
      applyStreamMetadata(entry, meta, cardContext);
      if (state.sortBy !== SORT_MODES.DEFAULT) {
        renderList();
      }
    }
  }

  /**
   * Drains queued stream metadata inspection requests using bounded concurrency.
   */
  async function flushHydrationQueue() {
    state.hydrationScheduled = false;
    if (state.hydrationQueue.length === 0) {
      return;
    }
    const batch = state.hydrationQueue.splice(0);
    await runWithConcurrency(batch, LIMITS.INSPECT_CONCURRENCY, inspectStreamEntry);
    if (state.hydrationQueue.length > 0 && !state.hydrationScheduled) {
      state.hydrationScheduled = true;
      queueMicrotask(flushHydrationQueue);
    }
  }

  /**
   * Updates banners and reconciles the media card list without destroying active card state.
   */
  function renderList() {
    const activeUrls = new Set(state.items.map((item) => item.url));
    for (const url of Array.from(state.selectedUrls)) {
      if (!activeUrls.has(url)) {
        state.selectedUrls.delete(url);
      }
    }

    const visible = getVisibleItems();
    const directVisible = visible.filter((item) => !item.isStream);
    updateBatchControls(directVisible, visible);

    const hasCapturedStream = state.items.some(
      (i) => i.type === MEDIA_TYPES.STREAM || i.type === MEDIA_TYPES.VIDEO
    );
    if (state.hasBlobVideo && !hasCapturedStream) {
      els.hintBanner.textContent = translateFn('popup_hint_blob_detected');
      els.hintBanner.classList.remove('hidden');
    } else {
      els.hintBanner.classList.add('hidden');
    }

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
      if (state.lastLoadError) {
        if (existingEmpty) {
          existingEmpty.remove();
        }
        return;
      }
      const isFilteredEmpty = state.items.length > 0
        && (state.filter !== 'all' || state.searchQuery.trim() !== '');
      const empty = existingEmpty || doc.createElement('div');
      empty.className = 'empty-state';
      const emptyMsg = doc.createElement('span');
      emptyMsg.textContent = translateFn(isFilteredEmpty ? 'popup_status_filter_empty' : 'popup_status_empty');
      if (isFilteredEmpty) {
        const resetFilterBtn = doc.createElement('button');
        resetFilterBtn.type = 'button';
        resetFilterBtn.className = 'btn btn-secondary btn-compact empty-reset-btn';
        resetFilterBtn.textContent = translateFn('popup_action_reset_filters');
        resetFilterBtn.addEventListener('click', resetFilters);
        empty.replaceChildren(emptyMsg, resetFilterBtn);
      } else {
        const emptyHint = doc.createElement('span');
        emptyHint.className = 'empty-state-hint';
        emptyHint.textContent = translateFn('popup_status_empty_hint');
        empty.replaceChildren(emptyMsg, emptyHint);
      }
      if (!existingEmpty) {
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
        updateCardEntry(entry, item, cardContext);
      } else {
        entry = createMediaCard(item, cardContext);
        state.cardsByUrl.set(item.url, entry);
      }
      const pendingBuild = state.activeBuildsByUrl.get(item.url);
      if (pendingBuild && !entry.activeRequestId) {
        applyActiveBuildState(entry, pendingBuild);
      } else if (
        state.hasActiveBuildSnapshot &&
        !pendingBuild &&
        entry.activeRequestId &&
        !state.localPendingRequestIds.has(entry.activeRequestId)
      ) {
        entry.activeRequestId = '';
        entry.downloadBtn.disabled = false;
        if (entry.cancelBtn) {
          entry.cancelBtn.classList.add('hidden');
          entry.cancelBtn.disabled = false;
        }
        entry.progressEl.classList.add('hidden');
      }
      entry.card.classList.remove('hidden');
      return entry;
    });

    for (let i = 0; i < orderedEntries.length; i += 1) {
      const entry = orderedEntries[i];
      if (!entry.card.isConnected) {
        let anchor = null;
        for (let j = i + 1; j < orderedEntries.length; j += 1) {
          if (orderedEntries[j].card.isConnected) {
            anchor = orderedEntries[j].card;
            break;
          }
        }
        els.mediaList.insertBefore(entry.card, anchor);
      } else if (state.sortBy !== SORT_MODES.DEFAULT) {
        const anchor = i + 1 < orderedEntries.length && orderedEntries[i + 1].card.isConnected
          ? orderedEntries[i + 1].card
          : null;
        if (entry.card.nextSibling !== anchor) {
          els.mediaList.insertBefore(entry.card, anchor);
        }
      }
    }
  }

  /**
   * Loads media items for the currently active Chrome tab.
   * @param {{ showLoading?: boolean }} [options]
   */
  async function loadActiveTabMedia({ showLoading = true } = {}) {
    state.loadGeneration += 1;
    const generation = state.loadGeneration;
    hideBatchConfirm();

    els.refreshBtn.classList.add('is-spinning');
    els.refreshBtn.disabled = true;
    if (showLoading) {
      setStatusBanner(translateFn('popup_status_loading'));
    }

    try {
      const [tab] = await chromeApi.tabs.query({ active: true, currentWindow: true });
      if (generation !== state.loadGeneration) {
        return;
      }
      if (!tab || typeof tab.id !== 'number') {
        throw new Error('NO_ACTIVE_TAB');
      }

      state.activeTabId = tab.id;
      state.activeTabUrl = tab.url || '';

      const response = await chromeApi.runtime.sendMessage({
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
      state.lastLoadError = false;
      state.hasActiveBuildSnapshot = false;
      state.activeBuildsByUrl.clear();
      try {
        const buildsResp = await chromeApi.runtime.sendMessage({
          type: MESSAGE_TYPES.GET_ACTIVE_BUILDS
        });
        if (generation !== state.loadGeneration) {
          return;
        }
        if (buildsResp && buildsResp.ok && Array.isArray(buildsResp.builds)) {
          state.hasActiveBuildSnapshot = true;
          for (const build of buildsResp.builds) {
            if (build && build.url && build.requestId) {
              state.activeBuildsByUrl.set(build.url, build);
            }
          }
        }
      } catch {
        // Active build sync is best-effort
      }
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
      state.lastLoadError = true;
      updateCounts();
      renderList();
      setStatusBanner(localizeError(err.message, translateFn), true);
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
    setStatusBanner(translateFn('popup_status_reloading_tab'));

    try {
      const clearResp = await chromeApi.runtime.sendMessage({
        type: MESSAGE_TYPES.CLEAR_MEDIA_FOR_TAB,
        tabId: targetTabId
      });
      if (!clearResp || !clearResp.ok) {
        throw new Error((clearResp && clearResp.error) || 'CLEAR_FAILED');
      }
    } catch (err) {
      els.reloadTabBtn.disabled = false;
      setStatusBanner(localizeError(err.message, translateFn), true);
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
      chromeApi.tabs.onUpdated.removeListener(onTabUpdated);
      chromeApi.tabs.onRemoved.removeListener(onTabRemoved);
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

    chromeApi.tabs.onUpdated.addListener(onTabUpdated);
    chromeApi.tabs.onRemoved.addListener(onTabRemoved);
    try {
      await chromeApi.tabs.reload(targetTabId);
    } catch (err) {
      cleanup();
      setStatusBanner(localizeError(err.message, translateFn), true);
    }
  }

  /**
   * Executes a sequential batch of direct and stream downloads with stop support.
   * @param {Array<object>} batchItems
   */
  async function executeBatchDownloads(batchItems) {
    return runBatchDownloads({
      batchItems,
      state,
      chromeApi,
      translateFn,
      setStatusBanner,
      hideBatchConfirm,
      renderList,
      isFolderFilenameTemplate,
      batchDelayMs
    });
  }

  /**
   * Resolves a rendered card entry by active requestId or fallback media URL.
   * @param {string | undefined} requestId
   * @param {string | undefined} url
   * @returns {object | null}
   */
  function findCardEntryForBuild(requestId, url) {
    if (requestId) {
      for (const candidate of state.cardsByUrl.values()) {
        if (candidate.activeRequestId === requestId) {
          return candidate;
        }
      }
    }
    return url ? (state.cardsByUrl.get(url) || null) : null;
  }

  /**
   * Processes incoming runtime messages for download progress or tab media updates.
   * @param {object} message
   */
  function handleRuntimeMessage(message) {
    if (!message) {
      return;
    }

    if (message.type === MESSAGE_TYPES.DOWNLOAD_PROGRESS) {
      if (message.url && message.requestId) {
        state.activeBuildsByUrl.set(message.url, {
          requestId: message.requestId,
          url: message.url,
          done: message.done || 0,
          total: message.total || 0
        });
      }
      const entry = findCardEntryForBuild(message.requestId, message.url);
      if (!entry) {
        return;
      }
      if (!entry.activeRequestId && message.requestId) {
        applyActiveBuildState(entry, {
          requestId: message.requestId,
          done: message.done,
          total: message.total
        });
        return;
      }
      entry.progressEl.className = 'progress-line';
      entry.progressEl.textContent = formatProgressText(message.done || 0, message.total || 0);
      entry.progressEl.classList.remove('hidden');
      return;
    }

    if (message.type === MESSAGE_TYPES.DOWNLOAD_FINISHED) {
      if (message.url) {
        state.activeBuildsByUrl.delete(message.url);
      }
      if (message.requestId && state.localPendingRequestIds.has(message.requestId)) {
        return;
      }
      const entry = findCardEntryForBuild(message.requestId, message.url);
      if (!entry) {
        return;
      }
      if (entry.activeRequestId === message.requestId) {
        entry.activeRequestId = '';
      }
      if (entry.cancelBtn) {
        entry.cancelBtn.classList.add('hidden');
        entry.cancelBtn.disabled = false;
      }
      entry.downloadBtn.disabled = false;
      if (message.ok) {
        entry.progressEl.classList.add('hidden');
        setStatusBanner(translateFn('popup_status_download_started'));
        updateStreamLimitWarning(entry, cardContext);
      } else if (message.error === 'DOWNLOAD_CANCELLED') {
        entry.progressEl.className = 'progress-line';
        entry.progressEl.textContent = localizeError(message.error, translateFn);
        entry.progressEl.classList.remove('hidden');
        setStatusBanner(translateFn('popup_status_download_cancelled'));
      } else {
        entry.progressEl.className = 'error-line';
        entry.progressEl.textContent = localizeError(message.error, translateFn);
        entry.progressEl.classList.remove('hidden');
      }
      return;
    }

    if (message.type === MESSAGE_TYPES.COMPANION_PROGRESS) {
      const pct = Number.isFinite(message.percent) ? Math.max(0, Math.min(100, Math.round(message.percent))) : 0;
      setStatusBanner(translateFn('popup_status_companion_progress', [String(pct)]));
      return;
    }

    if (message.type === MESSAGE_TYPES.MEDIA_UPDATED && message.tabId === state.activeTabId) {
      clearTimeout(state.refreshDebounceTimer);
      state.refreshDebounceTimer = setTimeout(() => {
        loadActiveTabMedia({ showLoading: false });
      }, LIMITS.MEDIA_UPDATE_DEBOUNCE_MS);
    }
  }

  /**
   * Handles global keyboard navigation: Escape closes previews, dismisses batch confirmations,
   * or clears/blurs the search input; Slash focuses the search bar.
   * @param {KeyboardEvent} event
   */
  function handleGlobalKeyDown(event) {
    if (!event) {
      return;
    }
    if (event.key === 'Escape') {
      let hadActivePreview = false;
      for (const entry of state.cardsByUrl.values()) {
        if (entry.previewBox && !entry.previewBox.classList.contains('hidden')) {
          closeCardPreview(entry);
          hadActivePreview = true;
        }
      }
      if (hadActivePreview) {
        return;
      }
      if (state.pendingBatchItems) {
        hideBatchConfirm();
        renderList();
        return;
      }
      if (els.searchInput && doc.activeElement === els.searchInput) {
        if (els.searchInput.value) {
          resetFilters();
        } else if (typeof els.searchInput.blur === 'function') {
          els.searchInput.blur();
        }
      }
      return;
    }

    if (event.key === '/') {
      const activeTag = doc.activeElement && doc.activeElement.tagName;
      const isInput = activeTag === 'INPUT' || activeTag === 'TEXTAREA' || activeTag === 'SELECT';
      if (!isInput && els.searchInput) {
        if (typeof event.preventDefault === 'function') {
          event.preventDefault();
        }
        if (typeof els.searchInput.focus === 'function') {
          els.searchInput.focus();
        }
        if (typeof els.searchInput.select === 'function') {
          els.searchInput.select();
        }
      }
    }
  }

  /**
   * Initializes DOM listeners, Chrome message hooks, translations, and initial tab load.
   * @returns {Promise<void>}
   */
  async function init() {
    doc.documentElement.lang = getLangFn();
    applyI18nFn(doc);

    if (chromeApi.runtime && chromeApi.runtime.onMessage) {
      chromeApi.runtime.onMessage.addListener(handleRuntimeMessage);
    }

    for (const btn of els.filterBtns) {
      btn.addEventListener('click', () => {
        state.filter = btn.dataset.filter || 'all';
        hideBatchConfirm();
        applyActiveFilterUi();
        persistPopupUiState();
        renderList();
      });
    }

    if (els.searchInput) {
      els.searchInput.addEventListener('input', () => {
        state.searchQuery = els.searchInput.value || '';
        hideBatchConfirm();
        renderList();
      });
    }

    if (els.sortSelect) {
      els.sortSelect.addEventListener('change', () => {
        state.sortBy = els.sortSelect.value || SORT_MODES.DEFAULT;
        hideBatchConfirm();
        persistPopupUiState();
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
        const response = await chromeApi.runtime.sendMessage({
          type: MESSAGE_TYPES.CLEAR_MEDIA_FOR_TAB,
          tabId: state.activeTabId
        });
        if (!response || !response.ok) {
          throw new Error((response && response.error) || 'CLEAR_FAILED');
        }
        await loadActiveTabMedia();
        setStatusBanner(translateFn('popup_status_cleared'));
      } catch (err) {
        setStatusBanner(localizeError(err.message, translateFn), true);
      }
    });

    if (els.selectAllBtn) {
      els.selectAllBtn.addEventListener('click', () => {
        const selectableVisible = getVisibleItems().filter(isItemSelectable);
        if (selectableVisible.length === 0) {
          return;
        }
        const allSelected = selectableVisible.every((item) => state.selectedUrls.has(item.url));
        for (const item of selectableVisible) {
          if (allSelected) {
            state.selectedUrls.delete(item.url);
          } else {
            state.selectedUrls.add(item.url);
          }
          const cardEntry = state.cardsByUrl.get(item.url);
          if (cardEntry && cardEntry.selectCheckbox) {
            cardEntry.selectCheckbox.checked = !allSelected;
          }
        }
        const visibleNow = getVisibleItems();
        updateBatchControls(visibleNow.filter((item) => !item.isStream), visibleNow);
      });
    }

    if (els.downloadSelectedBtn) {
      els.downloadSelectedBtn.addEventListener('click', () => {
        const selectedItems = sortMediaItems(
          state.items.filter((item) => isItemSelectable(item) && state.selectedUrls.has(item.url)),
          state.sortBy,
          state.hlsMetaByUrl
        );
        if (selectedItems.length === 0) {
          return;
        }
        if (selectedItems.length >= LIMITS.BATCH_CONFIRM_THRESHOLD) {
          state.pendingBatchItems = selectedItems;
          els.batchConfirmText.textContent = translateFn('popup_confirm_download_all', [String(selectedItems.length)]);
          const visibleNow = getVisibleItems();
          updateBatchControls(visibleNow.filter((item) => !item.isStream), visibleNow);
          return;
        }
        return executeBatchDownloads(selectedItems);
      });
    }

    els.downloadAllBtn.addEventListener('click', () => {
      const directItems = getVisibleItems().filter((item) => !item.isStream);
      if (directItems.length === 0) {
        return;
      }
      if (directItems.length >= LIMITS.BATCH_CONFIRM_THRESHOLD) {
        state.pendingBatchItems = directItems;
        els.batchConfirmText.textContent = translateFn('popup_confirm_download_all', [String(directItems.length)]);
        updateBatchControls(directItems, getVisibleItems());
        return;
      }
      return executeBatchDownloads(directItems);
    });

    els.batchConfirmBtn.addEventListener('click', () => {
      const items = state.pendingBatchItems || [];
      return executeBatchDownloads(items);
    });

    els.batchCancelBtn.addEventListener('click', () => {
      hideBatchConfirm();
      renderList();
    });

    els.stopBatchBtn.addEventListener('click', () => {
      state.batchAbortRequested = true;
      els.stopBatchBtn.disabled = true;
      if (state.activeBatchRequestId) {
        chromeApi.runtime.sendMessage({
          type: MESSAGE_TYPES.CANCEL_DOWNLOAD,
          requestId: state.activeBatchRequestId
        }).catch(() => {});
      }
    });

    if (els.sidePanelBtn) {
      if (chromeApi.sidePanel && typeof chromeApi.sidePanel.open === 'function') {
        els.sidePanelBtn.addEventListener('click', async () => {
          try {
            let windowId;
            if (chromeApi.windows && typeof chromeApi.windows.getCurrent === 'function') {
              const currentWin = await chromeApi.windows.getCurrent();
              windowId = currentWin && currentWin.id;
            } else if (chromeApi.tabs && typeof chromeApi.tabs.query === 'function') {
              const [activeTab] = await chromeApi.tabs.query({ active: true, currentWindow: true });
              windowId = activeTab && activeTab.windowId;
            }
            if (typeof windowId === 'number') {
              await chromeApi.sidePanel.open({ windowId });
              if (typeof win.close === 'function') {
                win.close();
              }
            }
          } catch {
            // Ignore when browser denies opening side panel programmatically
          }
        });
      } else {
        els.sidePanelBtn.classList.add('hidden');
      }
    }

    if (els.optionsBtn) {
      els.optionsBtn.addEventListener('click', () => {
        chromeApi.runtime.openOptionsPage();
      });
    }

    if (els.companionPageBtn) {
      els.companionPageBtn.addEventListener('click', () => triggerCompanionDownload(null, state.activeTabUrl));
    }

    if (chromeApi.storage && chromeApi.storage.onChanged) {
      chromeApi.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== 'sync' || !changes[STORAGE_KEYS.USER_SETTINGS]) {
          return;
        }
        state.settings = normalizeSettingsFn(changes[STORAGE_KEYS.USER_SETTINGS].newValue);
        for (const entry of state.cardsByUrl.values()) {
          renderBadges(entry.badgesEl, entry.item, entry, cardContext);
          updateStreamLimitWarning(entry, cardContext);
        }
      });
    }

    win.addEventListener('pagehide', revokeAllPreviewBlobs);
    if (doc && typeof doc.addEventListener === 'function') {
      doc.addEventListener('keydown', handleGlobalKeyDown);
    }

    try {
      state.settings = await loadSettingsFn();
    } catch {
      // Keep default settings if sync storage read fails
    }
    await restorePopupUiState();
    refreshCompanionAvailability();
    await loadActiveTabMedia();
  }

  return {
    state,
    els,
    init,
    loadActiveTabMedia,
    renderList,
    triggerDownload,
    executeBatchDownloads,
    flushHydrationQueue,
    handleRuntimeMessage,
    handleGlobalKeyDown,
    revokeAllPreviewBlobs
  };
}

if (typeof document !== 'undefined' && document.getElementById('mediaList')) {
  createPopupController().init();
}
