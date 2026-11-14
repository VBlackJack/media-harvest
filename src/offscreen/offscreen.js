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

import { DEFAULT_FILENAMES, LIMITS, MESSAGE_TYPES, QUALITY_PREFERENCES } from '../config/constants.js';
import { parseDashManifest } from '../shared/dash_parser.js';
import {
  countTracksInInit,
  mergeFmp4VideoAndAudioParts,
  splitFmp4InitAndFragments
} from '../shared/fmp4_muxer.js';
import { parseHlsPlaylist, selectBestVariant } from '../shared/hls_parser.js';
import { extractUrlExtension, isHttpUrl } from '../shared/media_classifier.js';
import { transmuxTsSegmentsToMp4Parts } from '../shared/ts_transmuxer.js';

const activeBlobUrls = new Set();
const activeBuildControllers = new Map();

const CANCEL_REASON = 'DOWNLOAD_CANCELLED';

/**
 * Normalizes HLS fetch concurrency within configured bounds.
 * @param {number} value
 * @returns {number}
 */
function clampConcurrency(value) {
  const num = Number.parseInt(value, 10);
  if (!Number.isFinite(num)) {
    return LIMITS.HLS_FETCH_CONCURRENCY;
  }
  return Math.max(LIMITS.MIN_HLS_CONCURRENCY, Math.min(LIMITS.MAX_HLS_CONCURRENCY, num));
}

/**
 * Fetches text or binary bytes with combined timeout and user cancellation signals.
 * @param {string} url
 * @param {'text' | 'buffer'} responseMode
 * @param {AbortSignal | null} cancelSignal
 * @param {Record<string, string>} [extraHeaders]
 * @param {{ bytes: number }} [byteTracker]
 * @returns {Promise<string | { status: number, buffer: ArrayBuffer }>}
 */
async function fetchWithSignal(url, responseMode, cancelSignal, extraHeaders, byteTracker) {
  if (!isHttpUrl(url)) {
    throw new Error('INVALID_URL');
  }
  if (cancelSignal && cancelSignal.aborted) {
    if (cancelSignal.reason === CANCEL_REASON) {
      throw new Error(CANCEL_REASON);
    }
    throw new Error('BUILD_ABORTED');
  }

  const controller = new AbortController();
  let abortedByTimeout = false;
  let abortedByCancel = false;

  const onCancel = () => {
    abortedByCancel = true;
    controller.abort();
  };
  if (cancelSignal) {
    cancelSignal.addEventListener('abort', onCancel, { once: true });
  }
  const timerId = setTimeout(() => {
    abortedByTimeout = true;
    controller.abort();
  }, LIMITS.FETCH_TIMEOUT_MS);

  try {
    const options = extraHeaders
      ? { signal: controller.signal, headers: extraHeaders }
      : { signal: controller.signal };
    const response = await fetch(url, options);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    if (responseMode === 'text') {
      return await response.text();
    }

    const declaredLength = Number.parseInt(response.headers.get('content-length'), 10);
    if (
      byteTracker &&
      Number.isFinite(declaredLength) &&
      declaredLength > 0 &&
      byteTracker.bytes + declaredLength > LIMITS.MAX_HLS_BUFFER_BYTES
    ) {
      throw new Error('STREAM_TOO_LARGE');
    }

    const buffer = await response.arrayBuffer();
    return { status: response.status, buffer };
  } catch (err) {
    if (abortedByCancel || (cancelSignal && cancelSignal.aborted)) {
      if (cancelSignal && cancelSignal.reason === CANCEL_REASON) {
        throw new Error(CANCEL_REASON);
      }
      throw new Error('BUILD_ABORTED');
    }
    if (abortedByTimeout) {
      throw new Error('FETCH_TIMEOUT');
    }
    throw err;
  } finally {
    clearTimeout(timerId);
    if (cancelSignal) {
      cancelSignal.removeEventListener('abort', onCancel);
    }
  }
}

/**
 * Fetches a segment URL with optional HTTP Range support, enforcing the memory cap.
 * Caches full HTTP 200 responses per URL when a server ignores Range headers.
 * @param {string} url
 * @param {{ offset: number, length: number } | null} byteRange
 * @param {AbortSignal} cancelSignal
 * @param {Map<string, Promise<ArrayBuffer>>} fullBodyCache
 * @param {{ bytes: number }} byteTracker
 * @returns {Promise<ArrayBuffer>}
 */
