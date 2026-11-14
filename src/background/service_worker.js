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
  AUDIO_EXTENSIONS,
  BADGE_CONFIG,
  DEFAULT_FILENAMES,
  IMAGE_EXTENSIONS,
  LIMITS,
  MEDIA_SOURCES,
  MEDIA_TYPES,
  MESSAGE_TYPES,
  OFFSCREEN_DOCUMENT_PATH,
  STORAGE_KEYS,
  VIDEO_EXTENSIONS
} from '../config/constants.js';
import { parseDashManifest } from '../shared/dash_parser.js';
import { estimateHlsBytes, parseHlsPlaylist } from '../shared/hls_parser.js';
import {
  classifyMedia,
  deduplicateMedia,
  deriveFilenameStem,
  extractUrlExtension,
  isHttpUrl,
  sanitizeFilename
} from '../shared/media_classifier.js';
import { attachVideoPreviews, extractMediaId } from '../shared/preview_matcher.js';
import { applyFilenameTemplate, loadSettings } from '../shared/settings.js';

const tabWriteQueues = new Map();
const activeBuilds = new Map();
let offscreenLifecycleQueue = Promise.resolve();
let activeOffscreenBuilds = 0;

/**
 * Serializes async storage updates per tabId to prevent concurrent race conditions.
 * Never call enqueueTabWrite recursively from inside its own task callback.
 * @param {number} tabId
 * @param {() => Promise<void>} task
 * @returns {Promise<void>}
 */
function enqueueTabWrite(tabId, task) {
  const prev = tabWriteQueues.get(tabId) || Promise.resolve();
  const next = prev.then(task, task).finally(() => {
    if (tabWriteQueues.get(tabId) === next) {
      tabWriteQueues.delete(tabId);
    }
  });
  tabWriteQueues.set(tabId, next);
  return next;
}

/**
 * Serializes offscreen document creation and teardown to avoid lifecycle races.
 * @param {() => Promise<void>} task
 * @returns {Promise<void>}
 */
function enqueueOffscreenOp(task) {
  const next = offscreenLifecycleQueue.then(task, task);
  offscreenLifecycleQueue = next.catch(() => {});
  return next;
}

/**
 * Builds the session storage key for a given tab ID.
 * @param {number} tabId
 * @returns {string}
 */
function tabStorageKey(tabId) {
  return `${STORAGE_KEYS.TAB_MEDIA_PREFIX}${tabId}`;
}

/**
 * Builds the session storage key for a tab's last SPA route key.
 * @param {number} tabId
 * @returns {string}
 */
function tabRouteStorageKey(tabId) {
  return `${STORAGE_KEYS.TAB_ROUTE_PREFIX}${tabId}`;
}

/**
 * Builds the session storage key mapping a download ID to its offscreen Blob URL.
 * @param {number} downloadId
 * @returns {string}
 */
function downloadBlobKey(downloadId) {
  return `${STORAGE_KEYS.DOWNLOAD_BLOB_PREFIX}${downloadId}`;
}

/**
 * Reads captured network media items for a tab from session storage.
 * @param {number} tabId
 * @returns {Promise<Array<object>>}
 */
async function getTabNetworkMedia(tabId) {
  const key = tabStorageKey(tabId);
  const stored = await chrome.storage.session.get(key);
  return Array.isArray(stored[key]) ? stored[key] : [];
}

/**
 * Extracts a case-insensitive HTTP header value from webRequest responseHeaders.
 * @param {Array<{ name: string, value?: string }>} headers
 * @param {string} headerName
 * @returns {string}
 */
function getHeader(headers, headerName) {
  if (!Array.isArray(headers)) {
    return '';
  }
  const target = headerName.toLowerCase();
  const found = headers.find((h) => h.name && h.name.toLowerCase() === target);
  return found && found.value ? found.value : '';
}

/**
 * Updates the toolbar badge with the number of detected video/stream items for a tab.
 * @param {number} tabId
 * @param {Array<object>} items
 */
