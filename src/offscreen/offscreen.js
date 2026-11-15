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
  HLS_SUBTITLE_CONSTANTS,
  LIMITS,
  MESSAGE_TYPES,
  QUALITY_PREFERENCES
} from '../config/constants.js';
import { parseDashManifest } from '../shared/dash_parser.js';
import {
  CANCEL_REASON,
  fetchWithManagedTimeout,
  isDashDescriptor,
  looksLikeDashXml
} from '../shared/fetch_utils.js';
import {
  countTracksInInit,
  mergeFmp4VideoAndAudioParts,
  splitFmp4InitAndFragments
} from '../shared/fmp4_muxer.js';
import { parseHlsPlaylist, selectBestVariant } from '../shared/hls_parser.js';
import { classifyMseMime, extractUrlExtension, isHttpUrl } from '../shared/media_classifier.js';
import { clampInteger } from '../shared/settings.js';
import { transmuxTsSegmentsToMp4Parts } from '../shared/ts_transmuxer.js';

const activeBlobUrls = new Set();
const activeBuildControllers = new Map();
const activeMseAssemblies = new Map();

/**
 * Fetches a segment URL with optional HTTP Range support, enforcing the memory cap.
 * Caches full HTTP 200 responses per URL when a server ignores Range headers.
 * @param {string} url
 * @param {{ offset: number, length: number } | null} byteRange
 * @param {AbortSignal} cancelSignal
 * @param {Map<string, object>} rangeCacheByUrl
 * @param {{ bytes: number }} byteTracker
 * @returns {Promise<ArrayBuffer>}
 */