async function fetchSegmentBuffer(url, byteRange, cancelSignal, rangeCacheByUrl, byteTracker) {
  const trackAndCheckBytes = (addedBytes) => {
    byteTracker.bytes += addedBytes;
    if (byteTracker.bytes > LIMITS.MAX_HLS_BUFFER_BYTES) {
      throw new Error('STREAM_TOO_LARGE');
    }
  };

  if (!byteRange) {
    const { buffer } = await fetchWithSignal(url, 'buffer', cancelSignal, undefined, byteTracker);
    trackAndCheckBytes(buffer.byteLength);
    return buffer;
  }

  let cacheEntry = rangeCacheByUrl.get(url);
  if (cacheEntry && cacheEntry.mode === 'probe') {
    await cacheEntry.promise;
    cacheEntry = rangeCacheByUrl.get(url);
  }

  if (cacheEntry && cacheEntry.mode === '200') {
    return cacheEntry.buffer.slice(byteRange.offset, byteRange.offset + byteRange.length);
  }

  const headers = {
    Range: `bytes=${byteRange.offset}-${byteRange.offset + byteRange.length - 1}`
  };

  if (!cacheEntry) {
    let resolveProbe;
    const probePromise = new Promise((res) => {
      resolveProbe = res;
    });
    rangeCacheByUrl.set(url, { mode: 'probe', promise: probePromise });

    try {
      const { status, buffer } = await fetchWithSignal(url, 'buffer', cancelSignal, headers, byteTracker);
      trackAndCheckBytes(buffer.byteLength);
      if (status === 200) {
        rangeCacheByUrl.set(url, { mode: '200', buffer });
        resolveProbe();
        return buffer.slice(byteRange.offset, byteRange.offset + byteRange.length);
      }
      rangeCacheByUrl.set(url, { mode: '206' });
      resolveProbe();
      return buffer;
    } catch (err) {
      rangeCacheByUrl.delete(url);
      resolveProbe();
      throw err;
    }
  }

  const { status, buffer } = await fetchWithSignal(url, 'buffer', cancelSignal, headers, byteTracker);
  trackAndCheckBytes(buffer.byteLength);
  if (status === 200) {
    rangeCacheByUrl.set(url, { mode: '200', buffer });
    return buffer.slice(byteRange.offset, byteRange.offset + byteRange.length);
  }
  return buffer;
}

/**
 * Runs async tasks over an array with a bounded concurrency pool.
 * @template T, R
 * @param {Array<T>} items
 * @param {number} concurrency
 * @param {AbortSignal} cancelSignal
 * @param {(item: T, index: number) => Promise<R>} worker
 * @returns {Promise<Array<R>>}
 */