async function updateTabBadge(tabId, items) {
  const videoCount = items.filter(
    (item) => item.type === MEDIA_TYPES.VIDEO || item.type === MEDIA_TYPES.STREAM
  ).length;
  try {
    await chrome.action.setBadgeBackgroundColor({
      color: BADGE_CONFIG.BACKGROUND_COLOR,
      tabId
    });
    await chrome.action.setBadgeText({
      text: videoCount > 0 ? String(videoCount) : '',
      tabId
    });
  } catch {
    // Tab may have been closed before badge update completed
  }
}

/**
 * Clears captured media and badge without re-entering enqueueTabWrite.
 * @param {number} tabId
 * @returns {Promise<void>}
 */
async function clearTabMediaUnlocked(tabId) {
  await chrome.storage.session.remove(tabStorageKey(tabId));
  await updateTabBadge(tabId, []);
}

/**
 * Clears all captured network media and resets the badge for a tab.
 * @param {number} tabId
 * @returns {Promise<void>}
 */
function clearTabMedia(tabId) {
  return enqueueTabWrite(tabId, () => clearTabMediaUnlocked(tabId));
}

/**
 * Extracts origin + pathname so query/hash changes do not purge active captures.
 * @param {string} rawUrl
 * @returns {string}
 */
function toRouteKey(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return rawUrl || '';
  }
}

/**
 * Records a captured network media item into session storage for its tab.
 * @param {number} tabId
 * @param {object} entry
 */
function recordNetworkMedia(tabId, entry) {
  enqueueTabWrite(tabId, async () => {
    const existing = await getTabNetworkMedia(tabId);
    const filtered = existing.filter((item) => item.url !== entry.url);
    filtered.unshift(entry);
    const capped = filtered.slice(0, LIMITS.MAX_CAPTURED_PER_TAB);
    await chrome.storage.session.set({ [tabStorageKey(tabId)]: capped });
    await updateTabBadge(tabId, capped);
    chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.MEDIA_UPDATED,
      tabId
    }).catch(() => {
      // Popup is not open
    });
  }).catch(() => {
    // Session storage write failed or tab was closed
  });
}

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    const isSuccessOrCached = (details.statusCode >= 200 && details.statusCode < 300)
      || details.statusCode === 304;
    if (details.tabId < 0 || !isSuccessOrCached) {
      return;
    }

    const contentType = getHeader(details.responseHeaders, 'content-type');
    const classified = classifyMedia(details.url, contentType);
    if (!classified) {
      return;
    }

    const contentLengthRaw = getHeader(details.responseHeaders, 'content-length');
    const sizeBytes = Number.parseInt(contentLengthRaw, 10) || 0;
    if (
      classified.type === MEDIA_TYPES.VIDEO &&
      sizeBytes > 0 &&
      sizeBytes < LIMITS.MIN_VIDEO_BYTES
    ) {
      return;
    }
    if (
      classified.type === MEDIA_TYPES.IMAGE &&
      sizeBytes > 0 &&
      sizeBytes < LIMITS.MIN_IMAGE_BYTES
    ) {
      return;
    }

    recordNetworkMedia(details.tabId, {
      url: details.url,
      type: classified.type,
      ext: classified.ext,
      isStream: classified.isStream,
      source: MEDIA_SOURCES.NETWORK,
      mimeType: contentType.split(';')[0].trim(),
      sizeBytes,
      width: 0,
      height: 0,
      capturedAt: Date.now()
    });
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId >= 0 && details.type === 'main_frame') {
      const route = toRouteKey(details.url);
      enqueueTabWrite(details.tabId, async () => {
        await chrome.storage.session.set({ [tabRouteStorageKey(details.tabId)]: route });
        await clearTabMediaUnlocked(details.tabId);
      }).catch(() => {});
    }
  },
  { urls: ['<all_urls>'], types: ['main_frame'] }
);

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) {
    return;
  }
  const nextRoute = toRouteKey(changeInfo.url);
  const routeKey = tabRouteStorageKey(tabId);
  enqueueTabWrite(tabId, async () => {
    const stored = await chrome.storage.session.get(routeKey);
    const prevRoute = typeof stored[routeKey] === 'string' ? stored[routeKey] : '';
    await chrome.storage.session.set({ [routeKey]: nextRoute });
    if (prevRoute && prevRoute !== nextRoute) {
      await clearTabMediaUnlocked(tabId);
    }
  }).catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  enqueueTabWrite(tabId, async () => {
    await chrome.storage.session.remove([tabStorageKey(tabId), tabRouteStorageKey(tabId)]);
  }).catch(() => {});
});

