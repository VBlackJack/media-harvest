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
  AUDIO_EXPORT_FORMATS,
  AUDIO_EXTENSIONS,
  BADGE_CONFIG,
  DEFAULT_FILENAMES,
  IMAGE_CONVERT_FORMATS,
  IMAGE_EXTENSIONS,
  LIMITS,
  MEDIA_SOURCES,
  MEDIA_TYPES,
  MESSAGE_TYPES,
  MSE_CONSTANTS,
  NATIVE_HOST,
  OFFSCREEN_DOCUMENT_PATH,
  STORAGE_KEYS,
  STREAM_SAVER_PATH,
  SUBTITLE_EXTENSIONS,
  VIDEO_EXTENSIONS,
  ZIP_RENAME_MODES
} from '../config/constants.js';
import { parseDashManifest } from '../shared/dash_parser.js';
import {
  fetchWithManagedTimeout,
  isDashDescriptor,
  looksLikeDashXml
} from '../shared/fetch_utils.js';
import { estimateHlsBytes, parseHlsPlaylist } from '../shared/hls_parser.js';
import {
  classifyMedia,
  classifyMseMime,
  deduplicateMedia,
  deriveFilenameStem,
  isDownloadableMediaUrl,
  isHttpUrl,
  isMseUrl,
  sanitizeFilename
} from '../shared/media_classifier.js';
import { attachVideoPreviews, extractMediaId } from '../shared/preview_matcher.js';
import {
  findCompanionAudioUrl,
  findMatchingStreamForDirectUrl,
  findSiblingStreamAudioUrl,
  isLikelyAudioOnlyStreamUrl,
  isLikelyVideoOnlyDirectUrl,
  mergeCapturedMediaEntry,
  rankVideoCandidates
} from '../shared/stream_selector.js';
import {
  addTemporaryRefererRule,
  attachDownloadDnrRule,
  attachSaverTabDnrRule,
  detachDownloadDnrRule,
  detachSaverTabDnrRule,
  pruneOrphanedSessionDnrRules,
  removeTemporaryRefererRule,
  withTemporaryRefererRule
} from './dnr_manager.js';
import {
  cancelCompanionDownload,
  checkCompanionStatus,
  downloadWithCompanion
} from './companion_client.js';
import {
  clearDownloadHistory,
  getDownloadHistory,
  recordDownloadHistory
} from './download_history.js';
import { createBackgroundBatchQueue } from './batch_queue.js';
import {
  applyFilenameTemplate,
  isFolderFilenameTemplate,
  loadSettings
} from '../shared/settings.js';

const tabWriteQueues = new Map();
const activeBuilds = new Map();
let offscreenLifecycleQueue = Promise.resolve();
let activeOffscreenBuilds = 0;

const backgroundBatchQueue = createBackgroundBatchQueue({
  executeItem: (item) => handleDownloadMedia(item),
  cancelRequest: (reqId) => cancelDownloadBuild(reqId)
});

pruneOrphanedSessionDnrRules().catch(() => {});

/**
 * Returns true when a runtime message sender belongs to an extension page or the SW itself.
 * Handles extension pages opened in tabs (e.g. stream_saver.html, options.html) and test mocks.
 * @param {chrome.runtime.MessageSender | undefined} sender
 * @returns {boolean}
 */
function isExtensionSender(sender) {
  if (!sender || typeof sender !== 'object') {
    return true;
  }
  const extOrigin = typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.getURL === 'function'
    ? chrome.runtime.getURL('')
    : '';
  if (sender.id && typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id && sender.id !== chrome.runtime.id) {
    return false;
  }
  if (sender.tab) {
    return Boolean(extOrigin && typeof sender.url === 'string' && sender.url.startsWith(extOrigin));
  }
  if (typeof sender.url === 'string' && sender.url && extOrigin) {
    return sender.url.startsWith(extOrigin);
  }
  return true;
}

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
 * Builds the session storage key for MSE captured streams on a tab.
 * @param {number} tabId
 * @returns {string}
 */