async function fetchSegmentBuffer(url, byteRange, cancelSignal, rangeCacheByUrl, byteTracker) {
  if (!byteRange) {
    const { buffer } = await fetchWithManagedTimeout(url, {
      responseMode: 'bufferWithStatus',
      cancelSignal,
      byteTracker
    });
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
      const { status, buffer } = await fetchWithManagedTimeout(url, {
        responseMode: 'bufferWithStatus',
        cancelSignal,
        headers,
        byteTracker
      });
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

  const { status, buffer } = await fetchWithManagedTimeout(url, {
    responseMode: 'bufferWithStatus',
    cancelSignal,
    headers,
    byteTracker
  });
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
 * @param {string} [preferredAudioUrl='']
 * @returns {Promise<{ format: 'hls' | 'dash', mediaPlaylist: object, audioPlaylist: object | null }>}
 */
async function resolveStreamPlan(
  masterOrMediaUrl,
  preferredVariantUrl,
  qualityPreference,
  cancelSignal,
  preferredAudioUrl = ''
) {
  const rootText = await fetchWithManagedTimeout(masterOrMediaUrl, {
    responseMode: 'text',
    cancelSignal
  });
  const looksDash = isDashDescriptor(masterOrMediaUrl) || looksLikeDashXml(rootText);

  if (looksDash) {
    const dashParsed = parseDashManifest(rootText, masterOrMediaUrl);
    if (dashParsed.encrypted) {
      throw new Error('ENCRYPTED_STREAM');
    }
    if (dashParsed.isDynamic) {
      throw new Error('LIVE_STREAM');
    }
    const chosenVariant = pickVariant(dashParsed.variants, preferredVariantUrl, qualityPreference);
    if (!chosenVariant || chosenVariant.segments.length === 0) {
      throw new Error('EMPTY_PLAYLIST');
    }
    const chosenAudio = (
      preferredAudioUrl
      && dashParsed.audioTracks.find((a) => a.url === preferredAudioUrl && a.segments.length > 0)
    ) || dashParsed.audioTracks.find((a) => a.segments.length > 0) || null;
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
  if (rootParsed.isDynamic) {
    throw new Error('LIVE_STREAM');
  }

  if (!rootParsed.isMaster) {
    return { format: 'hls', mediaPlaylist: rootParsed, audioPlaylist: null };
  }

  const chosenVariant = pickVariant(rootParsed.variants, preferredVariantUrl, qualityPreference);
  if (!chosenVariant) {
    throw new Error('EMPTY_PLAYLIST');
  }

  const videoText = await fetchWithManagedTimeout(chosenVariant.url, {
    responseMode: 'text',
    cancelSignal
  });
  const videoParsed = parseHlsPlaylist(videoText, chosenVariant.url);
  if (videoParsed.encrypted) {
    throw new Error('ENCRYPTED_STREAM');
  }
  if (videoParsed.isDynamic) {
    throw new Error('LIVE_STREAM');
  }

  let audioParsed = null;
  const matchingAudio = (
    preferredAudioUrl && rootParsed.audioTracks.find((a) => a.url === preferredAudioUrl)
  ) || (chosenVariant.audioGroup
    ? rootParsed.audioTracks.find((a) => a.groupId === chosenVariant.audioGroup) || null
    : null);

  if (matchingAudio && matchingAudio.url && matchingAudio.url !== chosenVariant.url) {
    const audioText = await fetchWithManagedTimeout(matchingAudio.url, {
      responseMode: 'text',
      cancelSignal
    });
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
 * Muxes segmented fMP4 video and audio buffers (init segment + fragments).
 * @param {Array<ArrayBuffer>} videoBuffers
 * @param {Array<ArrayBuffer>} audioBuffers
 * @returns {{ outputParts: Array<ArrayBuffer | Uint8Array>, outputExtension: string, mimeType: string }}
 */
function tryAssembleFmp4Parts(videoBuffers, audioBuffers) {
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

/**
 * Attempts to split and mux progressive single-file fMP4 video and audio streams.
 * @param {Array<ArrayBuffer>} videoBuffers
 * @param {Array<ArrayBuffer>} audioBuffers
 * @returns {{ outputParts: Array<ArrayBuffer | Uint8Array>, outputExtension: string, mimeType: string } | null}
 */
function tryAssembleProgressiveParts(videoBuffers, audioBuffers) {
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
  return null;
}

/**
 * Transmuxes MPEG-TS segments to MP4 and optionally muxes separate audio tracks.
 * @param {Array<ArrayBuffer>} videoBuffers
 * @param {Array<ArrayBuffer>} audioBuffers
 * @param {boolean} hasAudioBuffers
 * @param {boolean} hasInitAudio
 * @returns {{ outputParts: Array<ArrayBuffer | Uint8Array>, outputExtension: string, mimeType: string } | null}
 */
function tryAssembleTsParts(videoBuffers, audioBuffers, hasAudioBuffers, hasInitAudio) {
  try {
    const videoTransmuxed = transmuxTsSegmentsToMp4Parts(videoBuffers);
    if (
      hasAudioBuffers &&
      videoTransmuxed.initSegment &&
      countTracksInInit(videoTransmuxed.initSegment) === 1
    ) {
      try {
        const audioTransmuxed = hasInitAudio
          ? { initSegment: audioBuffers[0], dataChunks: audioBuffers.slice(1) }
          : transmuxTsSegmentsToMp4Parts(audioBuffers);
        if (
          audioTransmuxed.initSegment &&
          countTracksInInit(audioTransmuxed.initSegment) === 1 &&
          audioTransmuxed.dataChunks.length > 0
        ) {
          return {
            outputParts: mergeFmp4VideoAndAudioParts(
              videoTransmuxed.initSegment,
              videoTransmuxed.dataChunks,
              audioTransmuxed.initSegment,
              audioTransmuxed.dataChunks
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
    return null;
  }
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
  if (mediaPlaylist.outputExtension === 'webm') {
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
    return tryAssembleFmp4Parts(videoBuffers, audioBuffers);
  }

  if (
    mediaPlaylist.isProgressive &&
    audioPlaylist &&
    audioPlaylist.isProgressive &&
    videoBuffers.length === 1 &&
    audioBuffers.length === 1
  ) {
    const progressiveResult = tryAssembleProgressiveParts(videoBuffers, audioBuffers);
    if (progressiveResult) {
      return progressiveResult;
    }
  }

  if (!mediaPlaylist.initSegmentUrl && !mediaPlaylist.isProgressive) {
    const tsResult = tryAssembleTsParts(videoBuffers, audioBuffers, hasAudioBuffers, hasInitAudio);
    if (tsResult) {
      return tsResult;
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

  const concurrency = clampInteger(
    payload.concurrency,
    LIMITS.HLS_FETCH_CONCURRENCY,
    LIMITS.MIN_HLS_CONCURRENCY,
    LIMITS.MAX_HLS_CONCURRENCY
  );
  const qualityPreference = payload.qualityPreference || QUALITY_PREFERENCES.BEST;
  const preferredAudioUrl = typeof payload.audioUrl === 'string' ? payload.audioUrl : '';
  const buildController = new AbortController();
  activeBuildControllers.set(requestId, buildController);

  const fullBodyCache = new Map();
  const byteTracker = { bytes: 0 };

  try {
    const { mediaPlaylist, audioPlaylist } = await resolveStreamPlan(
      originalUrl,
      playlistUrl,
      qualityPreference,
      buildController.signal,
      preferredAudioUrl
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

/**
 * Merges WebVTT segment payloads while keeping a single leading WEBVTT header.
 * @param {Array<ArrayBuffer>} segmentBuffers
 * @returns {string}
 */
function mergeWebVttSegments(segmentBuffers) {
  const decoder = new TextDecoder('utf-8');
  const headerPrefix = HLS_SUBTITLE_CONSTANTS.WEBVTT_HEADER;
  const chunks = [];

  for (let i = 0; i < segmentBuffers.length; i += 1) {
    const raw = decoder.decode(segmentBuffers[i]).replace(/^\uFEFF/, '').trim();
    if (!raw) {
      continue;
    }
    if (chunks.length === 0) {
      const normalized = raw.startsWith(headerPrefix) ? raw : `${headerPrefix}\n\n${raw}`;
      chunks.push(normalized);
      continue;
    }
    const stripped = raw.replace(/^WEBVTT(?:[^\r\n]*)?(?:\r?\n)+/i, '').trim();
    if (stripped) {
      chunks.push(stripped);
    }
  }

  if (chunks.length === 0) {
    return `${headerPrefix}\n`;
  }
  return `${chunks.join('\n\n')}\n`;
}

/**
 * Fetches an HLS subtitle playlist or direct subtitle file and emits a downloadable Blob URL.
 * @param {{ subtitleUrl: string, requestId: string, concurrency?: number }} payload
 * @returns {Promise<{ blobUrl: string, outputExtension: string, byteLength: number }>}
 */
async function buildSubtitleBlob(payload) {
  const { subtitleUrl, requestId } = payload;
  if (!isHttpUrl(subtitleUrl)) {
    throw new Error('INVALID_URL');
  }

  const concurrency = clampInteger(
    payload.concurrency,
    LIMITS.HLS_FETCH_CONCURRENCY,
    LIMITS.MIN_HLS_CONCURRENCY,
    LIMITS.MAX_HLS_CONCURRENCY
  );
  const buildController = new AbortController();
  activeBuildControllers.set(requestId, buildController);
  const fullBodyCache = new Map();
  const byteTracker = { bytes: 0 };

  try {
    const manifestText = await fetchWithManagedTimeout(subtitleUrl, {
      responseMode: 'text',
      cancelSignal: buildController.signal
    });
    const isHlsSub = manifestText.trimStart().startsWith('#EXTM3U');
    let blob;
    let outputExtension = DEFAULT_FILENAMES.SUBTITLE_EXT;

    if (isHlsSub) {
      const parsed = parseHlsPlaylist(manifestText, subtitleUrl);
      if (parsed.encrypted) {
        throw new Error('ENCRYPTED_STREAM');
      }
      if (parsed.segments.length === 0) {
        throw new Error('EMPTY_PLAYLIST');
      }
      const segmentBuffers = await mapWithConcurrency(
        parsed.segments,
        concurrency,
        buildController.signal,
        (seg) => fetchSegmentBuffer(seg.url, seg.byteRange || null, buildController.signal, fullBodyCache, byteTracker)
      );
      if (buildController.signal.aborted && buildController.signal.reason === CANCEL_REASON) {
        throw new Error(CANCEL_REASON);
      }
      const mergedVtt = mergeWebVttSegments(segmentBuffers);
      blob = new Blob([mergedVtt], { type: 'text/vtt;charset=utf-8' });
    } else {
      const ext = extractUrlExtension(subtitleUrl);
      if (ext) {
        outputExtension = ext;
      }
      blob = new Blob([manifestText], { type: 'text/plain;charset=utf-8' });
    }

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

/**
 * Decodes a base64 chunk payload into a Uint8Array.
 * @param {string} base64
 * @returns {Uint8Array}
 */
function decodeBase64ToBytes(base64) {
  const binary = atob(base64 || '');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Concatenates a list of Uint8Array chunks into a single ArrayBuffer.
 * @param {Array<Uint8Array>} chunks
 * @returns {ArrayBuffer}
 */
function concatUint8Arrays(chunks) {
  let total = 0;
  for (const chunk of chunks) {
    total += chunk.byteLength;
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged.buffer;
}

/**
 * Handles chunked MSE stream assembly and optional dual-track fMP4 muxing.
 * @param {object} message
 * @returns {{ ok: boolean, blobUrl?: string, outputExtension?: string, byteLength?: number, error?: string }}
 */
function handleMseBlobMessage(message) {
  const requestId = message.requestId;
  if (!requestId) {
    return { ok: false, error: 'INVALID_REQUEST' };
  }

  if (message.action === 'abort') {
    activeMseAssemblies.delete(requestId);
    return { ok: true };
  }

  if (message.action === 'append') {
    let session = activeMseAssemblies.get(requestId);
    if (!session) {
      session = { videoChunks: [], audioChunks: [], totalBytes: 0 };
      activeMseAssemblies.set(requestId, session);
    }
    const bytes = decodeBase64ToBytes(message.chunkBase64);
    if (session.totalBytes + bytes.byteLength > LIMITS.MAX_HLS_BUFFER_BYTES) {
      activeMseAssemblies.delete(requestId);
      return { ok: false, error: 'STREAM_TOO_LARGE' };
    }
    if (message.track === 'audio') {
      session.audioChunks.push(bytes);
    } else {
      session.videoChunks.push(bytes);
    }
    session.totalBytes += bytes.byteLength;
    return { ok: true };
  }

  if (message.action === 'finalize') {
    const session = activeMseAssemblies.get(requestId);
    activeMseAssemblies.delete(requestId);
    if (!session || (session.videoChunks.length === 0 && session.audioChunks.length === 0)) {
      return { ok: false, error: 'MSE_NOT_FOUND' };
    }

    const videoMime = message.videoMime || '';
    const audioMime = message.audioMime || '';
    const hasVideo = session.videoChunks.length > 0;
    const hasAudio = session.audioChunks.length > 0;
    const isWebm = videoMime.toLowerCase().includes('webm') || audioMime.toLowerCase().includes('webm');

    let outputParts = null;
    let outputExtension = DEFAULT_FILENAMES.HLS_FMP4_EXT;
    let mimeType = 'video/mp4';

    if (hasVideo && hasAudio && !isWebm) {
      const videoBuf = concatUint8Arrays(session.videoChunks);
      const audioBuf = concatUint8Arrays(session.audioChunks);
      const muxed = tryAssembleProgressiveParts([videoBuf], [audioBuf]);
      if (muxed) {
        outputParts = muxed.outputParts;
        outputExtension = muxed.outputExtension;
        mimeType = muxed.mimeType;
      } else {
        outputParts = [videoBuf];
      }
    } else if (hasVideo) {
      outputParts = session.videoChunks;
      const info = classifyMseMime(videoMime);
      outputExtension = info.ext;
      mimeType = isWebm ? 'video/webm' : 'video/mp4';
    } else {
      outputParts = session.audioChunks;
      const info = classifyMseMime(audioMime);
      outputExtension = info.ext;
      mimeType = isWebm ? 'audio/webm' : 'audio/mp4';
    }

    const blob = new Blob(outputParts, { type: mimeType });
    session.videoChunks.length = 0;
    session.audioChunks.length = 0;
    const blobUrl = URL.createObjectURL(blob);
    activeBlobUrls.add(blobUrl);
    return {
      ok: true,
      blobUrl,
      outputExtension,
      byteLength: blob.size
    };
  }

  return { ok: false, error: 'INVALID_ACTION' };
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
      audioUrl: message.audioUrl || '',
      requestId,
      concurrency: message.concurrency,
      qualityPreference: message.qualityPreference
    })
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => sendResponse({ ok: false, error: err.message || 'HLS_ERROR' }));
    return true;
  }

  if (message.type === MESSAGE_TYPES.OFFSCREEN_BUILD_SUBTITLE_BLOB) {
    const requestId = message.requestId || `sub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    buildSubtitleBlob({
      subtitleUrl: message.subtitleUrl,
      requestId,
      concurrency: message.concurrency
    })
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => sendResponse({ ok: false, error: err.message || 'HLS_ERROR' }));
    return true;
  }

  if (message.type === MESSAGE_TYPES.OFFSCREEN_BUILD_MSE_BLOB) {
    sendResponse(handleMseBlobMessage(message));
    return false;
  }

  if (message.type === MESSAGE_TYPES.OFFSCREEN_CANCEL_BUILD) {
    if (message.requestId) {
      activeMseAssemblies.delete(message.requestId);
      const controller = activeBuildControllers.get(message.requestId);
      if (controller) {
        controller.abort(CANCEL_REASON);
      }
    } else {
      activeMseAssemblies.clear();
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