/**
 * Ensures the offscreen document exists for HLS Blob creation.
 * Must run inside enqueueOffscreenOp.
 * @returns {Promise<void>}
 */
async function ensureOffscreenDocument() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH)]
  });
  if (existingContexts.length > 0) {
    return;
  }

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT_PATH,
    reasons: ['BLOBS'],
    justification: 'Assemble non-DRM HLS segments into a downloadable Blob URL.'
  });
}

/**
 * Closes the offscreen document when no builds or active Blob downloads remain.
 * Must run inside enqueueOffscreenOp.
 * @returns {Promise<void>}
 */
async function maybeCloseOffscreenDocument() {
  if (activeOffscreenBuilds > 0) {
    return;
  }
  const allSession = await chrome.storage.session.get(null);
  const hasPendingBlobs = Object.keys(allSession).some((key) =>
    key.startsWith(STORAGE_KEYS.DOWNLOAD_BLOB_PREFIX)
  );
  if (hasPendingBlobs) {
    return;
  }

  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH)]
  });
  if (existingContexts.length > 0) {
    await chrome.offscreen.closeDocument();
  }
}

/**
 * Revokes a Blob URL inside the offscreen document and closes it if idle.
 * @param {string} blobUrl
 * @returns {Promise<void>}
 */
async function revokeOffscreenBlob(blobUrl) {
  if (!blobUrl) {
    return;
  }
  await chrome.runtime.sendMessage({
    target: 'offscreen',
    type: MESSAGE_TYPES.OFFSCREEN_REVOKE_BLOB,
    blobUrl
  }).catch(() => {
    // Offscreen document may already be closed
  });
  await enqueueOffscreenOp(() => maybeCloseOffscreenDocument()).catch(() => {});
}

/**
 * Removes persisted download Blob mapping and revokes its offscreen Blob URL.
 * @param {number} downloadId
 * @param {string} [knownBlobUrl='']
 * @returns {Promise<void>}
 */
async function cleanupDownloadBlob(downloadId, knownBlobUrl = '') {
  const key = downloadBlobKey(downloadId);
  let blobUrl = knownBlobUrl;
  if (!blobUrl) {
    const stored = await chrome.storage.session.get(key);
    blobUrl = typeof stored[key] === 'string' ? stored[key] : '';
  }
  await chrome.storage.session.remove(key);
  if (blobUrl) {
    await revokeOffscreenBlob(blobUrl);
  }
}

chrome.downloads.onChanged.addListener((delta) => {
  const state = delta.state && delta.state.current;
  if (state !== 'complete' && state !== 'interrupted') {
    return;
  }
  cleanupDownloadBlob(delta.id).catch(() => {});
});

/**
 * Scans the active tab DOM and combines results with captured network media.
 * @param {number} tabId
 * @param {string} tabUrl
 * @returns {Promise<object>}
 */
