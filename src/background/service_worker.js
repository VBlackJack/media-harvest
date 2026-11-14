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
  IMAGE_EXTENSIONS,
  LIMITS,
  MEDIA_SOURCES,
  MEDIA_TYPES,
  MESSAGE_TYPES,
  OFFSCREEN_DOCUMENT_PATH,
  STORAGE_KEYS,
  VIDEO_EXTENSIONS
} from '../config/constants.js';
import { parseHlsPlaylist } from '../shared/hls_parser.js';
import {
  classifyMedia,
  deduplicateMedia,
  deriveFilenameStem,
  isHttpUrl,
  sanitizeFilename
} from '../shared/media_classifier.js';

const tabWriteQueues = new Map();
const downloadBlobMap = new Map();
let offscreenSetupPromise = null;

/**
 * Serializes async storage updates per tabId to prevent concurrent race conditions.
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
 * Builds the session storage key for a given tab ID.
 * @param {number} tabId
 * @returns {string}
 */
function tabStorageKey(tabId) {
  return `${STORAGE_KEYS.TAB_MEDIA_PREFIX}${tabId}`;
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
  });
}

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0 || details.statusCode >= 400) {
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

chrome.tabs.onRemoved.addListener((tabId) => {
  enqueueTabWrite(tabId, async () => {
    await chrome.storage.session.remove(tabStorageKey(tabId));
  });
});

/**
 * Ensures the offscreen document exists for HLS Blob creation.
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

  if (!offscreenSetupPromise) {
    offscreenSetupPromise = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_DOCUMENT_PATH,
        reasons: ['BLOBS'],
        justification: 'Assemble non-DRM HLS segments into a downloadable Blob URL.'
      })
      .finally(() => {
        offscreenSetupPromise = null;
      });
  }
  await offscreenSetupPromise;
}

chrome.downloads.onChanged.addListener((delta) => {
  if (!downloadBlobMap.has(delta.id)) {
    return;
  }
  const state = delta.state && delta.state.current;
  if (state === 'complete' || state === 'interrupted') {
    const blobUrl = downloadBlobMap.get(delta.id);
    downloadBlobMap.delete(delta.id);
    chrome.runtime.sendMessage({
      target: 'offscreen',
      type: MESSAGE_TYPES.OFFSCREEN_REVOKE_BLOB,
      blobUrl
    }).catch(() => {
      // Offscreen document may already be closed
    });
  }
});

/**
 * Scans the active tab DOM and combines results with captured network media.
 * @param {number} tabId
 * @param {string} tabUrl
 * @returns {Promise<object>}
 */
async function collectMediaForTab(tabId, tabUrl) {
  if (!isHttpUrl(tabUrl)) {
    throw new Error('RESTRICTED_PAGE');
  }

  const networkItems = await getTabNetworkMedia(tabId);
  let domResult = { pageTitle: '', pageUrl: tabUrl, hasBlobVideo: false, items: [] };

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['src/content/dom_scanner.js']
    });

    const scanConfig = {
      minImageDimensionPx: LIMITS.MIN_IMAGE_DIMENSION_PX,
      mediaTypes: {
        VIDEO: MEDIA_TYPES.VIDEO,
        IMAGE: MEDIA_TYPES.IMAGE,
        AUDIO: MEDIA_TYPES.AUDIO
      },
      sourceTag: MEDIA_SOURCES.DOM,
      directExtensions: [...VIDEO_EXTENSIONS, ...IMAGE_EXTENSIONS, ...AUDIO_EXTENSIONS]
    };

    const execResults = await chrome.scripting.executeScript({
      target: { tabId },
      func: (cfg) => (typeof window.__mediaHarvestScan === 'function' ? window.__mediaHarvestScan(cfg) : null),
      args: [scanConfig]
    });

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

  const merged = deduplicateMedia([...networkItems, ...normalizedDomItems]).map((item) => ({
    ...item,
    suggestedFilename: sanitizeFilename(
      deriveFilenameStem(item.url, item.title || domResult.pageTitle),
      item.ext
    )
  }));

  return {
    pageTitle: domResult.pageTitle,
    hasBlobVideo: domResult.hasBlobVideo,
    items: merged
  };
}

/**
 * Fetches and parses an HLS playlist so the UI can list variants and audio tracks.
 * @param {string} url
 * @returns {Promise<object>}
 */
async function inspectHlsStream(url) {
  const controller = new AbortController();
  const timerId = setTimeout(() => controller.abort(), LIMITS.FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const text = await response.text();
    return parseHlsPlaylist(text, url);
  } finally {
    clearTimeout(timerId);
  }
}

/**
 * Starts a download either directly or via HLS offscreen assembly.
 * @param {{ url: string, playlistUrl?: string, isStream?: boolean, filename: string, saveAs?: boolean }} payload
 * @returns {Promise<{ downloadId: number }>}
 */
async function handleDownloadMedia(payload) {
  if (!payload.isStream) {
    const downloadId = await chrome.downloads.download({
      url: payload.url,
      filename: payload.filename,
      saveAs: Boolean(payload.saveAs)
    });
    return { downloadId };
  }

  await ensureOffscreenDocument();
  const targetPlaylist = payload.playlistUrl || payload.url;
  const result = await chrome.runtime.sendMessage({
    target: 'offscreen',
    type: MESSAGE_TYPES.OFFSCREEN_BUILD_HLS_BLOB,
    playlistUrl: targetPlaylist,
    originalUrl: payload.url
  });

  if (!result || !result.ok) {
    throw new Error((result && result.error) || 'HLS_ERROR');
  }

  const finalFilename = sanitizeFilename(
    payload.filename.replace(/\.[^.]+$/, ''),
    result.outputExtension
  );
  const downloadId = await chrome.downloads.download({
    url: result.blobUrl,
    filename: finalFilename,
    saveAs: Boolean(payload.saveAs)
  });
  downloadBlobMap.set(downloadId, result.blobUrl);
  return { downloadId };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
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
    enqueueTabWrite(message.tabId, async () => {
      await chrome.storage.session.remove(tabStorageKey(message.tabId));
    })
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

  return false;
});