function tabMseStorageKey(tabId) {
  return `${STORAGE_KEYS.TAB_MSE_PREFIX}${tabId}`;
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
 * Reads captured MSE stream items for a tab from session storage.
 * @param {number} tabId
 * @returns {Promise<Array<object>>}
 */
async function getTabMseMedia(tabId) {
  const key = tabMseStorageKey(tabId);
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
 * Checks whether any active offscreen build for tabId is currently live recording.
 * @param {number} tabId
 * @returns {boolean}
 */
function hasActiveLiveRecordersForTab(tabId) {
  if (typeof tabId !== 'number' || tabId < 0) {
    return false;
  }
  for (const build of activeBuilds.values()) {
    if (build && build.isLiveRecord && build.tabId === tabId) {
      return true;
    }
  }
  return false;
}

/**
 * Updates the toolbar badge with the live REC indicator or video/stream count for a tab.
 * @param {number} tabId
 * @param {Array<object>} items
 */
async function updateTabBadge(tabId, items) {
  const isRecording = hasActiveLiveRecordersForTab(tabId);
  try {
    if (isRecording) {
      await chrome.action.setBadgeBackgroundColor({
        color: BADGE_CONFIG.REC_COLOR,
        tabId
      });
      await chrome.action.setBadgeText({
        text: BADGE_CONFIG.REC_TEXT,
        tabId
      });
      return;
    }
    const videoCount = items.filter(
      (item) => item.type === MEDIA_TYPES.VIDEO || item.type === MEDIA_TYPES.STREAM
    ).length;
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
 * Recomputes and applies the badge for a tab from current stored media and active recorders.
 * @param {number} tabId
 * @returns {Promise<void>}
 */
async function refreshTabBadge(tabId) {
  if (typeof tabId !== 'number' || tabId < 0) {
    return;
  }
  const [networkItems, mseItems] = await Promise.all([
    getTabNetworkMedia(tabId),
    getTabMseMedia(tabId)
  ]);
  await updateTabBadge(tabId, [...networkItems, ...mseItems]);
}

/**
 * Clears captured media and badge without re-entering enqueueTabWrite.
 * @param {number} tabId
 * @returns {Promise<void>}
 */
async function clearTabMediaUnlocked(tabId) {
  await chrome.storage.session.remove(tabStorageKey(tabId));
  await chrome.storage.session.remove(tabMseStorageKey(tabId));
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
    const capped = mergeCapturedMediaEntry(existing, entry, LIMITS.MAX_CAPTURED_PER_TAB);
    await chrome.storage.session.set({ [tabStorageKey(tabId)]: capped });
    const mseItems = await getTabMseMedia(tabId);
    await updateTabBadge(tabId, [...capped, ...mseItems]);
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

/**
 * Records or updates a captured MSE media stream entry for its tab.
 * @param {number} tabId
 * @param {number} frameId
 * @param {object} stream
 */
function recordMseMedia(tabId, frameId, stream) {
  if (typeof tabId !== 'number' || tabId < 0 || !stream || !stream.mseId) {
    return;
  }
  enqueueTabWrite(tabId, async () => {
    const settings = await loadSettings();
    if (!settings.enableMseCapture) {
      return;
    }
    const classified = classifyMseMime(stream.mimeType || stream.videoMime || stream.audioMime);
    const entry = {
      url: stream.url || `${MSE_CONSTANTS.URL_PREFIX}${stream.mseId}`,
      type: classified.type,
      ext: classified.ext,
      isStream: false,
      isMse: true,
      mseId: stream.mseId,
      frameId: typeof frameId === 'number' ? frameId : 0,
      source: MEDIA_SOURCES.DOM,
      mimeType: stream.mimeType || '',
      videoMime: stream.videoMime || '',
      audioMime: stream.audioMime || '',
      sizeBytes: stream.totalBytes || 0,
      duration: stream.duration || 0,
      width: 0,
      height: 0,
      title: stream.title || '',
      referer: stream.pageUrl || '',
      blobUrl: typeof stream.blobUrl === 'string' ? stream.blobUrl : '',
      capped: Boolean(stream.capped),
      capturedAt: Date.now()
    };
    const existing = await getTabMseMedia(tabId);
    const filtered = existing.filter((item) => item.mseId !== entry.mseId);
    filtered.unshift(entry);
    const cappedList = filtered.slice(0, LIMITS.MAX_CAPTURED_PER_TAB);
    await chrome.storage.session.set({ [tabMseStorageKey(tabId)]: cappedList });
    const networkItems = await getTabNetworkMedia(tabId);
    await updateTabBadge(tabId, [...networkItems, ...cappedList]);
    chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.MEDIA_UPDATED,
      tabId
    }).catch(() => {
      // Popup is not open
    });
  }).catch(() => {
    // Ignore write failure on closed tab
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
      referer: details.documentUrl || details.initiator || '',
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
  detachSaverTabDnrRule(tabId).catch(() => {});
  enqueueTabWrite(tabId, async () => {
    await chrome.storage.session.remove([
      tabStorageKey(tabId),
      tabRouteStorageKey(tabId),
      tabMseStorageKey(tabId)
    ]);
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
 * Queries the offscreen document for active builds/recordings/blobs with a short timeout.
 * @returns {Promise<{ activeCount: number, activeBlobCount: number, builds: Array<object> } | null>}
 */
async function queryOffscreenActiveBuilds() {
  let timeoutId = null;
  try {
    const queryPromise = chrome.runtime.sendMessage({
      target: 'offscreen',
      type: MESSAGE_TYPES.OFFSCREEN_GET_ACTIVE_BUILDS
    });
    const timeoutPromise = new Promise((resolve) => {
      timeoutId = setTimeout(() => resolve(null), LIMITS.OFFSCREEN_QUERY_TIMEOUT_MS);
    });
    const resp = await Promise.race([queryPromise, timeoutPromise]);
    if (resp && typeof resp === 'object' && resp.ok) {
      return {
        activeCount: Number.isFinite(resp.activeCount) ? resp.activeCount : 0,
        activeBlobCount: Number.isFinite(resp.activeBlobCount) ? resp.activeBlobCount : 0,
        builds: Array.isArray(resp.builds) ? resp.builds : []
      };
    }
    return null;
  } catch {
    return null;
  } finally {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
  }
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
  const sessionKeys = typeof chrome.storage.session.getKeys === 'function'
    ? await chrome.storage.session.getKeys()
    : Object.keys(await chrome.storage.session.get(null));
  const hasPendingBlobs = sessionKeys.some((key) =>
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
    const offscreenState = await queryOffscreenActiveBuilds();
    if (offscreenState && (offscreenState.activeCount > 0 || offscreenState.activeBlobCount > 0)) {
      return;
    }
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
  detachDownloadDnrRule(delta.id).catch(() => {});
  cleanupDownloadBlob(delta.id).catch(() => {});
});

/**
 * Injects or reuses the DOM media scanner across all frames in a tab and merges results.
 * @param {number} tabId
 * @param {string} tabUrl
 * @param {object} settings
 * @returns {Promise<object>}
 */
async function scanTabDom(tabId, tabUrl, settings) {
  const domResult = {
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
        AUDIO: MEDIA_TYPES.AUDIO,
        SUBTITLE: MEDIA_TYPES.SUBTITLE
      },
      sourceTag: MEDIA_SOURCES.DOM,
      directExtensions: [...VIDEO_EXTENSIONS, ...IMAGE_EXTENSIONS, ...AUDIO_EXTENSIONS],
      subtitleExtensions: SUBTITLE_EXTENSIONS,
      maxJsonLdNodes: LIMITS.MAX_JSON_LD_NODES,
      maxSvgItems: LIMITS.MAX_SVG_ITEMS,
      minSvgDimensionPx: LIMITS.MIN_SVG_DIMENSION_PX,
      minRasterDataUriLength: LIMITS.MIN_RASTER_DATA_URI_LENGTH
    };

    const runScan = (cfg) => (
      typeof window.__mediaHarvestScan === 'function' ? window.__mediaHarvestScan(cfg) : null
    );

    let execResults = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: runScan,
      args: [scanConfig]
    });

    const missingFrameIds = Array.isArray(execResults)
      ? execResults.filter((entry) => !entry || !entry.result).map((entry) => entry.frameId).filter((id) => typeof id === 'number')
      : [];

    if (!execResults || execResults.length === 0 || missingFrameIds.length > 0) {
      const injectTarget = missingFrameIds.length > 0
        ? { tabId, frameIds: missingFrameIds }
        : { tabId, allFrames: true };
      await chrome.scripting.executeScript({
        target: injectTarget,
        files: ['src/content/dom_scanner.js']
      }).catch(() => {});
      execResults = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: runScan,
        args: [scanConfig]
      });
    }

    if (Array.isArray(execResults)) {
      for (const frameExec of execResults) {
        const res = frameExec && frameExec.result;
        if (!res) {
          continue;
        }
        if (!domResult.pageTitle && res.pageTitle) {
          domResult.pageTitle = res.pageTitle;
        }
        if (res.hasBlobVideo) {
          domResult.hasBlobVideo = true;
        }
        if (Array.isArray(res.videoElements)) {
          domResult.videoElements.push(...res.videoElements);
        }
        if (Array.isArray(res.items)) {
          const frameReferer = res.pageUrl || tabUrl;
          for (const item of res.items) {
            domResult.items.push({
              ...item,
              referer: item.referer || frameReferer
            });
          }
        }
      }
    }
  } catch {
    // Some pages restrict scripting even on http/https; keep network items
  }

  return domResult;
}

/**
 * Scans the active tab DOM and combines results with captured network and MSE media.
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
  const [networkItems, mseItems, domResult] = await Promise.all([
    getTabNetworkMedia(tabId),
    settings.enableMseCapture ? getTabMseMedia(tabId) : Promise.resolve([]),
    scanTabDom(tabId, tabUrl, settings)
  ]);

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
    deduplicateMedia([...networkItems, ...mseItems, ...normalizedDomItems]),
    domResult.videoElements || []
  ).map((item) => {
    const baseStem = item.svgSymbolId
      ? item.svgSymbolId
      : deriveFilenameStem(item.url, item.title || domResult.pageTitle, tabUrl);
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
 * Fetches and parses an HLS or DASH manifest so the UI can list variants, duration, and size.
 * @param {string} url
 * @param {string} [referer='']
 * @returns {Promise<object>}
 */
async function inspectHlsStream(url, referer = '') {
  if (!isHttpUrl(url)) {
    throw new Error('INVALID_URL');
  }
  return withTemporaryRefererRule(url, referer, async () => {
    const text = await fetchWithManagedTimeout(url, { responseMode: 'text' });
    const looksDash = isDashDescriptor(url) || looksLikeDashXml(text);

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
    const rootBlockedEncrypted = Boolean(
      parsed.drmEncrypted || (parsed.encrypted && !parsed.decryptableAes128)
    );

    let durationSec = parsed.totalDurationSec;
    let sampleDynamic = false;
    let sampleBlockedEncrypted = false;
    let sampleDecryptableAes128 = false;
    let sampleOutputExtension = parsed.outputExtension;
    if (parsed.isMaster && parsed.variants.length > 0 && !rootBlockedEncrypted) {
      try {
        const sampleText = await fetchWithManagedTimeout(parsed.variants[0].url, {
          responseMode: 'text'
        });
        const sampleParsed = parseHlsPlaylist(sampleText, parsed.variants[0].url);
        durationSec = sampleParsed.totalDurationSec;
        sampleDynamic = Boolean(sampleParsed.isDynamic);
        sampleBlockedEncrypted = Boolean(
          sampleParsed.drmEncrypted || (sampleParsed.encrypted && !sampleParsed.decryptableAes128)
        );
        sampleDecryptableAes128 = Boolean(sampleParsed.decryptableAes128);
        sampleOutputExtension = sampleParsed.outputExtension;
      } catch {
        // Duration and sample metadata estimation is best-effort
      }
    }

    const variantsWithEstimate = parsed.variants.map((variant) => ({
      ...variant,
      durationSec,
      estimatedBytes: estimateHlsBytes(variant.bandwidth, durationSec)
    }));

    return {
      ...parsed,
      encrypted: rootBlockedEncrypted || sampleBlockedEncrypted,
      decryptableAes128: Boolean(parsed.decryptableAes128 || sampleDecryptableAes128),
      isDynamic: parsed.isDynamic || sampleDynamic,
      outputExtension: sampleOutputExtension,
      streamFormat: 'hls',
      totalDurationSec: durationSec,
      variants: variantsWithEstimate
    };
  });
}

/**
 * Resolves and downloads the video matching an inline X post click.
 * @param {number} tabId
 * @param {{ mediaId?: string, directSrc?: string, authorHandle?: string, tweetId?: string }} payload
 * @param {string} [pageUrl='']
 * @returns {Promise<{ downloadId: number, requestId: string }>}
 */
async function handleTweetVideoDownload(tabId, payload, pageUrl = '') {
  const settings = await loadSettings();
  const networkItems = await getTabNetworkMedia(tabId);
  const videoCandidates = networkItems.filter(
    (item) => (item.type === MEDIA_TYPES.STREAM || item.type === MEDIA_TYPES.VIDEO)
      && !isLikelyAudioOnlyStreamUrl(item.url)
  );
  const allCandidatesForMatch = networkItems.filter(
    (item) => item.type === MEDIA_TYPES.STREAM || item.type === MEDIA_TYPES.VIDEO
  );

  let chosen = null;
  if (payload.mediaId) {
    const mediaMatches = rankVideoCandidates(
      videoCandidates.filter((item) => extractMediaId(item.url) === payload.mediaId)
    );
    chosen = mediaMatches[0] || null;
  }
  if (!chosen && payload.directSrc && isHttpUrl(payload.directSrc)) {
    chosen = {
      url: payload.directSrc,
      isStream: false,
      ext: DEFAULT_FILENAMES.HLS_FMP4_EXT
    };
  }
  if (!chosen && videoCandidates.length > 0) {
    const rankedAll = rankVideoCandidates(videoCandidates);
    const distinctIds = new Set(rankedAll.map((item) => extractMediaId(item.url)).filter(Boolean));
    if (rankedAll.length === 1 || (!payload.mediaId && distinctIds.size === 1)) {
      chosen = rankedAll[0];
    }
  }
  if (!chosen) {
    throw new Error('PLAY_FIRST');
  }

  const audioUrl = chosen.isStream
    ? findSiblingStreamAudioUrl(chosen, allCandidatesForMatch)
    : findCompanionAudioUrl(chosen.url, networkItems);

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
    audioUrl,
    isStream: Boolean(chosen.isStream),
    audioOnly: Boolean(payload.audioOnly),
    qualityPreference: typeof payload.qualityPreference === 'string' ? payload.qualityPreference : '',
    filename,
    saveAs: Boolean(settings.promptSaveAs),
    requestId: typeof payload.requestId === 'string' ? payload.requestId : '',
    tabId
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
 * Signals active live DVR or tab capture recorders in the offscreen worker to stop and finalize.
 * @param {string} [requestId]
 * @returns {Promise<void>}
 */
async function stopLiveRecording(requestId) {
  await Promise.all([
    chrome.runtime.sendMessage({
      target: 'offscreen',
      type: MESSAGE_TYPES.OFFSCREEN_STOP_LIVE_RECORD,
      requestId
    }).catch(() => {}),
    chrome.runtime.sendMessage({
      target: 'offscreen',
      type: MESSAGE_TYPES.OFFSCREEN_STOP_TAB_CAPTURE,
      requestId
    }).catch(() => {})
  ]);
}

/**
 * Starts a direct browser download for a non-stream media URL.
 * @param {object} payload
 * @param {string} rawStem
 * @param {string} requestId
 * @returns {Promise<{ downloadId: number, requestId: string }>}
 */
async function startDirectDownload(payload, rawStem, requestId) {
  const settings = await loadSettings();
  const classified = classifyMedia(payload.url);
  const fallbackExt = classified ? classified.ext : DEFAULT_FILENAMES.FALLBACK_EXT;
  const rawName = typeof payload.filename === 'string' ? payload.filename : '';
  const leafStart = Math.max(rawName.lastIndexOf('/'), rawName.lastIndexOf('\\')) + 1;
  const leafName = rawName.slice(leafStart);
  const dotIdx = leafName.lastIndexOf('.');
  const providedExt = dotIdx > 0 && dotIdx < leafName.length - 1 ? leafName.slice(dotIdx + 1) : '';
  const allowFolders = Boolean(payload.allowFolders) || isFolderFilenameTemplate(settings.filenameTemplate);
  const directFilename = sanitizeFilename(rawStem, providedExt || fallbackExt, { allowFolders });
  const ruleId = isHttpUrl(payload.url)
    ? await addTemporaryRefererRule(payload.url, payload.referer || '')
    : null;
  try {
    const downloadId = await chrome.downloads.download({
      url: payload.url,
      filename: directFilename,
      saveAs: Boolean(payload.saveAs)
    });
    if (ruleId !== null) {
      await attachDownloadDnrRule(downloadId, ruleId);
    }
    return { downloadId, requestId };
  } catch (err) {
    if (ruleId !== null) {
      await removeTemporaryRefererRule(ruleId);
    }
    throw err;
  }
}

/**
 * Broadcasts stream download completion or failure to open extension UI listeners.
 * @param {string} requestId
 * @param {string} url
 * @param {boolean} ok
 * @param {string} [error='']
 */
function notifyStreamFinished(requestId, url, ok, error = '') {
  chrome.runtime.sendMessage({
    type: MESSAGE_TYPES.DOWNLOAD_FINISHED,
    requestId,
    url,
    ok,
    error
  }).catch(() => {
    // Popup may be closed
  });
}

/**
 * Shared offscreen blob assembly, Chrome download, cancellation, and cleanup pipeline.
 * @param {{
 *   requestId: string,
 *   targetUrl: string,
 *   rawStem: string,
 *   fallbackExt: string,
 *   saveAs: boolean,
 *   allowFolders: boolean,
 *   tabId: number,
 *   buildOffscreenMessage: (settings: object) => object
 * }} params
 * @returns {Promise<{ downloadId: number, requestId: string }>}
 */
async function executeOffscreenBlobDownload({
  requestId,
  targetUrl,
  rawStem,
  fallbackExt,
  saveAs,
  allowFolders,
  tabId,
  referer = '',
  isLiveRecord = false,
  isTabCapture = false,
  buildOffscreenMessage,
  runOffscreenBuild
}) {
  const buildState = {
    cancelled: false,
    downloadId: null,
    url: targetUrl,
    done: 0,
    total: 0,
    tabId,
    isLiveRecord: Boolean(isLiveRecord),
    isTabCapture: Boolean(isTabCapture)
  };
  activeBuilds.set(requestId, buildState);
  activeOffscreenBuilds += 1;
  if (buildState.isLiveRecord && tabId >= 0) {
    refreshTabBadge(tabId).catch(() => {});
  }
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

    const executeBuild = typeof runOffscreenBuild === 'function'
      ? () => runOffscreenBuild(settings)
      : () => chrome.runtime.sendMessage(buildOffscreenMessage(settings));
    const result = await withTemporaryRefererRule(targetUrl, referer, executeBuild);

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
    const allowDownloadFolders = allowFolders || isFolderFilenameTemplate(settings.filenameTemplate);
    const finalFilename = sanitizeFilename(
      rawStem,
      result.outputExtension || fallbackExt,
      { allowFolders: allowDownloadFolders }
    );
    const downloadId = await chrome.downloads.download({
      url: blobUrl,
      filename: finalFilename,
      saveAs: Boolean(saveAs)
    });
    buildState.downloadId = downloadId;

    if (buildState.cancelled) {
      if (typeof downloadId === 'number') {
        await chrome.downloads.cancel(downloadId).catch(() => {});
        await cleanupDownloadBlob(downloadId, blobUrl);
      } else {
        await revokeOffscreenBlob(blobUrl);
      }
      blobUrl = '';
      throw new Error('DOWNLOAD_CANCELLED');
    }

    if (typeof downloadId !== 'number') {
      throw new Error('DOWNLOAD_FAILED');
    }

    let storedBlobKey = '';
    await chrome.storage.session.set({ [downloadBlobKey(downloadId)]: blobUrl });
    storedBlobKey = downloadBlobKey(downloadId);
    const [dlItem] = await chrome.downloads.search({ id: downloadId });
    if (dlItem && dlItem.state !== 'in_progress') {
      await cleanupDownloadBlob(downloadId, blobUrl);
      storedBlobKey = '';
    }
    notifyStreamFinished(requestId, targetUrl, true);
    return { downloadId, requestId };
  } catch (err) {
    if (typeof buildState.downloadId === 'number' && chrome.storage && chrome.storage.session) {
      await chrome.storage.session.remove(downloadBlobKey(buildState.downloadId)).catch(() => {});
    }
    if (blobUrl) {
      await revokeOffscreenBlob(blobUrl);
    }
    notifyStreamFinished(
      requestId,
      targetUrl,
      false,
      err && err.message ? err.message : 'HLS_ERROR'
    );
    throw err;
  } finally {
    const wasLiveRecord = Boolean(buildState.isLiveRecord);
    activeBuilds.delete(requestId);
    activeOffscreenBuilds -= 1;
    if (wasLiveRecord && tabId >= 0) {
      refreshTabBadge(tabId).catch(() => {});
    }
    enqueueOffscreenOp(() => maybeCloseOffscreenDocument()).catch(() => {});
  }
}

/**
 * Assembles an HLS or DASH stream in the offscreen document and initiates download.
 * @param {object} payload
 * @param {string} rawStem
 * @param {string} requestId
 * @returns {Promise<{ downloadId: number, requestId: string }>}
 */
async function startStreamDownload(payload, rawStem, requestId) {
  const targetPlaylist = payload.playlistUrl || payload.url;
  if (!isHttpUrl(targetPlaylist)) {
    throw new Error('INVALID_URL');
  }

  return executeOffscreenBlobDownload({
    requestId,
    targetUrl: payload.url,
    rawStem,
    fallbackExt: payload.audioOnly ? DEFAULT_FILENAMES.AUDIO_M4A_EXT : DEFAULT_FILENAMES.HLS_TS_EXT,
    saveAs: Boolean(payload.saveAs),
    allowFolders: Boolean(payload.allowFolders),
    tabId: typeof payload.tabId === 'number' ? payload.tabId : -1,
    referer: typeof payload.referer === 'string' ? payload.referer : '',
    isLiveRecord: Boolean(payload.recordLive),
    buildOffscreenMessage: (settings) => ({
      target: 'offscreen',
      type: payload.recordLive
        ? MESSAGE_TYPES.OFFSCREEN_RECORD_HLS_LIVE
        : MESSAGE_TYPES.OFFSCREEN_BUILD_HLS_BLOB,
      requestId,
      playlistUrl: targetPlaylist,
      originalUrl: payload.url,
      audioUrl: typeof payload.audioUrl === 'string' ? payload.audioUrl : '',
      audioOnly: Boolean(payload.audioOnly),
      progressiveMux: Boolean(payload.progressiveMux),
      audioFormat: settings.audioExportFormat || AUDIO_EXPORT_FORMATS.M4A,
      concurrency: settings.hlsFetchConcurrency,
      qualityPreference: typeof payload.qualityPreference === 'string' && payload.qualityPreference
        ? payload.qualityPreference
        : settings.defaultQuality,
      pollIntervalMs: typeof payload.pollIntervalMs === 'number' ? payload.pollIntervalMs : undefined
    })
  });
}

/**
 * Exports a captured MSE stream buffer from the tab's content bridge into offscreen and downloads it.
 * @param {object} payload
 * @param {string} rawStem
 * @param {string} requestId
 * @returns {Promise<{ downloadId: number, requestId: string }>}
 */
async function startMseDownload(payload, rawStem, requestId) {
  const tabId = typeof payload.tabId === 'number' ? payload.tabId : -1;
  if (tabId < 0) {
    throw new Error('NO_ACTIVE_TAB');
  }
  const mseId = payload.mseId || payload.url.slice(MSE_CONSTANTS.URL_PREFIX.length);
  if (!mseId) {
    throw new Error('MSE_NOT_FOUND');
  }
  const frameId = typeof payload.frameId === 'number' ? payload.frameId : undefined;
  const fallbackExt = payload.audioOnly
    ? DEFAULT_FILENAMES.AUDIO_M4A_EXT
    : (payload.ext || DEFAULT_FILENAMES.HLS_FMP4_EXT);

  return executeOffscreenBlobDownload({
    requestId,
    targetUrl: payload.url,
    rawStem,
    fallbackExt,
    saveAs: Boolean(payload.saveAs),
    allowFolders: Boolean(payload.allowFolders),
    tabId,
    runOffscreenBuild: (settings) => {
      const msg = {
        type: MESSAGE_TYPES.EXPORT_MSE_STREAM,
        requestId,
        mseId,
        audioOnly: Boolean(payload.audioOnly),
        audioFormat: (settings && settings.audioExportFormat) || AUDIO_EXPORT_FORMATS.M4A
      };
      if (typeof frameId === 'number') {
        return chrome.tabs.sendMessage(tabId, msg, { frameId });
      }
      return chrome.tabs.sendMessage(tabId, msg);
    }
  });
}

/**
 * Resolves raw download filename stem without stripping folder dots like "example.com/clip".
 * @param {string | undefined} rawFilename
 * @param {string} fallbackUrl
 * @returns {string}
 */
function resolveDownloadStem(rawFilename, fallbackUrl) {
  if (typeof rawFilename === 'string' && rawFilename) {
    return rawFilename.replace(/\.[^./\\]+$/, '');
  }
  return deriveFilenameStem(fallbackUrl, '');
}

/**
 * Downloads an HLS subtitle track (merging segmented WebVTT manifests in offscreen) via Chrome downloads.
 * @param {{ subtitleUrl: string, filename?: string, saveAs?: boolean, allowFolders?: boolean, requestId?: string }} payload
 * @returns {Promise<{ downloadId: number, requestId: string }>}
 */
async function handleDownloadHlsSubtitle(payload) {
  if (!payload || typeof payload !== 'object' || !isHttpUrl(payload.subtitleUrl)) {
    throw new Error('INVALID_URL');
  }

  const rawStem = resolveDownloadStem(payload.filename, payload.subtitleUrl);
  const requestId = typeof payload.requestId === 'string' && payload.requestId
    ? payload.requestId
    : `sub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  return executeOffscreenBlobDownload({
    requestId,
    targetUrl: payload.subtitleUrl,
    rawStem,
    fallbackExt: payload.subtitleFormat === 'srt' ? 'srt' : DEFAULT_FILENAMES.SUBTITLE_EXT,
    saveAs: Boolean(payload.saveAs),
    allowFolders: Boolean(payload.allowFolders),
    tabId: -1,
    buildOffscreenMessage: (settings) => ({
      target: 'offscreen',
      type: MESSAGE_TYPES.OFFSCREEN_BUILD_SUBTITLE_BLOB,
      requestId,
      subtitleUrl: payload.subtitleUrl,
      subtitleFormat: payload.subtitleFormat === 'srt' ? 'srt' : 'vtt',
      concurrency: settings.hlsFetchConcurrency
    })
  });
}

/**
 * Resolves and downloads the best available video stream or capture for a site overlay click.
 * @param {number} tabId
 * @param {{ requestId?: string, siteId?: string, pageUrl?: string, title?: string, directVideoUrl?: string, blobUrl?: string }} payload
 * @param {string} [fallbackPageUrl='']
 * @returns {Promise<{ downloadId: number, requestId: string }>}
 */
async function handleSiteVideoDownload(tabId, payload, fallbackPageUrl = '') {
  const settings = await loadSettings();
  const [networkItems, mseItems] = await Promise.all([
    getTabNetworkMedia(tabId),
    settings.enableMseCapture ? getTabMseMedia(tabId) : Promise.resolve([])
  ]);

  const streams = rankVideoCandidates(
    networkItems.filter((item) => item.type === MEDIA_TYPES.STREAM && !isLikelyAudioOnlyStreamUrl(item.url))
  );
  const directNetworkVideos = networkItems
    .filter((item) => item.type === MEDIA_TYPES.VIDEO && !isLikelyAudioOnlyStreamUrl(item.url))
    .sort((a, b) => (b.sizeBytes || 0) - (a.sizeBytes || 0));
  const sortedMseItems = [...mseItems].sort((a, b) => (b.sizeBytes || 0) - (a.sizeBytes || 0));

  const pageUrl = payload.pageUrl || fallbackPageUrl;
  let exactDirect = null;
  if (payload.directVideoUrl && isHttpUrl(payload.directVideoUrl)) {
    const existingDirect = networkItems.find((item) => item.url === payload.directVideoUrl);
    if (existingDirect) {
      exactDirect = existingDirect;
    } else {
      const classified = classifyMedia(payload.directVideoUrl);
      exactDirect = {
        url: payload.directVideoUrl,
        isStream: classified ? classified.isStream : false,
        ext: classified ? classified.ext : DEFAULT_FILENAMES.HLS_FMP4_EXT,
        referer: pageUrl
      };
    }
  }

  const matchedMse = payload.blobUrl
    ? mseItems.find((item) => item.blobUrl && item.blobUrl === payload.blobUrl) || null
    : null;

  const matchedDirectStream = exactDirect
    ? findMatchingStreamForDirectUrl(exactDirect.url, streams)
    : null;
  const preferMatchedMse = Boolean(matchedMse && (streams.length === 0 || mseItems.length > 1));
  const preferStreamOverDirect = Boolean(
    matchedDirectStream && (isLikelyVideoOnlyDirectUrl(exactDirect.url) || exactDirect.isStream)
  );
  const chosen = (preferStreamOverDirect ? matchedDirectStream : null)
    || (exactDirect && !isLikelyVideoOnlyDirectUrl(exactDirect.url) ? exactDirect : null)
    || (preferMatchedMse ? matchedMse : null)
    || matchedDirectStream
    || exactDirect
    || streams[0]
    || matchedMse
    || directNetworkVideos[0]
    || sortedMseItems[0]
    || null;

  if (!chosen) {
    throw new Error('PLAY_FIRST');
  }

  const companionAudioUrl = chosen.isMse
    ? ''
    : (chosen.isStream
        ? findSiblingStreamAudioUrl(chosen, networkItems)
        : findCompanionAudioUrl(chosen.url, networkItems));

  const baseStem = (payload.title && payload.title.trim())
    || deriveFilenameStem(chosen.url, chosen.title || '', pageUrl);
  const templatedStem = applyFilenameTemplate(settings.filenameTemplate, {
    stem: baseStem,
    pageUrl: pageUrl || chosen.url
  });
  const filename = sanitizeFilename(templatedStem, chosen.ext || DEFAULT_FILENAMES.HLS_FMP4_EXT);

  return handleDownloadMedia({
    url: chosen.url,
    playlistUrl: chosen.url,
    audioUrl: companionAudioUrl,
    isStream: Boolean(chosen.isStream),
    isMse: Boolean(chosen.isMse || isMseUrl(chosen.url)),
    mseId: chosen.mseId || '',
    frameId: typeof chosen.frameId === 'number' ? chosen.frameId : undefined,
    ext: chosen.ext || '',
    referer: chosen.referer || pageUrl,
    audioOnly: Boolean(payload.audioOnly),
    qualityPreference: typeof payload.qualityPreference === 'string' ? payload.qualityPreference : '',
    filename,
    saveAs: Boolean(settings.promptSaveAs),
    requestId: typeof payload.requestId === 'string' ? payload.requestId : '',
    tabId
  });
}

/**
 * Converts an image or SVG via offscreen canvas to PNG or JPG and initiates download.
 * @param {object} payload
 * @param {string} rawStem
 * @param {string} requestId
 * @returns {Promise<{ downloadId: number, requestId: string }>}
 */
async function startImageConversionDownload(payload, rawStem, requestId) {
  const targetFormat = String(payload.convertTo || '').toLowerCase();
  return executeOffscreenBlobDownload({
    requestId,
    targetUrl: payload.url,
    rawStem,
    fallbackExt: targetFormat || IMAGE_CONVERT_FORMATS.PNG,
    saveAs: Boolean(payload.saveAs),
    allowFolders: Boolean(payload.allowFolders),
    tabId: typeof payload.tabId === 'number' ? payload.tabId : -1,
    referer: typeof payload.referer === 'string' ? payload.referer : '',
    buildOffscreenMessage: (settings) => ({
      target: 'offscreen',
      type: MESSAGE_TYPES.OFFSCREEN_CONVERT_IMAGE,
      requestId,
      targetUrl: payload.url,
      targetFormat,
      width: Number.isFinite(payload.width) ? payload.width : 0,
      height: Number.isFinite(payload.height) ? payload.height : 0,
      rasterSizePx: Number.isFinite(payload.rasterSizePx) ? payload.rasterSizePx : 0,
      jpgQualityPercent: settings.jpgQualityPercent,
      maxImageResizePx: settings.maxImageResizePx,
      symbolId: typeof payload.svgSymbolId === 'string' ? payload.svgSymbolId : ''
    })
  });
}

/**
 * Extracts and optimizes an external SVG sprite symbol via offscreen and initiates download.
 * @param {object} payload
 * @param {string} rawStem
 * @param {string} requestId
 * @returns {Promise<{ downloadId: number, requestId: string }>}
 */
async function startSvgSymbolDownload(payload, rawStem, requestId) {
  return executeOffscreenBlobDownload({
    requestId,
    targetUrl: payload.url,
    rawStem,
    fallbackExt: DEFAULT_FILENAMES.SVG_EXT,
    saveAs: Boolean(payload.saveAs),
    allowFolders: Boolean(payload.allowFolders),
    tabId: typeof payload.tabId === 'number' ? payload.tabId : -1,
    referer: typeof payload.referer === 'string' ? payload.referer : '',
    buildOffscreenMessage: () => ({
      target: 'offscreen',
      type: MESSAGE_TYPES.OFFSCREEN_EXTRACT_SVG_SYMBOL,
      requestId,
      targetUrl: payload.url,
      symbolId: typeof payload.svgSymbolId === 'string' ? payload.svgSymbolId : ''
    })
  });
}

/**
 * Fetches a direct HTTP video/audio URL and decodes its audio track into PCM 16-bit WAV in offscreen.
 * @param {object} payload
 * @param {string} rawStem
 * @param {string} requestId
 * @returns {Promise<{ downloadId: number, requestId: string }>}
 */
async function startDirectAudioWavDownload(payload, rawStem, requestId) {
  return executeOffscreenBlobDownload({
    requestId,
    targetUrl: payload.url,
    rawStem,
    fallbackExt: DEFAULT_FILENAMES.AUDIO_WAV_EXT,
    saveAs: Boolean(payload.saveAs),
    allowFolders: Boolean(payload.allowFolders),
    tabId: typeof payload.tabId === 'number' ? payload.tabId : -1,
    referer: typeof payload.referer === 'string' ? payload.referer : '',
    buildOffscreenMessage: (settings) => ({
      target: 'offscreen',
      type: MESSAGE_TYPES.OFFSCREEN_DECODE_WAV,
      requestId,
      targetUrl: payload.url,
      audioFormat: settings.audioExportFormat
    })
  });
}

/**
 * Starts a MediaRecorder capture of the active browser tab via chrome.tabCapture + offscreen.
 * @param {object} payload
 * @returns {Promise<{ downloadId: number, requestId: string }>}
 */
async function handleStartTabCapture(payload) {
  const tabId = payload && typeof payload.tabId === 'number' ? payload.tabId : -1;
  const tabUrl = payload && typeof payload.tabUrl === 'string' ? payload.tabUrl : '';
  if (tabId < 0) {
    throw new Error('NO_ACTIVE_TAB');
  }
  if (!isHttpUrl(tabUrl)) {
    throw new Error('RESTRICTED_PAGE');
  }
  if (!chrome.tabCapture || typeof chrome.tabCapture.getMediaStreamId !== 'function') {
    throw new Error('TAB_CAPTURE_UNAVAILABLE');
  }

  let streamId = '';
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  } catch {
    throw new Error('TAB_CAPTURE_UNAVAILABLE');
  }
  if (!streamId) {
    throw new Error('TAB_CAPTURE_UNAVAILABLE');
  }

  const requestId = payload && typeof payload.requestId === 'string' && payload.requestId
    ? payload.requestId
    : `cap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const rawTitle = (payload && typeof payload.title === 'string' && payload.title.trim()) || deriveFilenameStem(tabUrl, '');
  const settings = await loadSettings().catch(() => ({}));
  const templatedStem = applyFilenameTemplate(settings.filenameTemplate, {
    stem: rawTitle,
    pageUrl: tabUrl
  });

  return executeOffscreenBlobDownload({
    requestId,
    targetUrl: tabUrl,
    rawStem: templatedStem,
    fallbackExt: DEFAULT_FILENAMES.WEBM_EXT,
    saveAs: Boolean(payload && payload.saveAs),
    allowFolders: isFolderFilenameTemplate(settings.filenameTemplate),
    tabId,
    isLiveRecord: true,
    isTabCapture: true,
    buildOffscreenMessage: () => ({
      target: 'offscreen',
      type: MESSAGE_TYPES.OFFSCREEN_START_TAB_CAPTURE,
      requestId,
      streamId,
      originalUrl: tabUrl,
      tabCaptureBitrateMbps: settings.tabCaptureBitrateMbps
    })
  });
}

/**
 * Packages multiple selected items into a single offscreen ZIP archive and downloads it.
 * @param {object} payload
 * @returns {Promise<{ downloadId: number, requestId: string }>}
 */
async function handleExportBatchZip(payload) {
  const items = payload && Array.isArray(payload.items) ? payload.items : [];
  if (items.length === 0) {
    throw new Error('EMPTY_PLAYLIST');
  }
  const requestId = typeof payload.requestId === 'string' && payload.requestId
    ? payload.requestId
    : `zip_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const firstHttpItem = items.find((item) => item && isHttpUrl(item.url));
  const targetUrl = (firstHttpItem && firstHttpItem.url) || (typeof payload.referer === 'string' ? payload.referer : '') || 'zip://archive';
  const rawStem = resolveDownloadStem(payload.filename || DEFAULT_FILENAMES.BASE, targetUrl);
  return executeOffscreenBlobDownload({
    requestId,
    targetUrl,
    rawStem,
    fallbackExt: DEFAULT_FILENAMES.ZIP_EXT,
    saveAs: Boolean(payload.saveAs),
    allowFolders: Boolean(payload.allowFolders),
    tabId: typeof payload.tabId === 'number' ? payload.tabId : -1,
    referer: typeof payload.referer === 'string' ? payload.referer : '',
    buildOffscreenMessage: (settings) => ({
      target: 'offscreen',
      type: MESSAGE_TYPES.OFFSCREEN_BUILD_ZIP_BLOB,
      requestId,
      items,
      concurrency: settings.hlsFetchConcurrency,
      jpgQualityPercent: settings.jpgQualityPercent,
      maxImageResizePx: settings.maxImageResizePx,
      renameMode: payload.renameMode === ZIP_RENAME_MODES.SEQUENTIAL
        ? ZIP_RENAME_MODES.SEQUENTIAL
        : ZIP_RENAME_MODES.ORIGINAL
    })
  });
}

/**
 * Persists a large-stream descriptor in session storage and opens the direct disk saver tab.
 * @param {object} payload
 * @returns {Promise<{ jobId: string, tabId: number }>}
 */
async function handleOpenStreamSaver(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('INVALID_URL');
  }
  const targetUrl = typeof payload.playlistUrl === 'string' && payload.playlistUrl
    ? payload.playlistUrl
    : (typeof payload.url === 'string' ? payload.url : '');
  if (!isHttpUrl(targetUrl)) {
    throw new Error('INVALID_URL');
  }
  const settings = await loadSettings();
  const jobId = `saver_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const rawStem = resolveDownloadStem(payload.filename, targetUrl);
  const jobRecord = {
    jobId,
    url: typeof payload.url === 'string' ? payload.url : targetUrl,
    playlistUrl: targetUrl,
    audioUrl: typeof payload.audioUrl === 'string' ? payload.audioUrl : '',
    isStream: Boolean(payload.isStream),
    referer: typeof payload.referer === 'string' ? payload.referer : '',
    suggestedFilename: sanitizeFilename(rawStem, DEFAULT_FILENAMES.HLS_FMP4_EXT),
    qualityPreference: settings.defaultQuality,
    concurrency: settings.hlsFetchConcurrency
  };
  await chrome.storage.session.set({
    [`${STORAGE_KEYS.STREAM_SAVER_JOB_PREFIX}${jobId}`]: jobRecord
  });
  const saverUrl = chrome.runtime.getURL(`${STREAM_SAVER_PATH}?jobId=${encodeURIComponent(jobId)}`);
  const createdTab = await chrome.tabs.create({ url: saverUrl });
  const saverTabId = createdTab && typeof createdTab.id === 'number' ? createdTab.id : -1;
  const refererRuleId = jobRecord.referer && saverTabId >= 0
    ? await addTemporaryRefererRule(targetUrl, jobRecord.referer, {
        extensionInitiatorOnly: true,
        tabIds: [saverTabId]
      }).catch(() => null)
    : null;
  if (saverTabId >= 0) {
    await attachSaverTabDnrRule(saverTabId, refererRuleId, jobId);
  }
  return { jobId, tabId: saverTabId };
}

/**
 * Dispatches a validated download payload to the appropriate pipeline.
 * @param {object} payload
 * @param {string} rawStem
 * @param {string} requestId
 * @param {boolean} mseTarget
 * @returns {Promise<{ downloadId: number, requestId: string }>}
 */
async function dispatchDownloadMedia(payload, rawStem, requestId, mseTarget) {
  if (mseTarget) {
    return startMseDownload(payload, rawStem, requestId);
  }
  const convertFormat = typeof payload.convertTo === 'string' ? payload.convertTo.toLowerCase() : '';
  if (convertFormat === IMAGE_CONVERT_FORMATS.PNG || convertFormat === IMAGE_CONVERT_FORMATS.JPG) {
    return startImageConversionDownload(payload, rawStem, requestId);
  }
  if (!payload.isStream) {
    if (payload.audioOnly) {
      return startDirectAudioWavDownload(payload, rawStem, requestId);
    }
    if (payload.audioUrl && isHttpUrl(payload.audioUrl)) {
      return startStreamDownload({ ...payload, isStream: true, progressiveMux: true }, rawStem, requestId);
    }
    if (payload.svgSymbolId) {
      return startSvgSymbolDownload(payload, rawStem, requestId);
    }
    return startDirectDownload(payload, rawStem, requestId);
  }
  return startStreamDownload(payload, rawStem, requestId);
}

/**
 * Starts a download either directly, via image conversion, via MSE export, or via HLS/DASH offscreen assembly.
 * @param {{ url: string, playlistUrl?: string, isStream?: boolean, isMse?: boolean, convertTo?: string, filename?: string, saveAs?: boolean, requestId?: string }} payload
 * @returns {Promise<{ downloadId: number, requestId: string }>}
 */
async function handleDownloadMedia(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('INVALID_URL');
  }
  const mseTarget = Boolean(payload.isMse || isMseUrl(payload.url));
  if (!mseTarget && !isDownloadableMediaUrl(payload.url)) {
    throw new Error('INVALID_URL');
  }

  const rawStem = resolveDownloadStem(payload.filename, payload.url);
  const requestId = typeof payload.requestId === 'string' && payload.requestId
    ? payload.requestId
    : `dl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const historyBase = {
    url: payload.url,
    playlistUrl: payload.playlistUrl || payload.url,
    audioUrl: payload.audioUrl || '',
    referer: payload.referer || '',
    filename: payload.filename || `${rawStem}.${payload.ext || DEFAULT_FILENAMES.FALLBACK_EXT}`,
    isStream: Boolean(payload.isStream || (payload.audioUrl && isHttpUrl(payload.audioUrl))),
    isMse: mseTarget,
    audioOnly: Boolean(payload.audioOnly),
    qualityPreference: typeof payload.qualityPreference === 'string' ? payload.qualityPreference : ''
  };

  try {
    const result = await dispatchDownloadMedia(payload, rawStem, requestId, mseTarget);
    await recordDownloadHistory({ ...historyBase, ok: true });
    return result;
  } catch (err) {
    if (!err || err.message !== 'DOWNLOAD_CANCELLED') {
      await recordDownloadHistory({
        ...historyBase,
        ok: false,
        error: err && err.message ? err.message : 'DOWNLOAD_FAILED'
      });
    }
    throw err;
  }
}

const CONTENT_SCRIPT_ALLOWED_MESSAGES = new Set([
  MESSAGE_TYPES.MSE_STREAM_UPDATED,
  MESSAGE_TYPES.DOWNLOAD_TWEET_VIDEO,
  MESSAGE_TYPES.DOWNLOAD_SITE_VIDEO,
  MESSAGE_TYPES.CANCEL_DOWNLOAD
]);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target === 'offscreen') {
    return false;
  }

  const fromExtension = isExtensionSender(sender);
  if (!fromExtension && !CONTENT_SCRIPT_ALLOWED_MESSAGES.has(message.type)) {
    sendResponse({ ok: false, error: 'FORBIDDEN_SENDER' });
    return false;
  }

  if (message.type === MESSAGE_TYPES.DOWNLOAD_PROGRESS && message.requestId) {
    const buildState = activeBuilds.get(message.requestId);
    if (buildState) {
      const wasLive = Boolean(buildState.isLiveRecord);
      buildState.done = message.done || 0;
      buildState.total = message.total || 0;
      buildState.isLiveRecord = Boolean(message.isLiveRecord);
      buildState.isTabCapture = Boolean(buildState.isTabCapture || message.isTabCapture);
      buildState.bytes = Number.isFinite(message.bytes) ? message.bytes : 0;
      if (buildState.tabId >= 0 && buildState.isLiveRecord && !wasLive) {
        refreshTabBadge(buildState.tabId).catch(() => {});
      }
      if (buildState.tabId >= 0 && chrome.tabs && typeof chrome.tabs.sendMessage === 'function') {
        chrome.tabs.sendMessage(buildState.tabId, {
          type: MESSAGE_TYPES.DOWNLOAD_PROGRESS,
          requestId: message.requestId,
          done: buildState.done,
          total: buildState.total,
          isLiveRecord: buildState.isLiveRecord,
          isTabCapture: Boolean(buildState.isTabCapture),
          bytes: buildState.bytes
        }).catch(() => {});
      }
    }
    return false;
  }

  if (message.type === MESSAGE_TYPES.GET_ACTIVE_BUILDS) {
    const builds = Array.from(activeBuilds.entries()).map(([requestId, build]) => ({
      requestId,
      url: build.url,
      done: build.done,
      total: build.total,
      isLiveRecord: Boolean(build.isLiveRecord),
      isTabCapture: Boolean(build.isTabCapture),
      bytes: Number.isFinite(build.bytes) ? build.bytes : 0
    }));
    if (builds.length > 0) {
      sendResponse({ ok: true, builds });
      return false;
    }
    chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH)]
    })
      .then(async (existingContexts) => {
        if (!existingContexts || existingContexts.length === 0) {
          sendResponse({ ok: true, builds: [] });
          return;
        }
        const offscreenState = await queryOffscreenActiveBuilds();
        sendResponse({
          ok: true,
          builds: offscreenState && Array.isArray(offscreenState.builds) ? offscreenState.builds : []
        });
      })
      .catch(() => sendResponse({ ok: true, builds: [] }));
    return true;
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
    inspectHlsStream(message.url, typeof message.referer === 'string' ? message.referer : '')
      .then((parsed) => sendResponse({ ok: true, ...parsed }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === MESSAGE_TYPES.MSE_STREAM_UPDATED && message.stream) {
    const tabId = sender && sender.tab ? sender.tab.id : -1;
    const frameId = sender && typeof sender.frameId === 'number' ? sender.frameId : 0;
    recordMseMedia(tabId, frameId, message.stream);
    return false;
  }

  if (message.type === MESSAGE_TYPES.CHECK_COMPANION) {
    checkCompanionStatus()
      .then((status) => sendResponse({ ok: true, ...status }))
      .catch((err) => sendResponse({ ok: false, available: false, error: err.message }));
    return true;
  }

  if (message.type === MESSAGE_TYPES.DOWNLOAD_WITH_COMPANION) {
    downloadWithCompanion(message.payload)
      .then((res) => sendResponse({ ok: true, ...res }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === MESSAGE_TYPES.DOWNLOAD_MEDIA) {
    handleDownloadMedia(message.payload)
      .then((res) => sendResponse({ ok: true, ...res }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === MESSAGE_TYPES.EXPORT_BATCH_ZIP) {
    handleExportBatchZip(message.payload)
      .then((res) => sendResponse({ ok: true, ...res }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === MESSAGE_TYPES.OPEN_STREAM_SAVER) {
    handleOpenStreamSaver(message.payload)
      .then((res) => sendResponse({ ok: true, ...res }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === MESSAGE_TYPES.DOWNLOAD_HLS_SUBTITLE) {
    handleDownloadHlsSubtitle(message.payload)
      .then((res) => sendResponse({ ok: true, ...res }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === MESSAGE_TYPES.CANCEL_COMPANION_DOWNLOAD) {
    cancelCompanionDownload(message.url);
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === MESSAGE_TYPES.CANCEL_DOWNLOAD) {
    if (!fromExtension) {
      const senderTabId = sender && sender.tab && typeof sender.tab.id === 'number' ? sender.tab.id : -1;
      const ownedBuild = typeof message.requestId === 'string' ? activeBuilds.get(message.requestId) : null;
      if (!ownedBuild || ownedBuild.tabId !== senderTabId) {
        sendResponse({ ok: false, error: 'FORBIDDEN_SENDER' });
        return false;
      }
    }
    cancelDownloadBuild(message.requestId)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === MESSAGE_TYPES.STOP_LIVE_RECORD) {
    stopLiveRecording(message.requestId)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === MESSAGE_TYPES.START_TAB_CAPTURE) {
    handleStartTabCapture(message.payload || {})
      .then((res) => sendResponse({ ok: true, ...res }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === MESSAGE_TYPES.STOP_TAB_CAPTURE) {
    stopLiveRecording(message.requestId)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === MESSAGE_TYPES.GET_DOWNLOAD_HISTORY) {
    getDownloadHistory()
      .then((history) => sendResponse({ ok: true, history }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === MESSAGE_TYPES.CLEAR_DOWNLOAD_HISTORY) {
    clearDownloadHistory()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === MESSAGE_TYPES.START_BATCH_QUEUE) {
    backgroundBatchQueue.start(message.items)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === MESSAGE_TYPES.CANCEL_BATCH_QUEUE) {
    backgroundBatchQueue.cancel()
      .then((snapshot) => sendResponse({ ok: true, ...snapshot }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === MESSAGE_TYPES.GET_BATCH_QUEUE_STATE) {
    sendResponse({ ok: true, ...backgroundBatchQueue.getSnapshot() });
    return false;
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

  if (message.type === MESSAGE_TYPES.DOWNLOAD_SITE_VIDEO) {
    const tabId = sender && sender.tab ? sender.tab.id : -1;
    if (tabId < 0) {
      sendResponse({ ok: false, error: 'NO_ACTIVE_TAB' });
      return false;
    }
    const pageUrl = sender && sender.tab && sender.tab.url ? sender.tab.url : '';
    handleSiteVideoDownload(tabId, message.payload || {}, pageUrl)
      .then((res) => sendResponse({ ok: true, ...res }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  return false;
});