async function collectMediaForTab(tabId, tabUrl) {
  if (typeof tabId !== 'number' || tabId < 0) {
    throw new Error('NO_ACTIVE_TAB');
  }
  if (!isHttpUrl(tabUrl)) {
    throw new Error('RESTRICTED_PAGE');
  }

  const settings = await loadSettings();
  const networkItems = await getTabNetworkMedia(tabId);
  let domResult = {
    pageTitle: '',
    pageUrl: tabUrl,
    hasBlobVideo: false,
    videoElements: [],
    items: []
  };

  try {
    const scanConfig = {
      minImageDimensionPx: settings.minImageDimensionPx,
      previewMaxWidthPx: LIMITS.PREVIEW_MAX_WIDTH_PX,
      previewFrameQuality: LIMITS.PREVIEW_FRAME_QUALITY,
      mediaTypes: {
        VIDEO: MEDIA_TYPES.VIDEO,
        IMAGE: MEDIA_TYPES.IMAGE,
        AUDIO: MEDIA_TYPES.AUDIO
      },
      sourceTag: MEDIA_SOURCES.DOM,
      directExtensions: [...VIDEO_EXTENSIONS, ...IMAGE_EXTENSIONS, ...AUDIO_EXTENSIONS]
    };

    const runScan = (cfg) => (
      typeof window.__mediaHarvestScan === 'function' ? window.__mediaHarvestScan(cfg) : null
    );

    let execResults = await chrome.scripting.executeScript({
      target: { tabId },
      func: runScan,
      args: [scanConfig]
    });

    if (!execResults || !execResults[0] || !execResults[0].result) {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['src/content/dom_scanner.js']
      });
      execResults = await chrome.scripting.executeScript({
        target: { tabId },
        func: runScan,
        args: [scanConfig]
      });
    }

    if (execResults && execResults[0] && execResults[0].result) {
      domResult = execResults[0].result;
    }
  } catch {
    // Some pages restrict scripting even on http/https; keep network items
  }

  const normalizedDomItems = domResult.items
    .map((item) => {
      const classified = classifyMedia(item.url);
      return {
        ...item,
        type: classified ? classified.type : item.type,
        ext: classified ? classified.ext : '',
        isStream: classified ? classified.isStream : false
      };
    });

  const merged = attachVideoPreviews(
    deduplicateMedia([...networkItems, ...normalizedDomItems]),
    domResult.videoElements || []
  ).map((item) => {
    const baseStem = deriveFilenameStem(item.url, item.title || domResult.pageTitle, tabUrl);
    const templatedStem = applyFilenameTemplate(settings.filenameTemplate, {
      stem: baseStem,
      pageUrl: tabUrl
    });
    return {
      ...item,
      suggestedFilename: sanitizeFilename(templatedStem, item.ext)
    };
  });

  await updateTabBadge(tabId, merged);

  return {
    pageTitle: domResult.pageTitle,
    hasBlobVideo: domResult.hasBlobVideo,
    items: merged
  };
}

/**
 * Fetches an HLS playlist text with an explicit timeout.
 * @param {string} url
 * @returns {Promise<string>}
 */
async function fetchPlaylistText(url) {
  const controller = new AbortController();
  const timerId = setTimeout(() => controller.abort(), LIMITS.FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timerId);
  }
}

/**
 * Fetches and parses an HLS or DASH manifest so the UI can list variants, duration, and size.
 * @param {string} url
 * @returns {Promise<object>}
 */
async function inspectHlsStream(url) {
  if (!isHttpUrl(url)) {
    throw new Error('INVALID_URL');
  }
  const text = await fetchPlaylistText(url);
  const looksDash = extractUrlExtension(url) === 'mpd' ||
    /<MPD[\s>]/i.test(text.slice(0, 512));

  if (looksDash) {
    const parsed = parseDashManifest(text, url);
    const durationSec = parsed.totalDurationSec;
    const variantsWithEstimate = parsed.variants.map((variant) => ({
      ...variant,
      durationSec,
      estimatedBytes: estimateHlsBytes(variant.bandwidth, durationSec)
    }));
    return {
      ...parsed,
      streamFormat: 'dash',
      totalDurationSec: durationSec,
      variants: variantsWithEstimate
    };
  }

  const parsed = parseHlsPlaylist(text, url);

  let durationSec = parsed.totalDurationSec;
  if (parsed.isMaster && parsed.variants.length > 0 && !parsed.encrypted) {
    try {
      const sampleText = await fetchPlaylistText(parsed.variants[0].url);
      const sampleParsed = parseHlsPlaylist(sampleText, parsed.variants[0].url);
      durationSec = sampleParsed.totalDurationSec;
    } catch {
      // Duration estimation is best-effort
    }
  }

  const variantsWithEstimate = parsed.variants.map((variant) => ({
    ...variant,
    durationSec,
    estimatedBytes: estimateHlsBytes(variant.bandwidth, durationSec)
  }));

  return {
    ...parsed,
    streamFormat: 'hls',
    totalDurationSec: durationSec,
    variants: variantsWithEstimate
  };
}

/**
 * Resolves and downloads the video matching an inline X post click.
 * @param {number} tabId
 * @param {{ mediaId?: string, directSrc?: string, authorHandle?: string, tweetId?: string }} payload
 * @returns {Promise<{ downloadId: number }>}
 */