async function mapWithConcurrency(items, concurrency, cancelSignal, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  const runWorker = async () => {
    while (nextIndex < items.length) {
      if (cancelSignal && cancelSignal.aborted) {
        if (cancelSignal.reason === CANCEL_REASON) {
          throw new Error(CANCEL_REASON);
        }
        return;
      }
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
 * Emits stream segment download progress updates to open UI listeners.
 * @param {string} requestId
 * @param {string} itemUrl
 * @param {number} done
 * @param {number} total
 */
function notifyProgress(requestId, itemUrl, done, total) {
  chrome.runtime.sendMessage({
    type: MESSAGE_TYPES.DOWNLOAD_PROGRESS,
    requestId,
    url: itemUrl,
    done,
    total
  }).catch(() => {
    // Popup may be closed during background download
  });
}

/**
 * Selects a variant respecting explicit user choice or default quality preference.
 * @param {Array<object>} variants
 * @param {string} preferredVariantUrl
 * @param {string} qualityPreference
 * @returns {object | null}
 */
function pickVariant(variants, preferredVariantUrl, qualityPreference) {
  if (!Array.isArray(variants) || variants.length === 0) {
    return null;
  }
  const explicit = variants.find((v) => v.url === preferredVariantUrl);
  if (explicit) {
    return explicit;
  }
  if (qualityPreference === QUALITY_PREFERENCES.LOWEST) {
    return [...variants].sort((a, b) => (a.bandwidth || 0) - (b.bandwidth || 0))[0];
  }
  return selectBestVariant(variants);
}

/**
 * Resolves a stream URL (HLS or DASH) into concrete video and optional audio segment lists.
 * @param {string} masterOrMediaUrl
 * @param {string} preferredVariantUrl
 * @param {string} qualityPreference
 * @param {AbortSignal} cancelSignal
 * @returns {Promise<{ format: 'hls' | 'dash', mediaPlaylist: object, audioPlaylist: object | null }>}
 */
async function resolveStreamPlan(masterOrMediaUrl, preferredVariantUrl, qualityPreference, cancelSignal) {
  const rootText = await fetchWithSignal(masterOrMediaUrl, 'text', cancelSignal);
  const looksDash = extractUrlExtension(masterOrMediaUrl) === 'mpd' ||
    /<MPD[\s>]/i.test(rootText.slice(0, 512));

  if (looksDash) {
    const dashParsed = parseDashManifest(rootText, masterOrMediaUrl);
    if (dashParsed.encrypted) {
      throw new Error('ENCRYPTED_STREAM');
    }
    if (dashParsed.isDynamic) {
      throw new Error('EMPTY_PLAYLIST');
    }
    const chosenVariant = pickVariant(dashParsed.variants, preferredVariantUrl, qualityPreference);
    if (!chosenVariant || chosenVariant.segments.length === 0) {
      throw new Error('EMPTY_PLAYLIST');
    }
    const chosenAudio = dashParsed.audioTracks.find((a) => a.segments.length > 0) || null;
    const isWebm = chosenVariant.mimeType === 'video/webm';
    return {
      format: 'dash',
      mediaPlaylist: {
        ...chosenVariant,
        initSegmentByteRange: null,
        outputExtension: isWebm ? 'webm' : DEFAULT_FILENAMES.HLS_FMP4_EXT
      },
      audioPlaylist: !isWebm && chosenAudio
        ? { ...chosenAudio, initSegmentByteRange: null }
        : null
    };
  }

  const rootParsed = parseHlsPlaylist(rootText, masterOrMediaUrl);
  if (rootParsed.encrypted) {
    throw new Error('ENCRYPTED_STREAM');
  }

  if (!rootParsed.isMaster) {
    return { format: 'hls', mediaPlaylist: rootParsed, audioPlaylist: null };
  }

  const chosenVariant = pickVariant(rootParsed.variants, preferredVariantUrl, qualityPreference);
  if (!chosenVariant) {
    throw new Error('EMPTY_PLAYLIST');
  }

  const videoText = await fetchWithSignal(chosenVariant.url, 'text', cancelSignal);
  const videoParsed = parseHlsPlaylist(videoText, chosenVariant.url);
  if (videoParsed.encrypted) {
    throw new Error('ENCRYPTED_STREAM');
  }

  let audioParsed = null;
  const matchingAudio = chosenVariant.audioGroup
    ? rootParsed.audioTracks.find((a) => a.groupId === chosenVariant.audioGroup) || null
    : null;

  if (matchingAudio && matchingAudio.url && matchingAudio.url !== chosenVariant.url) {
    const audioText = await fetchWithSignal(matchingAudio.url, 'text', cancelSignal);
    const candidate = parseHlsPlaylist(audioText, matchingAudio.url);
    if (!candidate.encrypted && candidate.segments.length > 0) {
      audioParsed = candidate;
    }
  }

  return { format: 'hls', mediaPlaylist: videoParsed, audioPlaylist: audioParsed };
}

/**
 * Builds ordered segment request descriptors from a resolved playlist descriptor.
 * @param {object} playlist
 * @returns {Array<{ url: string, byteRange: { offset: number, length: number } | null }>}
 */
function buildSegmentRequests(playlist) {
  const requests = [];
  if (playlist.initSegmentUrl) {
    requests.push({
      url: playlist.initSegmentUrl,
      byteRange: playlist.initSegmentByteRange || null
    });
  }
  for (const seg of playlist.segments) {
    requests.push({
      url: seg.url,
      byteRange: seg.byteRange || null
    });
  }
  return requests;
}

/**
 * Muxes downloaded video and optional audio buffers using zero-copy part arrays where possible.
 * @param {object} mediaPlaylist
 * @param {object | null} audioPlaylist
 * @param {Array<ArrayBuffer>} videoBuffers
 * @param {Array<ArrayBuffer>} audioBuffers
 * @returns {{ outputParts: Array<ArrayBuffer | Uint8Array>, outputExtension: string, mimeType: string }}
 */
function assembleOutputParts(mediaPlaylist, audioPlaylist, videoBuffers, audioBuffers) {
  const isWebm = mediaPlaylist.outputExtension === 'webm';
  if (isWebm) {
    return {
      outputParts: videoBuffers,
      outputExtension: 'webm',
      mimeType: 'video/webm'
    };
  }

  const hasInitVideo = Boolean(mediaPlaylist.initSegmentUrl && videoBuffers.length > 1);
  const hasInitAudio = Boolean(audioPlaylist && audioPlaylist.initSegmentUrl && audioBuffers.length > 1);
  const hasAudioBuffers = Boolean(audioPlaylist && audioBuffers.length > 0);

  if (hasInitVideo && hasInitAudio) {
    return {
      outputParts: mergeFmp4VideoAndAudioParts(
        videoBuffers[0],
        videoBuffers.slice(1),
        audioBuffers[0],
        audioBuffers.slice(1)
      ),
      outputExtension: DEFAULT_FILENAMES.HLS_FMP4_EXT,
      mimeType: 'video/mp4'
    };
  }

  // Progressive single-file DASH/fMP4 video + audio muxing
  if (
    mediaPlaylist.isProgressive &&
    audioPlaylist &&
    audioPlaylist.isProgressive &&
    videoBuffers.length === 1 &&
    audioBuffers.length === 1
  ) {
    try {
      const videoSplit = splitFmp4InitAndFragments(videoBuffers[0]);
      const audioSplit = splitFmp4InitAndFragments(audioBuffers[0]);
      if (
        countTracksInInit(videoSplit.initSegment) === 1 &&
        countTracksInInit(audioSplit.initSegment) === 1 &&
        videoSplit.fragments.length > 0 &&
        audioSplit.fragments.length > 0
      ) {
        return {
          outputParts: mergeFmp4VideoAndAudioParts(
            videoSplit.initSegment,
            videoSplit.fragments,
            audioSplit.initSegment,
            audioSplit.fragments
          ),
          outputExtension: DEFAULT_FILENAMES.HLS_FMP4_EXT,
          mimeType: 'video/mp4'
        };
      }
    } catch {
      // Fall back to video-only buffer when progressive stream is not fragmented MP4
    }
  }

  // MPEG-TS / ADTS HLS path (with optional separate audio muxing via mux.js)
  if (!mediaPlaylist.initSegmentUrl && !mediaPlaylist.isProgressive) {
    try {
      const videoTransmuxed = transmuxTsSegmentsToMp4Parts(videoBuffers);
      if (
        hasAudioBuffers &&
        videoTransmuxed.initSegment &&
        countTracksInInit(videoTransmuxed.initSegment) === 1
      ) {
        try {
          let audioInit = null;
          let audioChunks = [];
          if (hasInitAudio) {
            audioInit = audioBuffers[0];
            audioChunks = audioBuffers.slice(1);
          } else {
            const audioTransmuxed = transmuxTsSegmentsToMp4Parts(audioBuffers);
            audioInit = audioTransmuxed.initSegment;
            audioChunks = audioTransmuxed.dataChunks;
          }

          if (audioInit && countTracksInInit(audioInit) === 1 && audioChunks.length > 0) {
            return {
              outputParts: mergeFmp4VideoAndAudioParts(
                videoTransmuxed.initSegment,
                videoTransmuxed.dataChunks,
                audioInit,
                audioChunks
              ),
              outputExtension: DEFAULT_FILENAMES.HLS_FMP4_EXT,
              mimeType: 'video/mp4'
            };
          }
        } catch {
          // Fall back to transmuxed video-only when separate audio cannot be muxed
        }
      }

      return {
        outputParts: videoTransmuxed.parts,
        outputExtension: DEFAULT_FILENAMES.HLS_FMP4_EXT,
        mimeType: 'video/mp4'
      };
    } catch {
      // Fall back to raw .ts segments if codec is unsupported by mux.js
    }
  }

  const outputExtension = mediaPlaylist.outputExtension || DEFAULT_FILENAMES.HLS_TS_EXT;
  const mimeType = outputExtension === DEFAULT_FILENAMES.HLS_FMP4_EXT ? 'video/mp4' : 'video/mp2t';
  return {
    outputParts: videoBuffers,
    outputExtension,
    mimeType
  };
}

/**
 * Fetches an HLS or DASH stream, muxes segments into a Blob URL, and enforces caps/cancellation.
 * @param {{ playlistUrl: string, originalUrl: string, requestId: string, concurrency?: number, qualityPreference?: string }} payload
 * @returns {Promise<{ blobUrl: string, outputExtension: string, byteLength: number }>}
 */
async function buildStreamBlob(payload) {
  const { playlistUrl, originalUrl, requestId } = payload;
  if (!isHttpUrl(originalUrl) || !isHttpUrl(playlistUrl)) {
    throw new Error('INVALID_URL');
  }

  const concurrency = clampConcurrency(payload.concurrency);
  const qualityPreference = payload.qualityPreference || QUALITY_PREFERENCES.BEST;
  const buildController = new AbortController();
  activeBuildControllers.set(requestId, buildController);

  const fullBodyCache = new Map();
  const byteTracker = { bytes: 0 };

  try {
    const { mediaPlaylist, audioPlaylist } = await resolveStreamPlan(
      originalUrl,
      playlistUrl,
      qualityPreference,
      buildController.signal
    );
    if (mediaPlaylist.segments.length === 0) {
      throw new Error('EMPTY_PLAYLIST');
    }

    const videoRequests = buildSegmentRequests(mediaPlaylist);
    const shouldFetchAudio = Boolean(
      audioPlaylist &&
      (
        (mediaPlaylist.initSegmentUrl && audioPlaylist.initSegmentUrl) ||
        (!mediaPlaylist.initSegmentUrl && !mediaPlaylist.isProgressive) ||
        (mediaPlaylist.isProgressive && audioPlaylist.isProgressive)
      )
    );
    const audioRequests = shouldFetchAudio ? buildSegmentRequests(audioPlaylist) : [];

    let completed = 0;
    const total = videoRequests.length + audioRequests.length;
    notifyProgress(requestId, originalUrl, completed, total);

    const fetchTracked = async (req) => {
      try {
        const buf = await fetchSegmentBuffer(
          req.url,
          req.byteRange,
          buildController.signal,
          fullBodyCache,
          byteTracker
        );
        completed += 1;
        notifyProgress(requestId, originalUrl, completed, total);
        return buf;
      } catch (err) {
        if (err && err.message === 'STREAM_TOO_LARGE' && !buildController.signal.aborted) {
          buildController.abort('STREAM_TOO_LARGE');
        }
        throw err;
      }
    };

    const videoBuffers = await mapWithConcurrency(
      videoRequests,
      concurrency,
      buildController.signal,
      fetchTracked
    );
    const audioBuffers = audioRequests.length > 0
      ? await mapWithConcurrency(audioRequests, concurrency, buildController.signal, fetchTracked)
      : [];

    if (buildController.signal.aborted && buildController.signal.reason === CANCEL_REASON) {
      throw new Error(CANCEL_REASON);
    }

    const { outputParts, outputExtension, mimeType } = assembleOutputParts(
      mediaPlaylist,
      audioPlaylist,
      videoBuffers,
      audioBuffers
    );

    const blob = new Blob(outputParts, { type: mimeType });
    videoBuffers.length = 0;
    audioBuffers.length = 0;
    outputParts.length = 0;
    fullBodyCache.clear();

    const blobUrl = URL.createObjectURL(blob);
    activeBlobUrls.add(blobUrl);

    return {
      blobUrl,
      outputExtension,
      byteLength: blob.size
    };
  } finally {
    fullBodyCache.clear();
    activeBuildControllers.delete(requestId);
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target !== 'offscreen') {
    return false;
  }

  if (message.type === MESSAGE_TYPES.OFFSCREEN_BUILD_HLS_BLOB) {
    const requestId = message.requestId || `build_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    buildStreamBlob({
      playlistUrl: message.playlistUrl,
      originalUrl: message.originalUrl || message.playlistUrl,
      requestId,
      concurrency: message.concurrency,
      qualityPreference: message.qualityPreference
    })
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => sendResponse({ ok: false, error: err.message || 'HLS_ERROR' }));
    return true;
  }

  if (message.type === MESSAGE_TYPES.OFFSCREEN_CANCEL_BUILD) {
    if (message.requestId) {
      const controller = activeBuildControllers.get(message.requestId);
      if (controller) {
        controller.abort(CANCEL_REASON);
      }
    } else {
      for (const controller of activeBuildControllers.values()) {
        controller.abort(CANCEL_REASON);
      }
    }
    sendResponse({ ok: true });
    return false;
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
