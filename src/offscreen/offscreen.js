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
import { mergeFmp4VideoAndAudio } from '../shared/fmp4_muxer.js';
import { parseHlsPlaylist, selectBestVariant } from '../shared/hls_parser.js';
import { isHttpUrl } from '../shared/media_classifier.js';
import { transmuxTsSegmentsToMp4 } from '../shared/ts_transmuxer.js';

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
 * Resolves a media playlist URL (if master) and optional matching audio track URL.
 * @param {string} masterOrMediaUrl
 * @param {string} preferredVariantUrl
 * @returns {Promise<{ mediaPlaylist: object, audioPlaylist: object | null }>}
 */
async function resolvePlaylists(masterOrMediaUrl, preferredVariantUrl) {
  const rootText = await fetchWithTimeout(masterOrMediaUrl, 'text');
  const rootParsed = parseHlsPlaylist(rootText, masterOrMediaUrl);
  if (rootParsed.encrypted) {
    throw new Error('ENCRYPTED_STREAM');
  }

  if (!rootParsed.isMaster) {
    return { mediaPlaylist: rootParsed, audioPlaylist: null };
  }

  const chosenVariant = rootParsed.variants.find((v) => v.url === preferredVariantUrl)
    || selectBestVariant(rootParsed.variants);
  if (!chosenVariant) {
    throw new Error('EMPTY_PLAYLIST');
  }

  const videoText = await fetchWithTimeout(chosenVariant.url, 'text');
  const videoParsed = parseHlsPlaylist(videoText, chosenVariant.url);
  if (videoParsed.encrypted) {
    throw new Error('ENCRYPTED_STREAM');
  }

  let audioParsed = null;
  const matchingAudio = chosenVariant.audioGroup
    ? rootParsed.audioTracks.find((a) => a.groupId === chosenVariant.audioGroup) || null
    : null;

  if (matchingAudio && matchingAudio.url && matchingAudio.url !== chosenVariant.url) {
    const audioText = await fetchWithTimeout(matchingAudio.url, 'text');
    const candidate = parseHlsPlaylist(audioText, matchingAudio.url);
    if (!candidate.encrypted && candidate.segments.length > 0) {
      audioParsed = candidate;
    }
  }

  return { mediaPlaylist: videoParsed, audioPlaylist: audioParsed };
}

/**
 * Fetches an HLS playlist (resolving master + separate audio if present) and builds a Blob URL.
 * Refuses encrypted/DRM-protected streams explicitly.
 * @param {string} playlistUrl
 * @param {string} originalUrl
 * @returns {Promise<{ blobUrl: string, outputExtension: string, byteLength: number }>}
 */
async function buildHlsBlob(playlistUrl, originalUrl) {
  if (!isHttpUrl(originalUrl) || !isHttpUrl(playlistUrl)) {
    throw new Error('INVALID_URL');
  }
  const { mediaPlaylist, audioPlaylist } = await resolvePlaylists(originalUrl, playlistUrl);
  if (mediaPlaylist.segments.length === 0) {
    throw new Error('EMPTY_PLAYLIST');
  }

  const videoUrls = mediaPlaylist.initSegmentUrl
    ? [mediaPlaylist.initSegmentUrl, ...mediaPlaylist.segments.map((s) => s.url)]
    : mediaPlaylist.segments.map((s) => s.url);

  const shouldMuxFmp4Audio = Boolean(
    audioPlaylist && mediaPlaylist.initSegmentUrl && audioPlaylist.initSegmentUrl
  );
  const audioUrls = shouldMuxFmp4Audio
    ? [audioPlaylist.initSegmentUrl, ...audioPlaylist.segments.map((s) => s.url)]
    : [];

  let completed = 0;
  const total = videoUrls.length + audioUrls.length;
  notifyProgress(originalUrl, completed, total);

  const fetchTracked = async (url) => {
    const buf = await fetchWithTimeout(url, 'arrayBuffer');
    completed += 1;
    notifyProgress(originalUrl, completed, total);
    return buf;
  };

  const videoBuffers = await mapWithConcurrency(videoUrls, LIMITS.HLS_FETCH_CONCURRENCY, fetchTracked);
  const audioBuffers = audioUrls.length > 0
    ? await mapWithConcurrency(audioUrls, LIMITS.HLS_FETCH_CONCURRENCY, fetchTracked)
    : [];

  let outputParts = videoBuffers;
  let outputExtension = mediaPlaylist.outputExtension;
  let mimeType = outputExtension === DEFAULT_FILENAMES.HLS_FMP4_EXT ? 'video/mp4' : 'video/mp2t';

  if (
    shouldMuxFmp4Audio &&
    videoBuffers.length > 1 &&
    audioBuffers.length > 1
  ) {
    const mergedMp4 = mergeFmp4VideoAndAudio(
      videoBuffers[0],
      videoBuffers.slice(1),
      audioBuffers[0],
      audioBuffers.slice(1)
    );
    outputParts = [mergedMp4];
    outputExtension = DEFAULT_FILENAMES.HLS_FMP4_EXT;
    mimeType = 'video/mp4';
  } else if (!mediaPlaylist.initSegmentUrl) {
    try {
      const mp4Buffer = transmuxTsSegmentsToMp4(videoBuffers);
      outputParts = [mp4Buffer];
      outputExtension = DEFAULT_FILENAMES.HLS_FMP4_EXT;
      mimeType = 'video/mp4';
    } catch {
      // Fall back to raw .ts segments if codec is unsupported by mux.js
    }
  }

  const blob = new Blob(outputParts, { type: mimeType });
  videoBuffers.length = 0;
  audioBuffers.length = 0;
  const blobUrl = URL.createObjectURL(blob);
  activeBlobUrls.add(blobUrl);

  return {
    blobUrl,
    outputExtension,
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