async function handleTweetVideoDownload(tabId, payload, pageUrl = '') {
  const settings = await loadSettings();
  const networkItems = await getTabNetworkMedia(tabId);
  const videoCandidates = networkItems.filter(
    (item) => item.type === MEDIA_TYPES.STREAM || item.type === MEDIA_TYPES.VIDEO
  );

  let chosen = null;
  if (payload.mediaId) {
    chosen = videoCandidates.find((item) => extractMediaId(item.url) === payload.mediaId) || null;
  }
  if (!chosen && payload.directSrc && isHttpUrl(payload.directSrc)) {
    chosen = {
      url: payload.directSrc,
      isStream: false,
      ext: DEFAULT_FILENAMES.HLS_FMP4_EXT
    };
  }
  if (!chosen && videoCandidates.length === 1) {
    chosen = videoCandidates[0];
  }
  if (!chosen) {
    throw new Error('PLAY_FIRST');
  }

  const baseStem = payload.authorHandle && payload.tweetId
    ? `${payload.authorHandle}_${payload.tweetId}`
    : deriveFilenameStem(chosen.url, '', pageUrl);
  const templatedStem = applyFilenameTemplate(settings.filenameTemplate, {
    stem: baseStem,
    pageUrl: pageUrl || chosen.url
  });
  const filename = sanitizeFilename(templatedStem, chosen.ext || DEFAULT_FILENAMES.HLS_FMP4_EXT);

  return handleDownloadMedia({
    url: chosen.url,
    playlistUrl: chosen.url,
    isStream: Boolean(chosen.isStream),
    filename,
    saveAs: false
  });
}

/**
 * Cancels an active offscreen stream build and its Chrome download if already started.
 * @param {string} [requestId]
 * @returns {Promise<void>}
 */
async function cancelDownloadBuild(requestId) {
  if (requestId) {
    const buildState = activeBuilds.get(requestId);
    if (buildState) {
      buildState.cancelled = true;
      if (buildState.downloadId !== null) {
        await chrome.downloads.cancel(buildState.downloadId).catch(() => {});
      }
    }
  } else {
    for (const buildState of activeBuilds.values()) {
      buildState.cancelled = true;
      if (buildState.downloadId !== null) {
        await chrome.downloads.cancel(buildState.downloadId).catch(() => {});
      }
    }
  }

  await chrome.runtime.sendMessage({
    target: 'offscreen',
    type: MESSAGE_TYPES.OFFSCREEN_CANCEL_BUILD,
    requestId
  }).catch(() => {
    // Offscreen document may not exist or already be closing
  });
}

/**
 * Starts a download either directly or via HLS/DASH offscreen assembly.
 * @param {{ url: string, playlistUrl?: string, isStream?: boolean, filename?: string, saveAs?: boolean, requestId?: string }} payload
 * @returns {Promise<{ downloadId: number, requestId: string }>}
 */
