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
  IMAGE_CONVERT_FORMATS,
  IMAGE_EXTENSIONS,
  LIGHTBOX_BG_MODES,
  LIMITS,
  MEDIA_TYPES,
  MESSAGE_TYPES,
  POPUP_VIEW_MODES,
  SORT_MODES,
  STORAGE_KEYS
} from '../config/constants.js';
import { applyTranslations, getUiLanguage, t } from '../shared/i18n.js';
import { isSvgDataUrl } from '../shared/media_classifier.js';
import { isFolderFilenameTemplate, loadSettings, normalizeSettings } from '../shared/settings.js';
import {
  applyStreamMetadata,
  createMediaCard,
  markInspectionFailed,
  refreshAudioExtractButton,
  renderBadges,
  updateCardEntry,
  updateStreamLimitWarning
} from './media_card.js';
import {
  formatBytes,
  formatDuration,
  localizeError,
  matchesFilter,
  matchesImageQuickFilters,
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
    viewModeBtn: doc.getElementById('viewModeBtn'),
    imageFiltersBar: doc.getElementById('imageFiltersBar'),
    minImagePxSelect: doc.getElementById('minImagePxSelect'),
    imageExtFilterSelect: doc.getElementById('imageExtFilterSelect'),
    imageScaleSelect: doc.getElementById('imageScaleSelect'),
    imageConvertSelect: doc.getElementById('imageConvertSelect'),
    selectionBar: doc.getElementById('selectionBar'),
    selectAllBtn: doc.getElementById('selectAllBtn'),
    clearSelectionBtn: doc.getElementById('clearSelectionBtn'),
    downloadSelectedBtn: doc.getElementById('downloadSelectedBtn'),
    downloadZipBtn: doc.getElementById('downloadZipBtn'),
    imageLightbox: doc.getElementById('imageLightbox'),
    lightboxBackdrop: doc.getElementById('lightboxBackdrop'),
    lightboxTitle: doc.getElementById('lightboxTitle'),
    lightboxMeta: doc.getElementById('lightboxMeta'),
    lightboxStage: doc.getElementById('lightboxStage'),
    lightboxImg: doc.getElementById('lightboxImg'),
    lightboxBgCheckerBtn: doc.getElementById('lightboxBgCheckerBtn'),
    lightboxBgLightBtn: doc.getElementById('lightboxBgLightBtn'),
    lightboxBgDarkBtn: doc.getElementById('lightboxBgDarkBtn'),
    lightboxCopyBtn: doc.getElementById('lightboxCopyBtn'),
    lightboxDownloadBtn: doc.getElementById('lightboxDownloadBtn'),
    lightboxCloseBtn: doc.getElementById('lightboxCloseBtn'),
    downloadAllBtn: doc.getElementById('downloadAllBtn'),
    companionPageBtn: doc.getElementById('companionPageBtn'),
    stopBatchBtn: doc.getElementById('stopBatchBtn'),
    batchConfirmBar: doc.getElementById('batchConfirmBar'),
    batchConfirmText: doc.getElementById('batchConfirmText'),
    batchConfirmBtn: doc.getElementById('batchConfirmBtn'),
    batchCancelBtn: doc.getElementById('batchCancelBtn'),
    refreshBtn: doc.getElementById('refreshBtn'),
    reloadTabBtn: doc.getElementById('reloadTabBtn'),
    tabCaptureBtn: doc.getElementById('tabCaptureBtn'),
    tabCaptureLabel: doc.getElementById('tabCaptureLabel'),
    clearBtn: doc.getElementById('clearBtn'),
    sidePanelBtn: doc.getElementById('sidePanelBtn'),
    optionsBtn: doc.getElementById('optionsBtn'),
    countAll: doc.getElementById('countAll'),
    countVideos: doc.getElementById('countVideos'),
    countImages: doc.getElementById('countImages'),
    countSvg: doc.getElementById('countSvg'),
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
    activeTabTitle: '',
    filter: 'all',
    searchQuery: '',
    sortBy: SORT_MODES.DEFAULT,
    viewMode: POPUP_VIEW_MODES.LIST,
    imageConvertFormat: IMAGE_CONVERT_FORMATS.ORIGINAL,
    minImagePx: 0,
    imageExtFilter: '',
    imageScalePx: LIMITS.DEFAULT_SVG_RASTER_SIZE_PX,
    activeZipRequestId: '',
    activeTabCapture: null,
    lightboxEntry: null,
    lightboxBg: LIGHTBOX_BG_MODES.CHECKER,
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

  const VALID_FILTERS = new Set(['all', 'videos', 'images', 'svg', 'audio', 'subtitles']);
  const VALID_SORTS = new Set(Object.values(SORT_MODES));
  const VALID_VIEW_MODES = new Set(Object.values(POPUP_VIEW_MODES));
  const VALID_MIN_IMAGE_PX = new Set(LIMITS.QUICK_MIN_IMAGE_PX_OPTIONS);
  const VALID_SVG_SCALES = new Set(LIMITS.SVG_RASTER_SIZES);
  const QUICK_IMAGE_EXTENSIONS = IMAGE_EXTENSIONS.filter((ext) => ext !== 'jpeg');
  const VALID_IMAGE_EXTS = new Set(['', ...QUICK_IMAGE_EXTENSIONS]);

  /**
   * Populates quick image filter and SVG export resolution selectors from shared constants.
   */
  function populateImageFilterOptions() {
    if (els.minImagePxSelect && els.minImagePxSelect.options && els.minImagePxSelect.options.length === 0) {
      for (const px of LIMITS.QUICK_MIN_IMAGE_PX_OPTIONS) {
        const opt = doc.createElement('option');
        opt.value = String(px);
        opt.textContent = px === 0
          ? translateFn('popup_image_min_px_all')
          : translateFn('popup_image_min_px_value', [String(px)]);
        els.minImagePxSelect.appendChild(opt);
      }
    }
    if (els.imageExtFilterSelect && els.imageExtFilterSelect.options && els.imageExtFilterSelect.options.length === 0) {
      const allOpt = doc.createElement('option');
      allOpt.value = '';
      allOpt.textContent = translateFn('popup_image_ext_all');
      els.imageExtFilterSelect.appendChild(allOpt);
      for (const ext of QUICK_IMAGE_EXTENSIONS) {
        const opt = doc.createElement('option');
        opt.value = ext;
        opt.textContent = ext.toUpperCase();
        els.imageExtFilterSelect.appendChild(opt);
      }
    }
    if (els.imageScaleSelect && els.imageScaleSelect.options && els.imageScaleSelect.options.length === 0) {
      for (const sizePx of LIMITS.SVG_RASTER_SIZES) {
        const opt = doc.createElement('option');
        opt.value = String(sizePx);
        opt.textContent = translateFn('popup_svg_scale_value', [String(sizePx)]);
        els.imageScaleSelect.appendChild(opt);
      }
    }
  }

  /**
   * Shows and synchronizes quick image filters bar when viewing images or SVG tabs.
   */
  function applyImageFiltersUi() {
    const showImageFilters = state.filter === 'images' || state.filter === 'svg';
    if (els.imageFiltersBar) {
      els.imageFiltersBar.classList.toggle('hidden', !showImageFilters);
    }
    if (els.minImagePxSelect) {
      els.minImagePxSelect.value = String(state.minImagePx || 0);
    }
    if (els.imageExtFilterSelect) {
      els.imageExtFilterSelect.value = state.imageExtFilter || '';
    }
    if (els.imageScaleSelect) {
      els.imageScaleSelect.value = String(state.imageScalePx || LIMITS.DEFAULT_SVG_RASTER_SIZE_PX);
    }
  }

  /**
   * Restores persisted filter category, sort order, and view mode from local extension storage.
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
      if (typeof saved.viewMode === 'string' && VALID_VIEW_MODES.has(saved.viewMode)) {
        state.viewMode = saved.viewMode;
      }
      if (Number.isFinite(saved.minImagePx) && VALID_MIN_IMAGE_PX.has(saved.minImagePx)) {
        state.minImagePx = saved.minImagePx;
      }
      if (typeof saved.imageExtFilter === 'string' && VALID_IMAGE_EXTS.has(saved.imageExtFilter)) {
        state.imageExtFilter = saved.imageExtFilter;
      }
      if (Number.isFinite(saved.imageScalePx) && VALID_SVG_SCALES.has(saved.imageScalePx)) {
        state.imageScalePx = saved.imageScalePx;
      }
      applyActiveFilterUi();
      applyViewModeUi();
      applyImageFiltersUi();
      if (els.sortSelect) {
        els.sortSelect.value = state.sortBy;
      }
    } catch {
      // Ignore storage read failures and retain default view state
    }
  }

  /**
   * Saves the active filter category, sort order, and view mode to local extension storage.
   */
  function persistPopupUiState() {
    if (!chromeApi.storage || !chromeApi.storage.local) {
      return;
    }
    try {
      const result = chromeApi.storage.local.set({
        [STORAGE_KEYS.POPUP_UI_STATE]: {
          filter: state.filter,
          sortBy: state.sortBy,
          viewMode: state.viewMode,
          minImagePx: state.minImagePx,
          imageExtFilter: state.imageExtFilter,
          imageScalePx: state.imageScalePx
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
   * Synchronizes media list layout (list or gallery grid) and toggle button labels.
   */
  function applyViewModeUi() {
    const isGrid = state.viewMode === POPUP_VIEW_MODES.GRID;
    if (els.mediaList && els.mediaList.classList) {
      els.mediaList.classList.toggle('is-grid', isGrid);
    }
    if (els.viewModeBtn) {
      els.viewModeBtn.classList.toggle('is-active', isGrid);
      els.viewModeBtn.setAttribute('aria-pressed', String(isGrid));
      const key = isGrid ? 'popup_action_view_list' : 'popup_action_view_grid';
      els.viewModeBtn.title = translateFn(key);
      els.viewModeBtn.setAttribute('aria-label', translateFn(key));
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
    if (els.imageConvertSelect) {
      const hasImages = visible.some((item) => item.type === MEDIA_TYPES.IMAGE);
      els.imageConvertSelect.classList.toggle('hidden', !hasImages);
      els.imageConvertSelect.disabled = Boolean(state.batchRunning);
    }
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
    els.downloadSelectedBtn.disabled = selectedTargets.length === 0 || Boolean(state.activeZipRequestId);
    if (els.downloadZipBtn) {
      const selectedZipTargets = selectedTargets.filter((item) => !item.isStream && !item.isMse);
      els.downloadZipBtn.textContent = translateFn(
        'popup_action_download_zip',
        [String(selectedZipTargets.length)]
      );
      els.downloadZipBtn.disabled = selectedZipTargets.length === 0 || Boolean(state.activeZipRequestId);
    }
    if (els.clearSelectionBtn) {
      els.clearSelectionBtn.classList.toggle('hidden', state.selectedUrls.size === 0);
    }
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
    if (els.countSvg) {
      els.countSvg.textContent = String(
        state.items.filter((i) => (i.ext || '').toLowerCase() === DEFAULT_FILENAMES.SVG_EXT).length
      );
    }
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
    const useQuickImageFilters = state.filter === 'images' || state.filter === 'svg';
    const filtered = state.items.filter(
      (item) => matchesFilter(item, state.filter)
        && matchesSearch(item, state.searchQuery)
        && (!useQuickImageFilters || matchesImageQuickFilters(item, {
          minImagePx: state.minImagePx,
          imageExt: state.imageExtFilter
        }))
    );
    return sortMediaItems(filtered, state.sortBy, state.hlsMetaByUrl);
  }

  /**
   * Formats segment download or muxing progress text.
   * @param {number} done
   * @param {number} total
   * @param {{ isLiveRecord?: boolean, bytes?: number }} [opts={}]
   * @returns {string}
   */
  function formatProgressText(done, total, opts = {}) {
    if (total > 0 && done >= total) {
      return translateFn('popup_status_hls_muxing');
    }
    if (opts.isLiveRecord) {
      const sizeLabel = formatBytes(opts.bytes || 0) || '0 KB';
      return translateFn('popup_status_live_recording', [String(done || 0), sizeLabel]);
    }
    if (total > 0) {
      return translateFn('popup_status_hls_segments', [String(done), String(total)]);
    }
    return translateFn('popup_status_hls_preparing');
  }

  /**
   * Attaches an active background stream build state onto a rendered media card.
   * @param {object} entry
   * @param {{ requestId: string, done?: number, total?: number, isLiveRecord?: boolean, bytes?: number }} build
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
    if (entry.stopRecordBtn) {
      const showStop = Boolean(build.isLiveRecord) && !(build.total > 0 && (build.done || 0) >= build.total);
      entry.stopRecordBtn.disabled = !showStop;
      entry.stopRecordBtn.classList.toggle('hidden', !showStop);
    }
    entry.progressEl.className = 'progress-line';
    entry.progressEl.textContent = formatProgressText(build.done || 0, build.total || 0, {
      isLiveRecord: Boolean(build.isLiveRecord),
      bytes: build.bytes || 0
    });
    entry.progressEl.classList.remove('hidden');
  }

  /**
   * Clears active category filter and search query back to all detected items.
   */
  function resetFilters() {
    state.filter = 'all';
    state.searchQuery = '';
    state.minImagePx = 0;
    state.imageExtFilter = '';
    if (els.searchInput) {
      els.searchInput.value = '';
    }
    applyActiveFilterUi();
    applyImageFiltersUi();
    persistPopupUiState();
    hideBatchConfirm();
    renderList();
  }

  /**
   * Triggers a download request via the background service worker.
   * @param {object} entry
   * @param {string | undefined} selectedPlaylistUrl
   * @param {string} [selectedAudioUrl='']
   * @param {{ audioOnly?: boolean, convertTo?: string, filenameOverride?: string, recordLive?: boolean }} [options={}]
   */
  async function triggerDownload(entry, selectedPlaylistUrl, selectedAudioUrl = '', options = {}) {
    const { item, downloadBtn, cancelBtn, stopRecordBtn, progressEl } = entry;
    const convertTo = typeof options.convertTo === 'string' ? options.convertTo : '';
    const rasterSizePx = convertTo
      ? (Number(state.imageScalePx) || LIMITS.DEFAULT_SVG_RASTER_SIZE_PX)
      : 0;
    const recordLive = Boolean(options.recordLive || (item.canRecordLive && !options.audioOnly && !convertTo));
    const isOffscreenBuild = Boolean(item.isStream || item.isMse || convertTo);
    const requestId = `dl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    entry.activeRequestId = requestId;
    entry.showingCapWarning = false;
    state.localPendingRequestIds.add(requestId);
    setStatusBanner('');
    downloadBtn.disabled = true;
    if (entry.audioExtractBtn) {
      entry.audioExtractBtn.disabled = true;
    }
    if (recordLive && stopRecordBtn) {
      stopRecordBtn.disabled = false;
      stopRecordBtn.classList.remove('hidden');
    }
    if (isOffscreenBuild && cancelBtn) {
      cancelBtn.disabled = false;
      cancelBtn.classList.remove('hidden');
    }
    progressEl.className = 'progress-line';
    progressEl.textContent = isOffscreenBuild
      ? (recordLive ? formatProgressText(0, 0, { isLiveRecord: true, bytes: 0 }) : translateFn('popup_status_hls_preparing'))
      : '';
    progressEl.classList.toggle('hidden', !isOffscreenBuild);

    let failed = false;
    try {
      const response = await chromeApi.runtime.sendMessage({
        type: MESSAGE_TYPES.DOWNLOAD_MEDIA,
        payload: {
          url: item.url,
          playlistUrl: selectedPlaylistUrl || item.url,
          audioUrl: selectedAudioUrl || '',
          audioOnly: Boolean(options.audioOnly),
          recordLive,
          convertTo,
          rasterSizePx,
          width: item.width || 0,
          height: item.height || 0,
          isStream: Boolean(item.isStream),
          isMse: Boolean(item.isMse),
          mseId: item.mseId || '',
          frameId: typeof item.frameId === 'number' ? item.frameId : undefined,
          ext: item.ext || '',
          referer: item.referer || state.activeTabUrl || '',
          tabId: typeof state.activeTabId === 'number' ? state.activeTabId : -1,
          filename: options.filenameOverride || item.suggestedFilename,
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
      if (stopRecordBtn) {
        stopRecordBtn.classList.add('hidden');
        stopRecordBtn.disabled = false;
      }
      if (cancelBtn) {
        cancelBtn.classList.add('hidden');
        cancelBtn.disabled = false;
      }
      downloadBtn.disabled = false;
      if (entry.audioExtractBtn) {
        entry.audioExtractBtn.disabled = false;
      }
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
   * @param {{ audioOnly?: boolean, audioFormat?: string }} [options={}]
   */
  async function triggerCompanionDownload(entry, targetUrl, options = {}) {
    const resolvedUrl = targetUrl || state.activeTabUrl;
    if (!resolvedUrl) {
      return;
    }
    if (entry && entry.companionBtn) {
      entry.companionBtn.disabled = true;
    }
    if (entry && entry.audioExtractBtn) {
      entry.audioExtractBtn.disabled = true;
    }
    if (els.companionPageBtn && !entry) {
      els.companionPageBtn.disabled = true;
    }
    setStatusBanner(translateFn('popup_status_companion_started'));
    try {
      const baseFilename = entry && entry.item ? entry.item.suggestedFilename : '';
      const targetFilename = options.audioOnly && baseFilename
        ? `${baseFilename.replace(/\.[^./\\]+$/, '')}_audio`
        : baseFilename;
      const response = await chromeApi.runtime.sendMessage({
        type: MESSAGE_TYPES.DOWNLOAD_WITH_COMPANION,
        payload: {
          url: resolvedUrl,
          referer: state.activeTabUrl || '',
          filename: targetFilename,
          quality: state.settings.defaultQuality,
          audioOnly: Boolean(options.audioOnly),
          audioFormat: typeof options.audioFormat === 'string' ? options.audioFormat : 'mp3'
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
      if (entry && entry.audioExtractBtn) {
        entry.audioExtractBtn.disabled = false;
      }
      if (els.companionPageBtn && !entry) {
        els.companionPageBtn.disabled = false;
      }
    }
  }

  /**
   * Extracts audio only from a video or stream card via browser offscreen track or companion MP3.
   * @param {object} entry
   * @param {string} selectedPlaylistUrl
   * @param {string} selectedAudioUrl
   * @param {boolean} useCompanion
   */
  async function triggerAudioExtraction(entry, selectedPlaylistUrl, selectedAudioUrl, useCompanion) {
    const baseStem = (entry.item.suggestedFilename || DEFAULT_FILENAMES.BASE).replace(/\.[^./\\]+$/, '');
    if (useCompanion) {
      return triggerCompanionDownload(entry, selectedPlaylistUrl || entry.item.url, {
        audioOnly: true,
        audioFormat: DEFAULT_FILENAMES.AUDIO_MP3_EXT
      });
    }
    return triggerDownload(entry, selectedPlaylistUrl, selectedAudioUrl, {
      audioOnly: true,
      filenameOverride: `${baseStem}_audio.${DEFAULT_FILENAMES.AUDIO_M4A_EXT}`
    });
  }

  /**
   * Triggers on-the-fly image or SVG raster conversion and download via the offscreen canvas worker.
   * @param {object} entry
   * @param {string} targetFormat
   */
  async function triggerImageConversion(entry, targetFormat) {
    const baseStem = (entry.item.suggestedFilename || DEFAULT_FILENAMES.BASE).replace(/\.[^./\\]+$/, '');
    return triggerDownload(entry, entry.item.url, '', {
      convertTo: targetFormat,
      filenameOverride: `${baseStem}.${targetFormat}`
    });
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
      refreshAudioExtractButton(entry, cardContext);
    }
  }

  const cardContext = {
    documentRef: doc,
    translateFn,
    hlsMetaByUrl: state.hlsMetaByUrl,
    getSettings: () => state.settings,
    isCompanionAvailable: () => state.companionAvailable,
    onCompanionDownload: (entry, targetUrl) => triggerCompanionDownload(entry, targetUrl),
    onExtractAudio: triggerAudioExtraction,
    onConvertImage: triggerImageConversion,
    onOpenLightbox: (entry) => openLightbox(entry),
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
    onStopRecord: (requestId) => {
      chromeApi.runtime.sendMessage({
        type: MESSAGE_TYPES.STOP_LIVE_RECORD,
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
      const hasQuickImageFilters = (state.filter === 'images' || state.filter === 'svg')
        && (state.minImagePx > 0 || state.imageExtFilter !== '');
      const isFilteredEmpty = state.items.length > 0
        && (state.filter !== 'all' || state.searchQuery.trim() !== '' || hasQuickImageFilters);
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
      state.activeTabTitle = tab.title || '';

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
      let recoveredTabCapture = null;
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
            if (build && build.isTabCapture && build.requestId) {
              recoveredTabCapture = {
                requestId: build.requestId,
                done: build.done || 0,
                bytes: build.bytes || 0
              };
            } else if (build && build.url && build.requestId) {
              state.activeBuildsByUrl.set(build.url, build);
            }
          }
        }
      } catch {
        // Active build sync is best-effort
      }
      if (recoveredTabCapture) {
        state.activeTabCapture = recoveredTabCapture;
        updateTabCaptureUi();
        setStatusBanner(formatTabCaptureStatus(recoveredTabCapture.done, recoveredTabCapture.bytes));
      } else {
        if (state.activeTabCapture && state.hasActiveBuildSnapshot && !state.localPendingRequestIds.has(state.activeTabCapture.requestId)) {
          state.activeTabCapture = null;
          updateTabCaptureUi();
        }
        if (showLoading) {
          setStatusBanner('');
        }
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
   * Bundles selected direct media and images into a single downloadable ZIP archive.
   * @param {Array<object>} selectedItems
   */
  async function executeBatchZip(selectedItems) {
    const zipCandidates = (selectedItems || []).filter((item) => item && !item.isStream && !item.isMse);
    if (state.batchRunning || state.activeZipRequestId || zipCandidates.length === 0) {
      return null;
    }
    const requestId = `zip_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    state.activeZipRequestId = requestId;
    state.localPendingRequestIds.add(requestId);
    const visibleNow = getVisibleItems();
    updateSelectionControls(visibleNow);
    setStatusBanner(translateFn('popup_status_zip_preparing', ['0', String(zipCandidates.length)]));

    const requestedConvert = state.imageConvertFormat;
    const rasterSizePx = Number(state.imageScalePx) || LIMITS.DEFAULT_SVG_RASTER_SIZE_PX;
    const zipItems = zipCandidates.map((item) => {
      const ext = (item.ext || '').toLowerCase();
      const convertTo = (
        item.type === MEDIA_TYPES.IMAGE
        && (requestedConvert === IMAGE_CONVERT_FORMATS.PNG || requestedConvert === IMAGE_CONVERT_FORMATS.JPG)
        && ext !== requestedConvert
        && !(requestedConvert === IMAGE_CONVERT_FORMATS.JPG && ext === 'jpeg')
      )
        ? requestedConvert
        : '';
      return {
        url: item.url,
        filename: item.suggestedFilename || '',
        ext: item.ext || '',
        width: item.width || 0,
        height: item.height || 0,
        convertTo,
        rasterSizePx: convertTo ? rasterSizePx : 0
      };
    });

    try {
      const response = await chromeApi.runtime.sendMessage({
        type: MESSAGE_TYPES.EXPORT_BATCH_ZIP,
        payload: {
          items: zipItems,
          filename: DEFAULT_FILENAMES.BASE,
          referer: state.activeTabUrl || '',
          tabId: typeof state.activeTabId === 'number' ? state.activeTabId : -1,
          allowFolders: isFolderFilenameTemplate(state.settings.filenameTemplate),
          saveAs: Boolean(state.settings.promptSaveAs),
          requestId
        }
      });
      if (!response || !response.ok) {
        throw new Error((response && response.error) || 'DOWNLOAD_FAILED');
      }
      setStatusBanner(translateFn('popup_status_download_started'));
      return response;
    } catch (err) {
      setStatusBanner(localizeError(err && err.message, translateFn), true);
      return null;
    } finally {
      state.localPendingRequestIds.delete(requestId);
      if (state.activeZipRequestId === requestId) {
        state.activeZipRequestId = '';
      }
      updateSelectionControls(getVisibleItems());
    }
  }

  /**
   * Formats live elapsed recording duration and byte readout for tab capture.
   * @param {number} doneSec
   * @param {number} bytes
   * @returns {string}
   */
  function formatTabCaptureStatus(doneSec, bytes) {
    const durationText = formatDuration(doneSec) || '0:00';
    const sizeText = formatBytes(bytes) || '0 KB';
    return translateFn('popup_status_tab_capture_active', [durationText, sizeText]);
  }

  /**
   * Synchronizes the topbar tab capture toggle button state and label.
   */
  function updateTabCaptureUi() {
    const isRecording = Boolean(state.activeTabCapture);
    if (els.tabCaptureBtn) {
      els.tabCaptureBtn.classList.toggle('is-recording', isRecording);
    }
    if (els.tabCaptureLabel) {
      els.tabCaptureLabel.textContent = translateFn(
        isRecording ? 'popup_action_stop_capture' : 'popup_action_capture_tab'
      );
    }
  }

  /**
   * Starts or stops an active browser tab MediaRecorder capture session.
   */
  async function toggleTabCapture() {
    if (state.activeTabCapture) {
      if (els.tabCaptureBtn) {
        els.tabCaptureBtn.disabled = true;
      }
      try {
        const stopResp = await chromeApi.runtime.sendMessage({
          type: MESSAGE_TYPES.STOP_TAB_CAPTURE,
          requestId: state.activeTabCapture.requestId
        });
        if (!stopResp || !stopResp.ok) {
          throw new Error((stopResp && stopResp.error) || 'TAB_CAPTURE_FAILED');
        }
      } catch (err) {
        setStatusBanner(localizeError(err && err.message, translateFn), true);
      } finally {
        if (els.tabCaptureBtn) {
          els.tabCaptureBtn.disabled = false;
        }
      }
      return null;
    }

    if (typeof state.activeTabId !== 'number') {
      setStatusBanner(localizeError('NO_ACTIVE_TAB', translateFn), true);
      return null;
    }

    const requestId = `cap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    state.activeTabCapture = { requestId, done: 0, bytes: 0 };
    state.localPendingRequestIds.add(requestId);
    updateTabCaptureUi();
    setStatusBanner(formatTabCaptureStatus(0, 0));

    try {
      const response = await chromeApi.runtime.sendMessage({
        type: MESSAGE_TYPES.START_TAB_CAPTURE,
        payload: {
          tabId: state.activeTabId,
          tabUrl: state.activeTabUrl,
          title: state.activeTabTitle || '',
          saveAs: Boolean(state.settings.promptSaveAs),
          requestId
        }
      });
      if (!response || !response.ok) {
        throw new Error((response && response.error) || 'TAB_CAPTURE_FAILED');
      }
      setStatusBanner(translateFn('popup_status_download_started'));
      return response;
    } catch (err) {
      if (err && err.message === 'DOWNLOAD_CANCELLED') {
        setStatusBanner(translateFn('popup_status_download_cancelled'));
      } else {
        setStatusBanner(localizeError(err && err.message, translateFn), true);
      }
      return null;
    } finally {
      state.localPendingRequestIds.delete(requestId);
      if (state.activeTabCapture && state.activeTabCapture.requestId === requestId) {
        state.activeTabCapture = null;
        updateTabCaptureUi();
      }
    }
  }

  /**
   * Applies the active backdrop theme (checker, light, or dark) onto the lightbox preview stage.
   * @param {'checker' | 'light' | 'dark'} mode
   */
  function applyLightboxBg(mode) {
    const resolved = mode === LIGHTBOX_BG_MODES.LIGHT || mode === LIGHTBOX_BG_MODES.DARK
      ? mode
      : LIGHTBOX_BG_MODES.CHECKER;
    state.lightboxBg = resolved;
    if (els.lightboxStage) {
      els.lightboxStage.classList.toggle('is-bg-checker', resolved === LIGHTBOX_BG_MODES.CHECKER);
      els.lightboxStage.classList.toggle('is-bg-light', resolved === LIGHTBOX_BG_MODES.LIGHT);
      els.lightboxStage.classList.toggle('is-bg-dark', resolved === LIGHTBOX_BG_MODES.DARK);
    }
    if (els.lightboxBgCheckerBtn) {
      els.lightboxBgCheckerBtn.classList.toggle('is-active', resolved === LIGHTBOX_BG_MODES.CHECKER);
    }
    if (els.lightboxBgLightBtn) {
      els.lightboxBgLightBtn.classList.toggle('is-active', resolved === LIGHTBOX_BG_MODES.LIGHT);
    }
    if (els.lightboxBgDarkBtn) {
      els.lightboxBgDarkBtn.classList.toggle('is-active', resolved === LIGHTBOX_BG_MODES.DARK);
    }
  }

  /**
   * Copies SVG markup or media URL for the currently open lightbox entry.
   */
  async function copyLightboxContent() {
    if (!state.lightboxEntry || !state.lightboxEntry.item) {
      return;
    }
    const { item } = state.lightboxEntry;
    const isSvgItem = Boolean(
      item.svgMarkup
      || (item.ext || '').toLowerCase() === DEFAULT_FILENAMES.SVG_EXT
      || isSvgDataUrl(item.url)
    );
    let payloadText = item.url || '';
    if (isSvgItem) {
      if (item.svgMarkup) {
        payloadText = item.svgMarkup;
      } else if (isSvgDataUrl(item.url)) {
        const commaIdx = item.url.indexOf(',');
        if (commaIdx >= 0) {
          const header = item.url.slice(0, commaIdx).toLowerCase();
          const body = item.url.slice(commaIdx + 1);
          payloadText = header.includes(';base64') ? atob(body) : decodeURIComponent(body);
        }
      } else {
        try {
          const resp = await fetch(item.url);
          if (resp.ok) {
            payloadText = await resp.text();
          }
        } catch {
          payloadText = item.url || '';
        }
      }
    }
    const writeFn = deps.writeClipboardFn
      || (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function'
        ? (text) => navigator.clipboard.writeText(text)
        : null);
    if (writeFn && payloadText) {
      try {
        await writeFn(payloadText);
        setStatusBanner(translateFn('popup_action_copied'));
      } catch (err) {
        setStatusBanner(localizeError(err && err.message, translateFn), true);
      }
    }
  }

  /**
   * Opens the modal lightbox viewer for inspecting an image or SVG thumbnail in full size.
   * @param {object} entry
   */
  function openLightbox(entry) {
    if (!entry || !entry.item || !els.imageLightbox || !els.lightboxImg) {
      return;
    }
    const { item } = entry;
    state.lightboxEntry = entry;
    els.lightboxImg.src = item.url || '';
    els.lightboxImg.alt = item.suggestedFilename || '';
    if (els.lightboxTitle) {
      els.lightboxTitle.textContent = item.suggestedFilename || item.url || '';
    }
    if (els.lightboxMeta) {
      const parts = [];
      if (item.width && item.height) {
        parts.push(translateFn('popup_lightbox_dimensions', [String(item.width), String(item.height)]));
      }
      if (item.ext) {
        parts.push(String(item.ext).toUpperCase());
      }
      els.lightboxMeta.textContent = parts.join(' - ');
      els.lightboxMeta.classList.toggle('hidden', parts.length === 0);
    }
    if (els.lightboxCopyBtn) {
      const isSvgItem = Boolean(
        item.svgMarkup
        || (item.ext || '').toLowerCase() === DEFAULT_FILENAMES.SVG_EXT
        || isSvgDataUrl(item.url)
      );
      els.lightboxCopyBtn.textContent = translateFn(
        isSvgItem ? 'popup_lightbox_copy_svg' : 'popup_lightbox_copy_url'
      );
    }
    applyLightboxBg(state.lightboxBg);
    els.imageLightbox.classList.remove('hidden');
    if (els.lightboxCloseBtn && typeof els.lightboxCloseBtn.focus === 'function') {
      els.lightboxCloseBtn.focus();
    }
  }

  /**
   * Closes the modal image lightbox and resets its image source.
   */
  function closeLightbox() {
    if (!els.imageLightbox) {
      return;
    }
    state.lightboxEntry = null;
    els.imageLightbox.classList.add('hidden');
    if (els.lightboxImg) {
      els.lightboxImg.src = '';
    }
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
      if (message.requestId && message.requestId === state.activeZipRequestId) {
        setStatusBanner(translateFn('popup_status_zip_preparing', [
          String(message.done || 0),
          String(message.total || 0)
        ]));
        return;
      }
      if (
        message.isTabCapture
        || (state.activeTabCapture && message.requestId === state.activeTabCapture.requestId)
      ) {
        state.activeTabCapture = {
          requestId: message.requestId || (state.activeTabCapture && state.activeTabCapture.requestId) || '',
          done: message.done || 0,
          bytes: Number.isFinite(message.bytes) ? message.bytes : 0
        };
        updateTabCaptureUi();
        setStatusBanner(formatTabCaptureStatus(state.activeTabCapture.done, state.activeTabCapture.bytes));
        return;
      }
      const progressOpts = {
        isLiveRecord: Boolean(message.isLiveRecord),
        bytes: Number.isFinite(message.bytes) ? message.bytes : 0
      };
      if (message.url && message.requestId) {
        state.activeBuildsByUrl.set(message.url, {
          requestId: message.requestId,
          url: message.url,
          done: message.done || 0,
          total: message.total || 0,
          isLiveRecord: progressOpts.isLiveRecord,
          bytes: progressOpts.bytes
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
          total: message.total,
          isLiveRecord: progressOpts.isLiveRecord,
          bytes: progressOpts.bytes
        });
        return;
      }
      entry.progressEl.className = 'progress-line';
      entry.progressEl.textContent = formatProgressText(message.done || 0, message.total || 0, progressOpts);
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
      if (state.activeTabCapture && message.requestId === state.activeTabCapture.requestId) {
        state.activeTabCapture = null;
        updateTabCaptureUi();
        if (message.ok) {
          setStatusBanner(translateFn('popup_status_download_started'));
        } else if (message.error === 'DOWNLOAD_CANCELLED') {
          setStatusBanner(translateFn('popup_status_download_cancelled'));
        } else {
          setStatusBanner(localizeError(message.error, translateFn), true);
        }
        return;
      }
      const entry = findCardEntryForBuild(message.requestId, message.url);
      if (!entry) {
        return;
      }
      if (entry.activeRequestId === message.requestId) {
        entry.activeRequestId = '';
      }
      if (entry.stopRecordBtn) {
        entry.stopRecordBtn.classList.add('hidden');
        entry.stopRecordBtn.disabled = false;
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
      if (els.imageLightbox && !els.imageLightbox.classList.contains('hidden')) {
        closeLightbox();
        return;
      }
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
        applyImageFiltersUi();
        persistPopupUiState();
        renderList();
      });
    }

    if (els.minImagePxSelect) {
      els.minImagePxSelect.addEventListener('change', () => {
        const parsed = Number(els.minImagePxSelect.value);
        state.minImagePx = VALID_MIN_IMAGE_PX.has(parsed) ? parsed : 0;
        hideBatchConfirm();
        persistPopupUiState();
        renderList();
      });
    }

    if (els.imageExtFilterSelect) {
      els.imageExtFilterSelect.addEventListener('change', () => {
        const val = (els.imageExtFilterSelect.value || '').toLowerCase();
        state.imageExtFilter = VALID_IMAGE_EXTS.has(val) ? val : '';
        hideBatchConfirm();
        persistPopupUiState();
        renderList();
      });
    }

    if (els.imageScaleSelect) {
      els.imageScaleSelect.addEventListener('change', () => {
        const parsed = Number(els.imageScaleSelect.value);
        state.imageScalePx = VALID_SVG_SCALES.has(parsed)
          ? parsed
          : LIMITS.DEFAULT_SVG_RASTER_SIZE_PX;
        persistPopupUiState();
      });
    }

    if (els.lightboxCloseBtn) {
      els.lightboxCloseBtn.addEventListener('click', closeLightbox);
    }
    if (els.lightboxBackdrop) {
      els.lightboxBackdrop.addEventListener('click', closeLightbox);
    }
    if (els.lightboxBgCheckerBtn) {
      els.lightboxBgCheckerBtn.addEventListener('click', () => applyLightboxBg(LIGHTBOX_BG_MODES.CHECKER));
    }
    if (els.lightboxBgLightBtn) {
      els.lightboxBgLightBtn.addEventListener('click', () => applyLightboxBg(LIGHTBOX_BG_MODES.LIGHT));
    }
    if (els.lightboxBgDarkBtn) {
      els.lightboxBgDarkBtn.addEventListener('click', () => applyLightboxBg(LIGHTBOX_BG_MODES.DARK));
    }
    if (els.lightboxCopyBtn) {
      els.lightboxCopyBtn.addEventListener('click', copyLightboxContent);
    }
    if (els.lightboxDownloadBtn) {
      els.lightboxDownloadBtn.addEventListener('click', () => {
        if (state.lightboxEntry) {
          triggerDownload(state.lightboxEntry, state.lightboxEntry.item.url, '');
        }
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

    if (els.viewModeBtn) {
      els.viewModeBtn.addEventListener('click', () => {
        state.viewMode = state.viewMode === POPUP_VIEW_MODES.GRID
          ? POPUP_VIEW_MODES.LIST
          : POPUP_VIEW_MODES.GRID;
        applyViewModeUi();
        persistPopupUiState();
      });
    }

    if (els.imageConvertSelect) {
      els.imageConvertSelect.addEventListener('change', () => {
        const val = els.imageConvertSelect.value;
        state.imageConvertFormat = (
          val === IMAGE_CONVERT_FORMATS.PNG || val === IMAGE_CONVERT_FORMATS.JPG
        )
          ? val
          : IMAGE_CONVERT_FORMATS.ORIGINAL;
      });
    }

    els.refreshBtn.addEventListener('click', () => loadActiveTabMedia({ showLoading: true }));
    els.reloadTabBtn.addEventListener('click', reloadActiveTabAndCapture);
    if (els.tabCaptureBtn) {
      els.tabCaptureBtn.addEventListener('click', toggleTabCapture);
    }

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

    if (els.clearSelectionBtn) {
      els.clearSelectionBtn.addEventListener('click', () => {
        state.selectedUrls.clear();
        for (const entry of state.cardsByUrl.values()) {
          if (entry.selectCheckbox) {
            entry.selectCheckbox.checked = false;
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

    if (els.downloadZipBtn) {
      els.downloadZipBtn.addEventListener('click', () => {
        const selectedItems = sortMediaItems(
          state.items.filter((item) => isItemSelectable(item) && state.selectedUrls.has(item.url)),
          state.sortBy,
          state.hlsMetaByUrl
        );
        if (selectedItems.length === 0) {
          return;
        }
        return executeBatchZip(selectedItems);
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
    populateImageFilterOptions();
    await restorePopupUiState();
    applyViewModeUi();
    applyImageFiltersUi();
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
    executeBatchZip,
    toggleTabCapture,
    openLightbox,
    closeLightbox,
    applyLightboxBg,
    flushHydrationQueue,
    handleRuntimeMessage,
    handleGlobalKeyDown,
    revokeAllPreviewBlobs
  };
}

if (typeof document !== 'undefined' && document.getElementById('mediaList')) {
  createPopupController().init();
}
