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

import { DEFAULT_FILENAMES, LIMITS, MESSAGE_TYPES } from '../config/constants.js';
import { parseHlsPlaylist, selectBestVariant } from '../shared/hls_parser.js';

const activeBlobUrls = new Set();

/**
 * Fetches a URL with an explicit timeout signal.
 * @param {string} url
 * @param {'text' | 'arrayBuffer'} responseType
 * @returns {Promise<string | ArrayBuffer>}
 */
async function fetchWithTimeout(url, responseType) {
  const controller = new AbortController();
  const timerId = setTimeout(() => controller.abort(), LIMITS.FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return responseType === 'text' ? await response.text() : await response.arrayBuffer();
  } finally {
    clearTimeout(timerId);
  }
}

/**
 * Runs async tasks over an array with a bounded concurrency pool.
 * @template T, R
 * @param {Array<T>} items
 * @param {number} concurrency
 * @param {(item: T, index: number) => Promise<R>} worker
 * @returns {Promise<Array<R>>}
 */
async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  const runWorker = async () => {
    while (nextIndex < items.length) {
      const current = nextIndex;
      nextIndex += 1;
      results[current] = await worker(items[current], current);
    }
  };

  const poolSize = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: poolSize }, () => runWorker()));
  return results;
}

/**
 * Emits HLS segment download progress updates to any open UI listeners.
 * @param {string} itemUrl
 * @param {number} done
 * @param {number} total
 */
function notifyProgress(itemUrl, done, total) {
  chrome.runtime.sendMessage({
    type: MESSAGE_TYPES.DOWNLOAD_PROGRESS,
    url: itemUrl,
    done,
    total
  }).catch(() => {
    // Popup may be closed during background download
  });
}

/**
 * Fetches an HLS playlist (resolving master playlists if needed) and assembles a Blob URL.
 * Refuses encrypted/DRM-protected streams explicitly.
 * @param {string} playlistUrl
 * @param {string} originalUrl
 * @returns {Promise<{ blobUrl: string, outputExtension: string, byteLength: number }>}
 */
async function buildHlsBlob(playlistUrl, originalUrl) {
  let targetUrl = playlistUrl;
  let playlistText = await fetchWithTimeout(targetUrl, 'text');
  let parsed = parseHlsPlaylist(playlistText, targetUrl);

  if (parsed.encrypted) {
    throw new Error('ENCRYPTED_STREAM');
  }

  if (parsed.isMaster) {
    const best = selectBestVariant(parsed.variants);
    if (!best) {
      throw new Error('EMPTY_PLAYLIST');
    }
    targetUrl = best.url;
    playlistText = await fetchWithTimeout(targetUrl, 'text');
    parsed = parseHlsPlaylist(playlistText, targetUrl);
    if (parsed.encrypted) {
      throw new Error('ENCRYPTED_STREAM');
    }
  }

  if (parsed.segments.length === 0) {
    throw new Error('EMPTY_PLAYLIST');
  }

  const urlsToFetch = parsed.initSegmentUrl
    ? [parsed.initSegmentUrl, ...parsed.segments.map((s) => s.url)]
    : parsed.segments.map((s) => s.url);

  let completed = 0;
  const total = urlsToFetch.length;
  notifyProgress(originalUrl, completed, total);

  const buffers = await mapWithConcurrency(
    urlsToFetch,
    LIMITS.HLS_FETCH_CONCURRENCY,
    async (segUrl) => {
      const buf = await fetchWithTimeout(segUrl, 'arrayBuffer');
      completed += 1;
      notifyProgress(originalUrl, completed, total);
      return buf;
    }
  );

  const mimeType = parsed.outputExtension === DEFAULT_FILENAMES.HLS_FMP4_EXT
    ? 'video/mp4'
    : 'video/mp2t';
  const blob = new Blob(buffers, { type: mimeType });
  const blobUrl = URL.createObjectURL(blob);
  activeBlobUrls.add(blobUrl);

  return {
    blobUrl,
    outputExtension: parsed.outputExtension,
    byteLength: blob.size
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target !== 'offscreen') {
    return false;
  }

  if (message.type === MESSAGE_TYPES.OFFSCREEN_BUILD_HLS_BLOB) {
    buildHlsBlob(message.playlistUrl, message.originalUrl || message.playlistUrl)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => sendResponse({ ok: false, error: err.message || 'HLS_ERROR' }));
    return true;
  }

  if (message.type === MESSAGE_TYPES.OFFSCREEN_REVOKE_BLOB) {
    if (message.blobUrl && activeBlobUrls.has(message.blobUrl)) {
      URL.revokeObjectURL(message.blobUrl);
      activeBlobUrls.delete(message.blobUrl);
    }
    sendResponse({ ok: true });
    return false;
  }

  return false;
});