async function handleDownloadMedia(payload) {
  if (!payload || typeof payload !== 'object' || !isHttpUrl(payload.url)) {
    throw new Error('INVALID_URL');
  }

  const rawStem = typeof payload.filename === 'string' && payload.filename
    ? payload.filename.replace(/\.[^.]+$/, '')
    : deriveFilenameStem(payload.url, '');
  const requestId = typeof payload.requestId === 'string' && payload.requestId
    ? payload.requestId
    : `dl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  if (!payload.isStream) {
    const classified = classifyMedia(payload.url);
    const fallbackExt = classified ? classified.ext : DEFAULT_FILENAMES.FALLBACK_EXT;
    const rawName = typeof payload.filename === 'string' ? payload.filename : '';
    const dotIdx = rawName.lastIndexOf('.');
    const providedExt = dotIdx > 0 && dotIdx < rawName.length - 1 ? rawName.slice(dotIdx + 1) : '';
    const directFilename = sanitizeFilename(rawStem, providedExt || fallbackExt);
    const downloadId = await chrome.downloads.download({
      url: payload.url,
      filename: directFilename,
      saveAs: Boolean(payload.saveAs)
    });
    return { downloadId, requestId };
  }

  const targetPlaylist = payload.playlistUrl || payload.url;
  if (!isHttpUrl(targetPlaylist)) {
    throw new Error('INVALID_URL');
  }

  const buildState = { cancelled: false, downloadId: null };
  activeBuilds.set(requestId, buildState);
  activeOffscreenBuilds += 1;
  let blobUrl = '';
  try {
    const settings = await loadSettings();
    if (buildState.cancelled) {
      throw new Error('DOWNLOAD_CANCELLED');
    }

    await enqueueOffscreenOp(() => ensureOffscreenDocument());
    if (buildState.cancelled) {
      throw new Error('DOWNLOAD_CANCELLED');
    }

    const result = await chrome.runtime.sendMessage({
      target: 'offscreen',
      type: MESSAGE_TYPES.OFFSCREEN_BUILD_HLS_BLOB,
      requestId,
      playlistUrl: targetPlaylist,
      originalUrl: payload.url,
      concurrency: settings.hlsFetchConcurrency,
      qualityPreference: settings.defaultQuality
    });

    if (buildState.cancelled) {
      if (result && result.blobUrl) {
        await revokeOffscreenBlob(result.blobUrl);
      }
      throw new Error('DOWNLOAD_CANCELLED');
    }

    if (!result || !result.ok || !result.blobUrl) {
      throw new Error((result && result.error) || 'HLS_ERROR');
    }

    blobUrl = result.blobUrl;
    const finalFilename = sanitizeFilename(rawStem, result.outputExtension);
    const downloadId = await chrome.downloads.download({
      url: blobUrl,
      filename: finalFilename,
      saveAs: Boolean(payload.saveAs)
    });
    buildState.downloadId = downloadId;

    if (buildState.cancelled) {
      await chrome.downloads.cancel(downloadId).catch(() => {});
      await cleanupDownloadBlob(downloadId, blobUrl);
      blobUrl = '';
      throw new Error('DOWNLOAD_CANCELLED');
    }

    await chrome.storage.session.set({ [downloadBlobKey(downloadId)]: blobUrl });
    const [dlItem] = await chrome.downloads.search({ id: downloadId });
    if (dlItem && dlItem.state !== 'in_progress') {
      await cleanupDownloadBlob(downloadId, blobUrl);
    }
    return { downloadId, requestId };
  } catch (err) {
    if (blobUrl) {
      await revokeOffscreenBlob(blobUrl);
    }
    throw err;
  } finally {
    activeBuilds.delete(requestId);
    activeOffscreenBuilds -= 1;
    enqueueOffscreenOp(() => maybeCloseOffscreenDocument()).catch(() => {});
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target === 'offscreen') {
    return false;
  }

  if (message.type === MESSAGE_TYPES.GET_MEDIA_FOR_TAB) {
    collectMediaForTab(message.tabId, message.tabUrl)
      .then((data) => sendResponse({ ok: true, ...data }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === MESSAGE_TYPES.CLEAR_MEDIA_FOR_TAB) {
    if (typeof message.tabId !== 'number' || message.tabId < 0) {
      sendResponse({ ok: false, error: 'NO_ACTIVE_TAB' });
      return false;
    }
    clearTabMedia(message.tabId)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === MESSAGE_TYPES.INSPECT_HLS) {
    inspectHlsStream(message.url)
      .then((parsed) => sendResponse({ ok: true, ...parsed }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === MESSAGE_TYPES.DOWNLOAD_MEDIA) {
    handleDownloadMedia(message.payload)
      .then((res) => sendResponse({ ok: true, ...res }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === MESSAGE_TYPES.CANCEL_DOWNLOAD) {
    cancelDownloadBuild(message.requestId)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === MESSAGE_TYPES.DOWNLOAD_TWEET_VIDEO) {
    const tabId = sender && sender.tab ? sender.tab.id : -1;
    if (tabId < 0) {
      sendResponse({ ok: false, error: 'NO_ACTIVE_TAB' });
      return false;
    }
    const pageUrl = sender && sender.tab && sender.tab.url ? sender.tab.url : '';
    handleTweetVideoDownload(tabId, message.payload || {}, pageUrl)
      .then((res) => sendResponse({ ok: true, ...res }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  return false;
});
