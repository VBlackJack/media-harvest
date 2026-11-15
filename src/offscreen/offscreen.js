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
  DEFAULT_FILENAMES,
  HLS_SUBTITLE_CONSTANTS,
  IMAGE_CONVERT_FORMATS,
  LIMITS,
  MESSAGE_TYPES,
  QUALITY_PREFERENCES,
  ZIP_RENAME_MODES
} from '../config/constants.js';
import { parseDashManifest } from '../shared/dash_parser.js';
import {
  decodeBase64DataUri,
  decryptAes128Segment,
  importAes128Key,
  isBase64DataUri,
  resolveSegmentIv
} from '../shared/hls_crypto.js';
import {
  CANCEL_REASON,
  fetchWithManagedTimeout,
  isDashDescriptor,
  looksLikeDashXml,
  runWithConcurrency
} from '../shared/fetch_utils.js';
import {
  countTracksInInit,
  extractAudioOnlyFromFmp4Parts,
  mergeFmp4VideoAndAudioParts,
  splitFmp4InitAndFragments
} from '../shared/fmp4_muxer.js';
import { parseHlsPlaylist, selectBestVariant } from '../shared/hls_parser.js';
import {
  classifyMseMime,
  extractUrlExtension,
  isHttpUrl,
  isRasterImageDataUrl,
  isSvgDataUrl
} from '../shared/media_classifier.js';
import { clampInteger } from '../shared/settings.js';
import {
  decodeSvgDataUrl,
  extractSymbolFromSvgSprite,
  optimizeSvgMarkup,
  splitSvgSpriteUrl
} from '../shared/svg_utils.js';
import { transmuxTsSegmentsToMp4Parts } from '../shared/ts_transmuxer.js';
import { encodePcmWav } from '../shared/wav_encoder.js';
import { muxOpusPacketsToOgg } from '../shared/ogg_opus_muxer.js';
import { buildZipBlobAsync, resolveZipEntryFilename } from '../shared/zip_builder.js';

const activeBlobUrls = new Set();
const activeBuildControllers = new Map();
const activeLiveRecorders = new Map();
const activeTabCaptures = new Map();
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
      byteTracker,
      retries: LIMITS.SEGMENT_FETCH_RETRIES
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
        byteTracker,
        retries: LIMITS.SEGMENT_FETCH_RETRIES
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
 * Checks whether an HLS playlist uses unsupported/DRM encryption rather than clear AES-128.
 * @param {object} parsed
 * @returns {boolean}
 */
function isBlockedPlaylistEncryption(parsed) {
  return Boolean(parsed && (parsed.drmEncrypted || (parsed.encrypted && !parsed.decryptableAes128)));
}

/**
 * Fetches or decodes and caches a 16-byte AES-128 CryptoKey by URI for a single build.
 * @param {string} keyUrl
 * @param {Map<string, Promise<CryptoKey>>} keyCacheByUrl
 * @param {AbortSignal} cancelSignal
 * @returns {Promise<CryptoKey>}
 */
function resolveCachedCryptoKey(keyUrl, keyCacheByUrl, cancelSignal) {
  let cached = keyCacheByUrl.get(keyUrl);
  if (cached) {
    return cached;
  }
  const loadPromise = (async () => {
    const rawKey = isBase64DataUri(keyUrl)
      ? decodeBase64DataUri(keyUrl)
      : await fetchWithManagedTimeout(keyUrl, {
        responseMode: 'buffer',
        cancelSignal
      });
    return importAes128Key(rawKey);
  })().catch((err) => {
    keyCacheByUrl.delete(keyUrl);
    throw err;
  });
  keyCacheByUrl.set(keyUrl, loadPromise);
  return loadPromise;
}

/**
 * Decrypts a fetched segment buffer when an AES-128 key descriptor is attached.
 * @param {ArrayBuffer} buffer
 * @param {{ key?: { method: string, keyUrl: string, ivHex: string } | null, sequenceNumber?: number }} req
 * @param {Map<string, Promise<CryptoKey>>} keyCacheByUrl
 * @param {AbortSignal} cancelSignal
 * @returns {Promise<ArrayBuffer>}
 */
async function maybeDecryptSegment(buffer, req, keyCacheByUrl, cancelSignal) {
  if (!req || !req.key || !req.key.keyUrl) {
    return buffer;
  }
  const cryptoKey = await resolveCachedCryptoKey(req.key.keyUrl, keyCacheByUrl, cancelSignal);
  const iv = resolveSegmentIv(req.key.ivHex, req.sequenceNumber || 0);
  return decryptAes128Segment(buffer, cryptoKey, iv);
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
function notifyProgress(requestId, itemUrl, done, total, extra = {}) {
  chrome.runtime.sendMessage({
    type: MESSAGE_TYPES.DOWNLOAD_PROGRESS,
    requestId,
    url: itemUrl,
    done,
    total,
    ...extra
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
  preferredAudioUrl = '',
  options = {}
) {
  const allowLiveHls = Boolean(options && options.allowLiveHls);
  const allowLiveDash = Boolean(options && options.allowLiveDash);
  const rootText = await fetchWithManagedTimeout(masterOrMediaUrl, {
    responseMode: 'text',
    cancelSignal,
    retries: LIMITS.SEGMENT_FETCH_RETRIES
  });
  const looksDash = isDashDescriptor(masterOrMediaUrl) || looksLikeDashXml(rootText);

  if (looksDash) {
    const dashParsed = parseDashManifest(rootText, masterOrMediaUrl);
    if (dashParsed.encrypted) {
      throw new Error('ENCRYPTED_STREAM');
    }
    if (dashParsed.isDynamic && !allowLiveDash) {
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
        isDynamic: Boolean(dashParsed.isDynamic),
        initSegmentByteRange: null,
        outputExtension: isWebm ? 'webm' : DEFAULT_FILENAMES.HLS_FMP4_EXT
      },
      audioPlaylist: !isWebm && chosenAudio
        ? { ...chosenAudio, initSegmentByteRange: null }
        : null,
      videoPlaylistUrl: masterOrMediaUrl.split('#')[0],
      audioPlaylistUrl: '',
      selectedVariantId: chosenVariant.id || '',
      selectedAudioId: chosenAudio && chosenAudio.id ? chosenAudio.id : ''
    };
  }

  const rootParsed = parseHlsPlaylist(rootText, masterOrMediaUrl);
  if (isBlockedPlaylistEncryption(rootParsed)) {
    throw new Error('ENCRYPTED_STREAM');
  }
  if (rootParsed.isDynamic && !allowLiveHls) {
    throw new Error('LIVE_STREAM');
  }

  if (!rootParsed.isMaster) {
    return {
      format: 'hls',
      mediaPlaylist: rootParsed,
      audioPlaylist: null,
      videoPlaylistUrl: masterOrMediaUrl,
      audioPlaylistUrl: ''
    };
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
  if (isBlockedPlaylistEncryption(videoParsed)) {
    throw new Error('ENCRYPTED_STREAM');
  }
  if (videoParsed.isDynamic && !allowLiveHls) {
    throw new Error('LIVE_STREAM');
  }

  let audioParsed = null;
  let audioPlaylistUrl = '';
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
    if (!isBlockedPlaylistEncryption(candidate) && candidate.segments.length > 0) {
      audioParsed = candidate;
      audioPlaylistUrl = matchingAudio.url;
    }
  }

  return {
    format: 'hls',
    mediaPlaylist: videoParsed,
    audioPlaylist: audioParsed,
    videoPlaylistUrl: chosenVariant.url,
    audioPlaylistUrl
  };
}

/**
 * Builds ordered segment request descriptors from a resolved playlist descriptor.
 * @param {object} playlist
 * @returns {Array<{ url: string, byteRange: { offset: number, length: number } | null, key?: object | null, sequenceNumber?: number }>}
 */
function buildSegmentRequests(playlist) {
  const requests = [];
  if (playlist.initSegmentUrl) {
    requests.push({
      url: playlist.initSegmentUrl,
      byteRange: playlist.initSegmentByteRange || null,
      key: null,
      sequenceNumber: 0
    });
  }
  for (let i = 0; i < playlist.segments.length; i += 1) {
    const seg = playlist.segments[i];
    requests.push({
      url: seg.url,
      byteRange: seg.byteRange || null,
      key: seg.key || null,
      sequenceNumber: Number.isFinite(seg.sequenceNumber) ? seg.sequenceNumber : i
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
 * Collects zero-based segment indices marked with HLS discontinuity tags.
 * @param {object} playlist
 * @returns {Array<number>}
 */
function collectDiscontinuityIndices(playlist) {
  if (!playlist || !Array.isArray(playlist.segments)) {
    return [];
  }
  const indices = [];
  for (let i = 0; i < playlist.segments.length; i += 1) {
    if (playlist.segments[i] && playlist.segments[i].discontinuity) {
      indices.push(i);
    }
  }
  return indices;
}

/**
 * Transmuxes MPEG-TS segments to MP4 and optionally muxes separate audio tracks.
 * @param {Array<ArrayBuffer>} videoBuffers
 * @param {Array<ArrayBuffer>} audioBuffers
 * @param {boolean} hasAudioBuffers
 * @param {boolean} hasInitAudio
 * @param {Array<number>} [discontinuityIndices=[]]
 * @returns {{ outputParts: Array<ArrayBuffer | Uint8Array>, outputExtension: string, mimeType: string } | null}
 */
function tryAssembleTsParts(videoBuffers, audioBuffers, hasAudioBuffers, hasInitAudio, discontinuityIndices = []) {
  try {
    const videoTransmuxed = transmuxTsSegmentsToMp4Parts(videoBuffers, undefined, { discontinuityIndices });
    if (
      hasAudioBuffers &&
      videoTransmuxed.initSegment &&
      countTracksInInit(videoTransmuxed.initSegment) === 1
    ) {
      try {
        const audioTransmuxed = hasInitAudio
          ? { initSegment: audioBuffers[0], dataChunks: audioBuffers.slice(1) }
          : transmuxTsSegmentsToMp4Parts(audioBuffers, undefined, { discontinuityIndices });
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
    const tsResult = tryAssembleTsParts(
      videoBuffers,
      audioBuffers,
      hasAudioBuffers,
      hasInitAudio,
      collectDiscontinuityIndices(mediaPlaylist)
    );
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
 * Assembles audio-only buffers into a standalone audio container (.m4a or .webm).
 * @param {object} audioPlaylist
 * @param {Array<ArrayBuffer>} audioBuffers
 * @returns {{ outputParts: Array<ArrayBuffer | Uint8Array>, outputExtension: string, mimeType: string }}
 */
function assembleAudioOnlyParts(audioPlaylist, audioBuffers) {
  const isWebm = audioPlaylist.mimeType === 'audio/webm' || audioPlaylist.outputExtension === 'webm';
  if (isWebm) {
    return {
      outputParts: audioBuffers,
      outputExtension: 'webm',
      mimeType: 'audio/webm'
    };
  }
  if (!audioPlaylist.initSegmentUrl && !audioPlaylist.isProgressive) {
    try {
      const transmuxed = transmuxTsSegmentsToMp4Parts(audioBuffers);
      return {
        outputParts: transmuxed.parts,
        outputExtension: DEFAULT_FILENAMES.AUDIO_M4A_EXT,
        mimeType: 'audio/mp4'
      };
    } catch {
      // Fall back to concatenated fMP4/AAC bytes when TS transmuxer cannot split audio packets
    }
  }
  return {
    outputParts: audioBuffers,
    outputExtension: DEFAULT_FILENAMES.AUDIO_M4A_EXT,
    mimeType: 'audio/mp4'
  };
}

/**
 * Extracts standalone AAC/MP4 audio from a muxed single-playlist fMP4 or MPEG-TS stream.
 * @param {object} mediaPlaylist
 * @param {Array<ArrayBuffer>} videoBuffers
 * @returns {{ outputParts: Array<Uint8Array>, outputExtension: string, mimeType: string }}
 */
function assembleMuxedAudioOnlyParts(mediaPlaylist, videoBuffers) {
  if (mediaPlaylist.outputExtension === 'webm') {
    throw new Error('NO_AUDIO_TRACK');
  }
  if (!mediaPlaylist.initSegmentUrl && !mediaPlaylist.isProgressive) {
    const transmuxed = transmuxTsSegmentsToMp4Parts(videoBuffers, undefined, {
      discontinuityIndices: collectDiscontinuityIndices(mediaPlaylist)
    });
    if (!transmuxed.initSegment) {
      throw new Error('NO_AUDIO_TRACK');
    }
    return {
      outputParts: extractAudioOnlyFromFmp4Parts(transmuxed.initSegment, transmuxed.dataChunks),
      outputExtension: DEFAULT_FILENAMES.AUDIO_M4A_EXT,
      mimeType: 'audio/mp4'
    };
  }
  const split = splitFmp4InitAndFragments(videoBuffers[0]);
  const fragments = [...split.fragments, ...videoBuffers.slice(1)];
  return {
    outputParts: extractAudioOnlyFromFmp4Parts(split.initSegment, fragments),
    outputExtension: DEFAULT_FILENAMES.AUDIO_M4A_EXT,
    mimeType: 'audio/mp4'
  };
}

/**
 * Fetches an HLS or DASH stream, muxes segments into a Blob URL, and enforces caps/cancellation.
 * @param {{ playlistUrl: string, originalUrl: string, requestId: string, concurrency?: number, qualityPreference?: string, audioUrl?: string, audioOnly?: boolean }} payload
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
  const audioOnly = Boolean(payload.audioOnly);
  const buildController = new AbortController();
  activeBuildControllers.set(requestId, buildController);

  const fullBodyCache = new Map();
  const keyCacheByUrl = new Map();
  const byteTracker = { bytes: 0 };

  try {
    const { mediaPlaylist, audioPlaylist } = await resolveStreamPlan(
      originalUrl,
      playlistUrl,
      qualityPreference,
      buildController.signal,
      preferredAudioUrl
    );
    const hasSeparateAudio = Boolean(
      audioPlaylist && Array.isArray(audioPlaylist.segments) && audioPlaylist.segments.length > 0
    );
    if (!hasSeparateAudio && mediaPlaylist.segments.length === 0) {
      throw new Error('EMPTY_PLAYLIST');
    }

    const extractFromMuxed = audioOnly && !hasSeparateAudio;
    const videoRequests = audioOnly && hasSeparateAudio ? [] : buildSegmentRequests(mediaPlaylist);
    const shouldFetchAudio = (audioOnly && hasSeparateAudio) || Boolean(
      hasSeparateAudio &&
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
        const rawBuf = await fetchSegmentBuffer(
          req.url,
          req.byteRange,
          buildController.signal,
          fullBodyCache,
          byteTracker
        );
        const buf = await maybeDecryptSegment(
          rawBuf,
          req,
          keyCacheByUrl,
          buildController.signal
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

    const videoBuffers = videoRequests.length > 0
      ? await mapWithConcurrency(
          videoRequests,
          concurrency,
          buildController.signal,
          fetchTracked
        )
      : [];
    const audioBuffers = audioRequests.length > 0
      ? await mapWithConcurrency(audioRequests, concurrency, buildController.signal, fetchTracked)
      : [];

    if (buildController.signal.aborted && buildController.signal.reason === CANCEL_REASON) {
      throw new Error(CANCEL_REASON);
    }

    let assembled;
    if (extractFromMuxed) {
      assembled = assembleMuxedAudioOnlyParts(mediaPlaylist, videoBuffers);
    } else if (audioOnly) {
      assembled = assembleAudioOnlyParts(audioPlaylist, audioBuffers);
    } else {
      assembled = assembleOutputParts(
        mediaPlaylist,
        audioPlaylist,
        videoBuffers,
        audioBuffers
      );
    }
    const { outputParts, outputExtension, mimeType } = assembled;

    let finalBlob;
    let finalExtension = outputExtension;
    if (
      audioOnly
      && (payload.audioFormat === AUDIO_EXPORT_FORMATS.WAV || payload.audioFormat === AUDIO_EXPORT_FORMATS.OPUS)
    ) {
      const decodedResult = await decodeMediaPartsToAudioBlob(outputParts, payload.audioFormat);
      finalBlob = decodedResult.blob;
      finalExtension = decodedResult.extension;
    } else {
      finalBlob = new Blob(outputParts, { type: mimeType });
    }
    videoBuffers.length = 0;
    audioBuffers.length = 0;
    outputParts.length = 0;
    fullBodyCache.clear();
    keyCacheByUrl.clear();

    const blobUrl = URL.createObjectURL(finalBlob);
    activeBlobUrls.add(blobUrl);

    return {
      blobUrl,
      outputExtension: finalExtension,
      byteLength: finalBlob.size
    };
  } finally {
    fullBodyCache.clear();
    keyCacheByUrl.clear();
    activeBuildControllers.delete(requestId);
  }
}

/**
 * Waits for the next live HLS playlist poll unless stopped or cancelled earlier.
 * @param {number} delayMs
 * @param {{ stopped: boolean, wakeUp: Function | null }} recorderState
 * @param {AbortSignal} cancelSignal
 * @returns {Promise<void>}
 */
function waitForLivePollDelay(delayMs, recorderState, cancelSignal) {
  if (recorderState.stopped || (cancelSignal && cancelSignal.aborted)) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      recorderState.wakeUp = null;
      if (cancelSignal && typeof cancelSignal.removeEventListener === 'function') {
        cancelSignal.removeEventListener('abort', finish);
      }
      resolve();
    };
    recorderState.wakeUp = finish;
    if (cancelSignal && typeof cancelSignal.addEventListener === 'function') {
      cancelSignal.addEventListener('abort', finish, { once: true });
    }
    timer = setTimeout(finish, delayMs);
  });
}

/**
 * Fetches unseen segments (and init segment once) from a polled HLS playlist into an accumulation array.
 * @param {object} playlist
 * @param {Set<string>} seenKeys
 * @param {Array<ArrayBuffer>} targetBuffers
 * @param {{ initLoaded: boolean }} initState
 * @param {number} concurrency
 * @param {AbortSignal} cancelSignal
 * @param {Map<string, object>} fullBodyCache
 * @param {Map<string, Promise<CryptoKey>>} keyCacheByUrl
 * @param {{ bytes: number }} byteTracker
 * @returns {Promise<number>}
 */
async function appendUnseenPlaylistSegments(
  playlist,
  seenKeys,
  targetBuffers,
  initState,
  concurrency,
  cancelSignal,
  fullBodyCache,
  keyCacheByUrl,
  byteTracker
) {
  if (!playlist || !Array.isArray(playlist.segments)) {
    return 0;
  }
  if (playlist.initSegmentUrl && !initState.initLoaded) {
    const initBuf = await fetchSegmentBuffer(
      playlist.initSegmentUrl,
      playlist.initSegmentByteRange || null,
      cancelSignal,
      fullBodyCache,
      byteTracker
    );
    targetBuffers.push(initBuf);
    initState.initLoaded = true;
  }

  const pending = [];
  for (let i = 0; i < playlist.segments.length; i += 1) {
    const seg = playlist.segments[i];
    const br = seg.byteRange ? `${seg.byteRange.offset}-${seg.byteRange.length}` : '';
    const key = `${seg.url}#${br}`;
    if (seenKeys.has(key)) {
      continue;
    }
    pending.push({
      key,
      req: {
        url: seg.url,
        byteRange: seg.byteRange || null,
        key: seg.key || null,
        sequenceNumber: Number.isFinite(seg.sequenceNumber) ? seg.sequenceNumber : i
      }
    });
  }
  if (pending.length === 0) {
    return 0;
  }

  const downloaded = await mapWithConcurrency(
    pending,
    concurrency,
    cancelSignal,
    async (entry) => {
      const rawBuf = await fetchSegmentBuffer(
        entry.req.url,
        entry.req.byteRange,
        cancelSignal,
        fullBodyCache,
        byteTracker
      );
      return maybeDecryptSegment(rawBuf, entry.req, keyCacheByUrl, cancelSignal);
    }
  );

  for (let i = 0; i < pending.length; i += 1) {
    seenKeys.add(pending[i].key);
    targetBuffers.push(downloaded[i]);
  }
  return downloaded.length;
}

/**
 * Records a live HLS stream (DVR mode) until stopped, ended, or reaching buffer cap, then exports MP4.
 * @param {{ playlistUrl: string, originalUrl: string, requestId: string, concurrency?: number, qualityPreference?: string, audioUrl?: string, pollIntervalMs?: number }} payload
 * @returns {Promise<{ blobUrl: string, outputExtension: string, byteLength: number }>}
 */
async function recordLiveHlsBlob(payload) {
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
  const recorderState = { stopped: false, wakeUp: null };
  activeBuildControllers.set(requestId, buildController);
  activeLiveRecorders.set(requestId, recorderState);

  const fullBodyCache = new Map();
  const keyCacheByUrl = new Map();
  const byteTracker = { bytes: 0 };
  const videoBuffers = [];
  const audioBuffers = [];
  const seenVideoKeys = new Set();
  const seenAudioKeys = new Set();
  const videoInitState = { initLoaded: false };
  const audioInitState = { initLoaded: false };
  let recordedSegments = 0;

  try {
    const initialPlan = await resolveStreamPlan(
      originalUrl,
      playlistUrl,
      qualityPreference,
      buildController.signal,
      preferredAudioUrl,
      { allowLiveHls: true, allowLiveDash: true }
    );
    if (initialPlan.format !== 'hls' && initialPlan.format !== 'dash') {
      throw new Error('LIVE_STREAM');
    }

    let latestMediaPlaylist = initialPlan.mediaPlaylist;
    let latestAudioPlaylist = initialPlan.audioPlaylist;
    const isDashStream = initialPlan.format === 'dash';
    const videoPlaylistUrl = initialPlan.videoPlaylistUrl || playlistUrl;
    const audioPlaylistUrl = initialPlan.audioPlaylistUrl || '';

    notifyProgress(requestId, originalUrl, 0, 0, { isLiveRecord: true, bytes: 0 });

    for (let pollIndex = 0; !recorderState.stopped; pollIndex += 1) {
      if (buildController.signal.aborted && buildController.signal.reason === CANCEL_REASON) {
        throw new Error(CANCEL_REASON);
      }

      if (pollIndex > 0) {
        if (isDashStream) {
          const xmlText = await fetchWithManagedTimeout(videoPlaylistUrl, {
            responseMode: 'text',
            cancelSignal: buildController.signal,
            retries: LIMITS.SEGMENT_FETCH_RETRIES
          });
          const dashParsed = parseDashManifest(xmlText, videoPlaylistUrl);
          if (dashParsed.encrypted) {
            throw new Error('ENCRYPTED_STREAM');
          }
          const matchedVariant = (
            initialPlan.selectedVariantId
            && dashParsed.variants.find((v) => v.id === initialPlan.selectedVariantId)
          ) || pickVariant(dashParsed.variants, playlistUrl, qualityPreference);
          if (!matchedVariant || matchedVariant.segments.length === 0) {
            throw new Error('EMPTY_PLAYLIST');
          }
          const isWebm = matchedVariant.mimeType === 'video/webm';
          latestMediaPlaylist = {
            ...matchedVariant,
            isDynamic: Boolean(dashParsed.isDynamic),
            initSegmentByteRange: null,
            outputExtension: isWebm ? 'webm' : DEFAULT_FILENAMES.HLS_FMP4_EXT
          };
          const matchedAudio = !isWebm && (
            (initialPlan.selectedAudioId && dashParsed.audioTracks.find((a) => a.id === initialPlan.selectedAudioId && a.segments.length > 0))
            || (preferredAudioUrl && dashParsed.audioTracks.find((a) => a.url === preferredAudioUrl && a.segments.length > 0))
            || dashParsed.audioTracks.find((a) => a.segments.length > 0)
          );
          latestAudioPlaylist = matchedAudio ? { ...matchedAudio, initSegmentByteRange: null } : null;
        } else {
          const videoText = await fetchWithManagedTimeout(videoPlaylistUrl, {
            responseMode: 'text',
            cancelSignal: buildController.signal,
            retries: LIMITS.SEGMENT_FETCH_RETRIES
          });
          latestMediaPlaylist = parseHlsPlaylist(videoText, videoPlaylistUrl);
          if (isBlockedPlaylistEncryption(latestMediaPlaylist)) {
            throw new Error('ENCRYPTED_STREAM');
          }
          if (audioPlaylistUrl && latestAudioPlaylist) {
            const audioText = await fetchWithManagedTimeout(audioPlaylistUrl, {
              responseMode: 'text',
              cancelSignal: buildController.signal,
              retries: LIMITS.SEGMENT_FETCH_RETRIES
            });
            const parsedAudio = parseHlsPlaylist(audioText, audioPlaylistUrl);
            if (!isBlockedPlaylistEncryption(parsedAudio) && parsedAudio.segments.length > 0) {
              latestAudioPlaylist = parsedAudio;
            }
          }
        }
      }

      try {
        const addedVideo = await appendUnseenPlaylistSegments(
          latestMediaPlaylist,
          seenVideoKeys,
          videoBuffers,
          videoInitState,
          concurrency,
          buildController.signal,
          fullBodyCache,
          keyCacheByUrl,
          byteTracker
        );
        if (latestAudioPlaylist) {
          const trackAudioCompatible = (latestMediaPlaylist.initSegmentUrl && latestAudioPlaylist.initSegmentUrl)
            || (!latestMediaPlaylist.initSegmentUrl && !latestMediaPlaylist.isProgressive);
          if (trackAudioCompatible) {
            await appendUnseenPlaylistSegments(
              latestAudioPlaylist,
              seenAudioKeys,
              audioBuffers,
              audioInitState,
              concurrency,
              buildController.signal,
              fullBodyCache,
              keyCacheByUrl,
              byteTracker
            );
          }
        }
        recordedSegments += addedVideo;
        notifyProgress(requestId, originalUrl, recordedSegments, 0, {
          isLiveRecord: true,
          bytes: byteTracker.bytes
        });
      } catch (err) {
        if (err && err.message === 'STREAM_TOO_LARGE' && recordedSegments > 0) {
          recorderState.stopped = true;
          break;
        }
        throw err;
      }

      if (recorderState.stopped || !latestMediaPlaylist.isDynamic) {
        break;
      }

      const requestedPollMs = Number(payload.pollIntervalMs);
      const pollDelayMs = Number.isFinite(requestedPollMs) && requestedPollMs > 0
        ? Math.min(requestedPollMs, LIMITS.LIVE_RECORD_POLL_MAX_MS)
        : Math.min(
            Math.max((latestMediaPlaylist.targetDurationSec || 4) * 500, LIMITS.LIVE_RECORD_POLL_MIN_MS),
            LIMITS.LIVE_RECORD_POLL_MAX_MS
          );
      await waitForLivePollDelay(pollDelayMs, recorderState, buildController.signal);
    }

    if (buildController.signal.aborted && buildController.signal.reason === CANCEL_REASON) {
      throw new Error(CANCEL_REASON);
    }
    if (recordedSegments === 0) {
      throw new Error('EMPTY_PLAYLIST');
    }

    notifyProgress(requestId, originalUrl, recordedSegments, recordedSegments, {
      isLiveRecord: true,
      bytes: byteTracker.bytes
    });

    const { outputParts, outputExtension, mimeType } = assembleOutputParts(
      latestMediaPlaylist,
      latestAudioPlaylist,
      videoBuffers,
      audioBuffers
    );

    const blob = new Blob(outputParts, { type: mimeType });
    videoBuffers.length = 0;
    audioBuffers.length = 0;
    outputParts.length = 0;
    fullBodyCache.clear();
    keyCacheByUrl.clear();

    const blobUrl = URL.createObjectURL(blob);
    activeBlobUrls.add(blobUrl);

    return {
      blobUrl,
      outputExtension,
      byteLength: blob.size
    };
  } finally {
    fullBodyCache.clear();
    keyCacheByUrl.clear();
    activeLiveRecorders.delete(requestId);
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
  const keyCacheByUrl = new Map();
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
      if (isBlockedPlaylistEncryption(parsed)) {
        throw new Error('ENCRYPTED_STREAM');
      }
      if (parsed.segments.length === 0) {
        throw new Error('EMPTY_PLAYLIST');
      }
      const segmentBuffers = await mapWithConcurrency(
        parsed.segments,
        concurrency,
        buildController.signal,
        async (seg) => {
          const rawBuf = await fetchSegmentBuffer(
            seg.url,
            seg.byteRange || null,
            buildController.signal,
            fullBodyCache,
            byteTracker
          );
          return maybeDecryptSegment(rawBuf, seg, keyCacheByUrl, buildController.signal);
        }
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
    keyCacheByUrl.clear();
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
    const wantAudioOnly = Boolean(message.audioOnly);
    const isWebm = videoMime.toLowerCase().includes('webm') || audioMime.toLowerCase().includes('webm');

    let outputParts = null;
    let outputExtension = DEFAULT_FILENAMES.HLS_FMP4_EXT;
    let mimeType = 'video/mp4';

    if (wantAudioOnly) {
      if (hasAudio) {
        outputParts = session.audioChunks;
        const info = classifyMseMime(audioMime);
        outputExtension = info.ext;
        mimeType = isWebm ? 'audio/webm' : 'audio/mp4';
      } else if (hasVideo && !isWebm) {
        const videoBuf = concatUint8Arrays(session.videoChunks);
        const split = splitFmp4InitAndFragments(videoBuf);
        outputParts = extractAudioOnlyFromFmp4Parts(split.initSegment, split.fragments);
        outputExtension = DEFAULT_FILENAMES.AUDIO_M4A_EXT;
        mimeType = 'audio/mp4';
      } else {
        return { ok: false, error: 'NO_AUDIO_TRACK' };
      }
    } else if (hasVideo && hasAudio && !isWebm) {
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

/**
 * Decodes an SVG or raster image `data:image/...` URI into a Blob.
 * @param {string} dataUrl
 * @param {string} [defaultMime='image/svg+xml;charset=utf-8']
 * @returns {Blob}
 */
function imageDataUrlToBlob(dataUrl, defaultMime = 'image/svg+xml;charset=utf-8') {
  const commaIdx = dataUrl.indexOf(',');
  if (commaIdx < 0) {
    throw new Error('INVALID_URL');
  }
  const header = dataUrl.slice(0, commaIdx);
  const mimeMatch = header.match(/^data:([^;,]+)/i);
  const resolvedMime = mimeMatch ? mimeMatch[1] : defaultMime;
  const body = dataUrl.slice(commaIdx + 1);
  if (header.toLowerCase().includes(';base64')) {
    const bytes = decodeBase64ToBytes(body);
    return new Blob([bytes], { type: resolvedMime });
  }
  return new Blob([decodeURIComponent(body)], { type: resolvedMime });
}

/**
 * Loads an image Blob onto an HTMLImageElement for offscreen canvas rasterization.
 * @param {Blob} sourceBlob
 * @returns {Promise<HTMLImageElement>}
 */
function loadImageFromBlob(sourceBlob) {
  if (typeof Image !== 'function') {
    return Promise.reject(new Error('IMAGE_CONVERT_FAILED'));
  }
  const objectUrl = URL.createObjectURL(sourceBlob);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('IMAGE_CONVERT_FAILED'));
    };
    img.src = objectUrl;
  });
}

/**
 * Validates and clamps an explicit raster dimension value in pixels.
 * @param {number} rawSize
 * @returns {number}
 */
function resolveRasterSizePx(rawSize) {
  const num = Number(rawSize);
  if (!Number.isFinite(num) || num <= 0) {
    return 0;
  }
  return Math.max(64, Math.min(4096, Math.round(num)));
}

/**
 * Computes canvas export dimensions, scaling SVGs to the configured raster size.
 * @param {number} naturalWidth
 * @param {number} naturalHeight
 * @param {number} hintWidth
 * @param {number} hintHeight
 * @param {boolean} isSvg
 * @param {number} [rasterSizePx=0]
 * @param {number} [maxImageResizePx=0]
 * @returns {{ width: number, height: number }}
 */
function resolveConvertDimensions(
  naturalWidth,
  naturalHeight,
  hintWidth,
  hintHeight,
  isSvg,
  rasterSizePx = 0,
  maxImageResizePx = 0
) {
  let width = Math.round(naturalWidth || hintWidth || LIMITS.DEFAULT_SVG_RASTER_SIZE_PX);
  let height = Math.round(naturalHeight || hintHeight || LIMITS.DEFAULT_SVG_RASTER_SIZE_PX);
  if (width <= 0) {
    width = LIMITS.DEFAULT_SVG_RASTER_SIZE_PX;
  }
  if (height <= 0) {
    height = LIMITS.DEFAULT_SVG_RASTER_SIZE_PX;
  }
  if (isSvg) {
    const requestedSize = resolveRasterSizePx(rasterSizePx);
    const targetSize = requestedSize || LIMITS.DEFAULT_SVG_RASTER_SIZE_PX;
    const maxDim = Math.max(width, height);
    if (requestedSize > 0 || maxDim < targetSize) {
      const scale = targetSize / maxDim;
      width = Math.max(1, Math.round(width * scale));
      height = Math.max(1, Math.round(height * scale));
    }
  } else {
    const maxPx = Number(maxImageResizePx) > 0 ? Math.round(Number(maxImageResizePx)) : 0;
    if (maxPx > 0 && width > maxPx) {
      height = Math.max(1, Math.round((height * maxPx) / width));
      width = maxPx;
    }
  }
  return { width, height };
}

/**
 * Resamples a decoded AudioBuffer to 48 kHz when needed for Opus WebCodecs encoding.
 * @param {AudioBuffer} audioBuffer
 * @returns {Promise<AudioBuffer>}
 */
async function resampleAudioBufferTo48k(audioBuffer) {
  if (audioBuffer.sampleRate === 48000 || typeof OfflineAudioContext !== 'function') {
    return audioBuffer;
  }
  const targetLength = Math.max(1, Math.ceil((audioBuffer.length * 48000) / audioBuffer.sampleRate));
  const offline = new OfflineAudioContext(audioBuffer.numberOfChannels, targetLength, 48000);
  const source = offline.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(offline.destination);
  source.start(0);
  return offline.startRendering();
}

/**
 * Encodes a decoded AudioBuffer into compressed Ogg/Opus via WebCodecs AudioEncoder.
 * @param {AudioBuffer} audioBuffer
 * @returns {Promise<Blob>}
 */
async function encodeDecodedAudioToOpusBlob(audioBuffer) {
  if (typeof AudioEncoder !== 'function' || typeof AudioData !== 'function') {
    throw new Error('OPUS_ENCODER_UNAVAILABLE');
  }
  const prepared = await resampleAudioBufferTo48k(audioBuffer);
  const channels = Math.min(2, Math.max(1, prepared.numberOfChannels || 2));
  const totalFrames = prepared.length;
  const sampleRate = prepared.sampleRate || 48000;
  const packets = [];
  let encodeError = null;

  const encoder = new AudioEncoder({
    output: (chunk) => {
      const bytes = new Uint8Array(chunk.byteLength);
      chunk.copyTo(bytes);
      packets.push({
        data: bytes,
        durationUs: chunk.duration || 20000,
        timestampUs: chunk.timestamp || 0
      });
    },
    error: (err) => {
      encodeError = err || new Error('OPUS_ENCODE_FAILED');
    }
  });

  encoder.configure({
    codec: 'opus',
    sampleRate,
    numberOfChannels: channels,
    bitrate: 128000
  });

  const blockSize = 4800;
  const channelArrays = Array.from({ length: channels }, (_, ch) => prepared.getChannelData(ch));
  for (let offset = 0; offset < totalFrames; offset += blockSize) {
    if (encodeError) {
      break;
    }
    const count = Math.min(blockSize, totalFrames - offset);
    const planar = new Float32Array(count * channels);
    for (let ch = 0; ch < channels; ch += 1) {
      planar.set(channelArrays[ch].subarray(offset, offset + count), ch * count);
    }
    const audioData = new AudioData({
      format: 'f32-planar',
      sampleRate,
      numberOfFrames: count,
      numberOfChannels: channels,
      timestamp: Math.round((offset * 1000000) / sampleRate),
      data: planar
    });
    encoder.encode(audioData);
    audioData.close();
  }

  await encoder.flush();
  encoder.close();
  if (encodeError || packets.length === 0) {
    throw encodeError || new Error('OPUS_EMPTY_FRAMES');
  }

  const oggBytes = muxOpusPacketsToOgg(packets, { channels, sampleRate });
  return new Blob([oggBytes], { type: 'audio/ogg;codecs=opus' });
}

/**
 * Decodes assembled or fetched media bytes via Web Audio into either Ogg/Opus or PCM 16-bit WAV.
 * Falls back transparently to PCM WAV if Opus WebCodecs encoding is unavailable.
 * @param {Array<ArrayBuffer | Uint8Array>} mediaParts
 * @param {string} [targetFormat='wav']
 * @returns {Promise<{ blob: Blob, extension: string }>}
 */
async function decodeMediaPartsToAudioBlob(mediaParts, targetFormat = AUDIO_EXPORT_FORMATS.WAV) {
  const AudioCtx = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (typeof AudioCtx !== 'function') {
    throw new Error('NO_AUDIO_TRACK');
  }
  const sourceBlob = new Blob(mediaParts);
  const rawBuffer = await sourceBlob.arrayBuffer();
  const audioCtx = new AudioCtx();
  try {
    const decoded = await audioCtx.decodeAudioData(rawBuffer);
    if (targetFormat === AUDIO_EXPORT_FORMATS.OPUS) {
      try {
        const opusBlob = await encodeDecodedAudioToOpusBlob(decoded);
        return { blob: opusBlob, extension: DEFAULT_FILENAMES.AUDIO_OPUS_EXT };
      } catch {
        // Fallback to PCM WAV when AudioEncoder/Opus is unavailable
      }
    }
    const wavBytes = encodePcmWav(decoded);
    return { blob: new Blob([wavBytes], { type: 'audio/wav' }), extension: DEFAULT_FILENAMES.AUDIO_WAV_EXT };
  } catch {
    throw new Error('NO_AUDIO_TRACK');
  } finally {
    if (typeof audioCtx.close === 'function') {
      audioCtx.close().catch(() => {});
    }
  }
}

/**
 * Decodes assembled or fetched media bytes via Web Audio and encodes PCM 16-bit WAV.
 * @param {Array<ArrayBuffer | Uint8Array>} mediaParts
 * @returns {Promise<Blob>}
 */
async function decodeMediaPartsToWavBlob(mediaParts) {
  const { blob } = await decodeMediaPartsToAudioBlob(mediaParts, AUDIO_EXPORT_FORMATS.WAV);
  return blob;
}

/**
 * Fetches a direct HTTP media URL and decodes its audio track to PCM WAV or compact Ogg/Opus.
 * @param {{ targetUrl: string, audioFormat?: string, requestId: string }} payload
 * @returns {Promise<{ blobUrl: string, outputExtension: string, byteLength: number }>}
 */
async function decodeDirectMediaToWav(payload) {
  const targetUrl = typeof payload.targetUrl === 'string' ? payload.targetUrl : '';
  if (!isHttpUrl(targetUrl)) {
    throw new Error('INVALID_URL');
  }
  const targetFormat = payload.audioFormat === AUDIO_EXPORT_FORMATS.OPUS
    ? AUDIO_EXPORT_FORMATS.OPUS
    : AUDIO_EXPORT_FORMATS.WAV;
  const requestId = payload.requestId || `aud_${Date.now()}`;
  const buildController = new AbortController();
  activeBuildControllers.set(requestId, buildController);
  try {
    const buf = await fetchWithManagedTimeout(targetUrl, {
      responseMode: 'buffer',
      cancelSignal: buildController.signal,
      byteTracker: { bytes: 0 },
      retries: LIMITS.SEGMENT_FETCH_RETRIES
    });
    const { blob, extension } = await decodeMediaPartsToAudioBlob([buf], targetFormat);
    const blobUrl = URL.createObjectURL(blob);
    activeBlobUrls.add(blobUrl);
    return {
      blobUrl,
      outputExtension: extension,
      byteLength: blob.size
    };
  } finally {
    activeBuildControllers.delete(requestId);
  }
}

/**
 * Resolves and optimizes standalone SVG XML or extracts a symbol from an external sprite sheet.
 * @param {string} targetUrl
 * @param {string} symbolIdHint
 * @param {AbortSignal} cancelSignal
 * @returns {Promise<string>}
 */
async function resolveSvgSourceText(targetUrl, symbolIdHint, cancelSignal) {
  if (isSvgDataUrl(targetUrl)) {
    const decoded = decodeSvgDataUrl(targetUrl);
    return optimizeSvgMarkup(decoded) || decoded;
  }
  const { baseUrl, symbolId } = splitSvgSpriteUrl(targetUrl);
  const fetchUrl = baseUrl || targetUrl;
  const activeSymbolId = symbolIdHint || symbolId;
  const rawText = await fetchWithManagedTimeout(fetchUrl, {
    responseMode: 'text',
    cancelSignal,
    retries: LIMITS.SEGMENT_FETCH_RETRIES
  });
  if (activeSymbolId) {
    const extracted = extractSymbolFromSvgSprite(rawText, activeSymbolId);
    if (extracted) {
      return extracted;
    }
  }
  return optimizeSvgMarkup(rawText) || rawText;
}

/**
 * Fetches an external SVG sprite or file, isolates the requested `<symbol>`, and creates a Blob URL.
 * @param {{ targetUrl: string, symbolId?: string, requestId: string }} payload
 * @returns {Promise<{ blobUrl: string, outputExtension: string, byteLength: number }>}
 */
async function extractSvgSymbolBlob(payload) {
  const targetUrl = typeof payload.targetUrl === 'string' ? payload.targetUrl : '';
  if (!isHttpUrl(targetUrl) && !isSvgDataUrl(targetUrl)) {
    throw new Error('INVALID_URL');
  }
  const requestId = payload.requestId || `svg_${Date.now()}`;
  const buildController = new AbortController();
  activeBuildControllers.set(requestId, buildController);
  try {
    const svgText = await resolveSvgSourceText(targetUrl, payload.symbolId || '', buildController.signal);
    const outBlob = new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' });
    const blobUrl = URL.createObjectURL(outBlob);
    activeBlobUrls.add(blobUrl);
    return {
      blobUrl,
      outputExtension: DEFAULT_FILENAMES.SVG_EXT,
      byteLength: outBlob.size
    };
  } finally {
    activeBuildControllers.delete(requestId);
  }
}

/**
 * Fetches or decodes an image/SVG and rasterizes it to a PNG or JPG Blob.
 * @param {string} targetUrl
 * @param {string} targetFormat
 * @param {number} hintWidth
 * @param {number} hintHeight
 * @param {number} rasterSizePx
 * @param {AbortSignal} cancelSignal
 * @param {number} [jpgQualityPercent]
 * @param {string} [symbolIdHint]
 * @returns {Promise<Blob>}
 */
async function rasterizeImageToBlob(
  targetUrl,
  targetFormat,
  hintWidth,
  hintHeight,
  rasterSizePx,
  cancelSignal,
  jpgQualityPercent = LIMITS.DEFAULT_JPG_QUALITY_PERCENT,
  symbolIdHint = '',
  maxImageResizePx = 0
) {
  const { symbolId: urlSymbolId } = splitSvgSpriteUrl(targetUrl);
  const effectiveSymbolId = symbolIdHint || urlSymbolId;
  const isSvg = isSvgDataUrl(targetUrl)
    || extractUrlExtension(targetUrl) === DEFAULT_FILENAMES.SVG_EXT
    || Boolean(effectiveSymbolId);
  let sourceBlob;
  if (isSvg) {
    const svgMarkup = await resolveSvgSourceText(targetUrl, effectiveSymbolId, cancelSignal);
    sourceBlob = new Blob([svgMarkup], { type: 'image/svg+xml;charset=utf-8' });
  } else if (isRasterImageDataUrl(targetUrl)) {
    sourceBlob = imageDataUrlToBlob(targetUrl);
  } else {
    const buf = await fetchWithManagedTimeout(targetUrl, {
      responseMode: 'buffer',
      cancelSignal,
      retries: LIMITS.SEGMENT_FETCH_RETRIES
    });
    sourceBlob = new Blob([buf]);
  }

  if (cancelSignal && cancelSignal.aborted && cancelSignal.reason === CANCEL_REASON) {
    throw new Error(CANCEL_REASON);
  }

  const img = await loadImageFromBlob(sourceBlob);
  const { width, height } = resolveConvertDimensions(
    img.naturalWidth || img.width || 0,
    img.naturalHeight || img.height || 0,
    hintWidth || 0,
    hintHeight || 0,
    isSvg,
    rasterSizePx || 0,
    maxImageResizePx || 0
  );

  const canvas = typeof document !== 'undefined' && typeof document.createElement === 'function'
    ? document.createElement('canvas')
    : null;
  if (!canvas || typeof canvas.getContext !== 'function') {
    throw new Error('IMAGE_CONVERT_FAILED');
  }
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('IMAGE_CONVERT_FAILED');
  }

  const mimeType = targetFormat === IMAGE_CONVERT_FORMATS.JPG ? 'image/jpeg' : 'image/png';
  if (targetFormat === IMAGE_CONVERT_FORMATS.JPG) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
  }
  ctx.drawImage(img, 0, 0, width, height);

  const clampedJpgPercent = clampInteger(
    jpgQualityPercent,
    LIMITS.DEFAULT_JPG_QUALITY_PERCENT,
    LIMITS.JPG_QUALITY_MIN_PERCENT,
    LIMITS.JPG_QUALITY_MAX_PERCENT
  );
  const normalizedJpgQuality = clampedJpgPercent / 100;

  return new Promise((resolve, reject) => {
    const quality = targetFormat === IMAGE_CONVERT_FORMATS.JPG ? normalizedJpgQuality : undefined;
    if (typeof canvas.toBlob === 'function') {
      canvas.toBlob((blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error('IMAGE_CONVERT_FAILED'));
        }
      }, mimeType, quality);
    } else {
      reject(new Error('IMAGE_CONVERT_FAILED'));
    }
  });
}

/**
 * Fetches or decodes an image (WebP, AVIF, SVG, etc.) and converts it to PNG or JPG via canvas.
 * @param {{ targetUrl: string, targetFormat: string, width?: number, height?: number, rasterSizePx?: number, jpgQualityPercent?: number, symbolId?: string, requestId: string }} payload
 * @returns {Promise<{ blobUrl: string, outputExtension: string, byteLength: number }>}
 */
async function convertImageBlob(payload) {
  const targetUrl = typeof payload.targetUrl === 'string' ? payload.targetUrl : '';
  const targetFormat = String(payload.targetFormat || '').toLowerCase();
  if (!isHttpUrl(targetUrl) && !isSvgDataUrl(targetUrl) && !isRasterImageDataUrl(targetUrl)) {
    throw new Error('INVALID_URL');
  }
  if (targetFormat !== IMAGE_CONVERT_FORMATS.PNG && targetFormat !== IMAGE_CONVERT_FORMATS.JPG) {
    throw new Error('IMAGE_CONVERT_FAILED');
  }

  const requestId = payload.requestId || `img_${Date.now()}`;
  const buildController = new AbortController();
  activeBuildControllers.set(requestId, buildController);

  try {
    const outBlob = await rasterizeImageToBlob(
      targetUrl,
      targetFormat,
      payload.width || 0,
      payload.height || 0,
      payload.rasterSizePx || 0,
      buildController.signal,
      payload.jpgQualityPercent,
      payload.symbolId || '',
      payload.maxImageResizePx || 0
    );

    const blobUrl = URL.createObjectURL(outBlob);
    activeBlobUrls.add(blobUrl);
    return {
      blobUrl,
      outputExtension: targetFormat,
      byteLength: outBlob.size
    };
  } finally {
    activeBuildControllers.delete(requestId);
  }
}

/**
 * Fetches and optionally converts selected image/media items into a downloadable ZIP Blob archive.
 * @param {{ items: Array<object>, requestId: string, concurrency?: number }} payload
 * @returns {Promise<{ blobUrl: string, outputExtension: string, byteLength: number, entryCount: number }>}
 */
async function buildZipBlobArchive(payload) {
  const items = Array.isArray(payload.items) ? payload.items.slice(0, LIMITS.MAX_ZIP_ITEMS) : [];
  if (items.length === 0) {
    throw new Error('EMPTY_PLAYLIST');
  }
  const requestId = payload.requestId || `zip_${Date.now()}`;
  const buildController = new AbortController();
  activeBuildControllers.set(requestId, buildController);
  const byteTracker = { bytes: 0 };
  const concurrency = clampInteger(
    payload.concurrency,
    LIMITS.HLS_FETCH_CONCURRENCY,
    LIMITS.MIN_HLS_CONCURRENCY,
    LIMITS.MAX_HLS_CONCURRENCY
  );
  const jpgQualityPercent = clampInteger(
    payload.jpgQualityPercent,
    LIMITS.DEFAULT_JPG_QUALITY_PERCENT,
    LIMITS.JPG_QUALITY_MIN_PERCENT,
    LIMITS.JPG_QUALITY_MAX_PERCENT
  );
  const maxImageResizePx = clampInteger(
    payload.maxImageResizePx,
    LIMITS.DEFAULT_MAX_IMAGE_RESIZE_PX,
    0,
    LIMITS.MAX_IMAGE_RESIZE_MAX_PX
  );
  const renameMode = payload.renameMode === ZIP_RENAME_MODES.SEQUENTIAL
    ? ZIP_RENAME_MODES.SEQUENTIAL
    : ZIP_RENAME_MODES.ORIGINAL;

  notifyProgress(requestId, 'zip', 0, items.length);

  try {
    let completed = 0;
    let lastError = null;
    const entries = new Array(items.length).fill(null);

    await runWithConcurrency(items, concurrency, async (item, index) => {
      if (buildController.signal.aborted) {
        throw new Error(buildController.signal.reason === CANCEL_REASON ? CANCEL_REASON : 'BUILD_ABORTED');
      }
      const targetUrl = item && typeof item.url === 'string' ? item.url : '';
      const rawExt = item && typeof item.ext === 'string' ? item.ext.toLowerCase() : extractUrlExtension(targetUrl);
      const { symbolId: urlSymbolId } = splitSvgSpriteUrl(targetUrl);
      const effectiveSymbolId = (item && item.symbolId) || urlSymbolId || '';
      const isSvgEntry = isSvgDataUrl(targetUrl)
        || rawExt === DEFAULT_FILENAMES.SVG_EXT
        || Boolean(effectiveSymbolId);
      const requestedFormat = item && typeof item.convertTo === 'string' ? item.convertTo.toLowerCase() : '';
      const needsConversion = (
        (requestedFormat === IMAGE_CONVERT_FORMATS.PNG || requestedFormat === IMAGE_CONVERT_FORMATS.JPG)
        && rawExt !== requestedFormat
        && !(requestedFormat === IMAGE_CONVERT_FORMATS.JPG && rawExt === 'jpeg')
      );

      try {
        let entryData;
        const outputExt = needsConversion
          ? requestedFormat
          : (isSvgEntry ? DEFAULT_FILENAMES.SVG_EXT : (rawExt || DEFAULT_FILENAMES.FALLBACK_EXT));
        const entryName = resolveZipEntryFilename(
          item && item.filename,
          outputExt,
          index,
          items.length,
          renameMode
        );
        if (needsConversion) {
          const convertedBlob = await rasterizeImageToBlob(
            targetUrl,
            requestedFormat,
            item.width || 0,
            item.height || 0,
            item.rasterSizePx || 0,
            buildController.signal,
            jpgQualityPercent,
            effectiveSymbolId,
            maxImageResizePx
          );
          const buf = await convertedBlob.arrayBuffer();
          if (byteTracker.bytes + buf.byteLength > LIMITS.MAX_HLS_BUFFER_BYTES) {
            throw new Error('STREAM_TOO_LARGE');
          }
          byteTracker.bytes += buf.byteLength;
          entryData = new Uint8Array(buf);
        } else if (isSvgEntry && (isSvgDataUrl(targetUrl) || isHttpUrl(targetUrl))) {
          const svgText = await resolveSvgSourceText(targetUrl, effectiveSymbolId, buildController.signal);
          const svgBytes = new TextEncoder().encode(svgText);
          if (byteTracker.bytes + svgBytes.byteLength > LIMITS.MAX_HLS_BUFFER_BYTES) {
            throw new Error('STREAM_TOO_LARGE');
          }
          byteTracker.bytes += svgBytes.byteLength;
          entryData = svgBytes;
        } else if (isRasterImageDataUrl(targetUrl)) {
          const rasterBlob = imageDataUrlToBlob(targetUrl, 'image/png');
          const buf = await rasterBlob.arrayBuffer();
          byteTracker.bytes += buf.byteLength;
          entryData = new Uint8Array(buf);
        } else if (isHttpUrl(targetUrl)) {
          const buf = await fetchWithManagedTimeout(targetUrl, {
            responseMode: 'buffer',
            cancelSignal: buildController.signal,
            byteTracker,
            retries: LIMITS.SEGMENT_FETCH_RETRIES
          });
          entryData = new Uint8Array(buf);
        } else {
          throw new Error('INVALID_URL');
        }
        entries[index] = { name: entryName, data: entryData };
      } catch (err) {
        if (err && (err.message === CANCEL_REASON || err.message === 'BUILD_ABORTED' || err.message === 'STREAM_TOO_LARGE')) {
          throw err;
        }
        lastError = err;
      } finally {
        completed += 1;
        notifyProgress(requestId, 'zip', completed, items.length);
      }
    });

    if (buildController.signal.aborted && buildController.signal.reason === CANCEL_REASON) {
      throw new Error(CANCEL_REASON);
    }

    const validEntries = entries.filter(Boolean);
    if (validEntries.length === 0) {
      throw lastError || new Error('DOWNLOAD_FAILED');
    }

    const zipBlob = await buildZipBlobAsync(validEntries);
    const blobUrl = URL.createObjectURL(zipBlob);
    activeBlobUrls.add(blobUrl);
    return {
      blobUrl,
      outputExtension: DEFAULT_FILENAMES.ZIP_EXT,
      byteLength: zipBlob.size,
      entryCount: validEntries.length
    };
  } finally {
    activeBuildControllers.delete(requestId);
  }
}

const TAB_CAPTURE_MIME_CANDIDATES = Object.freeze([
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
  'video/mp4'
]);

/**
 * Selects the best supported MediaRecorder MIME type for tab recording.
 * @returns {string}
 */
function selectTabCaptureMimeType() {
  if (typeof MediaRecorder !== 'function' || typeof MediaRecorder.isTypeSupported !== 'function') {
    return 'video/webm';
  }
  for (const candidate of TAB_CAPTURE_MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(candidate)) {
      return candidate;
    }
  }
  return 'video/webm';
}

/**
 * Releases media stream tracks and optional WebAudio pass-through resources cleanly.
 * @param {{ stream?: MediaStream, audioCtx?: AudioContext }} session
 */
function releaseTabCaptureMedia(session) {
  if (!session) {
    return;
  }
  if (session.stream && typeof session.stream.getTracks === 'function') {
    for (const track of session.stream.getTracks()) {
      try {
        track.stop();
      } catch {
        // Ignore already stopped track
      }
    }
  }
  if (session.audioCtx && typeof session.audioCtx.close === 'function') {
    session.audioCtx.close().catch(() => {});
  }
}

/**
 * Captures live video and audio from a Chrome tab MediaStream ID until stopped or cancelled.
 * @param {{ streamId: string, originalUrl: string, requestId: string }} payload
 * @returns {Promise<{ blobUrl: string, outputExtension: string, byteLength: number }>}
 */
async function startTabCaptureRecording(payload) {
  const { streamId, originalUrl = '', requestId, tabCaptureBitrateMbps } = payload || {};
  if (
    !streamId ||
    typeof navigator === 'undefined' ||
    !navigator.mediaDevices ||
    typeof navigator.mediaDevices.getUserMedia !== 'function' ||
    typeof MediaRecorder !== 'function'
  ) {
    throw new Error('TAB_CAPTURE_UNAVAILABLE');
  }

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId
        }
      },
      video: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId
        }
      }
    });
  } catch {
    throw new Error('TAB_CAPTURE_FAILED');
  }

  let audioCtx = null;
  if (typeof AudioContext === 'function' && typeof stream.getAudioTracks === 'function' && stream.getAudioTracks().length > 0) {
    try {
      audioCtx = new AudioContext();
      const source = audioCtx.createMediaStreamSource(stream);
      source.connect(audioCtx.destination);
    } catch {
      audioCtx = null;
    }
  }

  const mimeType = selectTabCaptureMimeType();
  const bitrateMbps = clampInteger(
    tabCaptureBitrateMbps,
    LIMITS.DEFAULT_TAB_CAPTURE_BITRATE_MBPS,
    LIMITS.TAB_CAPTURE_BITRATE_MIN_MBPS,
    LIMITS.TAB_CAPTURE_BITRATE_MAX_MBPS
  );
  const recorderOptions = {
    ...(mimeType ? { mimeType } : {}),
    videoBitsPerSecond: bitrateMbps * 1000 * 1000
  };
  const outputExtension = mimeType.includes('mp4')
    ? DEFAULT_FILENAMES.HLS_FMP4_EXT
    : DEFAULT_FILENAMES.WEBM_EXT;

  let recorder;
  try {
    recorder = new MediaRecorder(stream, recorderOptions);
  } catch {
    releaseTabCaptureMedia({ stream, audioCtx });
    throw new Error('TAB_CAPTURE_FAILED');
  }

  const chunks = [];
  let totalBytes = 0;
  const startedAt = Date.now();
  const session = {
    requestId,
    recorder,
    stream,
    audioCtx,
    cancelled: false
  };
  activeTabCaptures.set(requestId, session);

  const buildController = new AbortController();
  buildController.signal.addEventListener('abort', () => {
    session.cancelled = buildController.signal.reason === CANCEL_REASON;
    if (recorder.state !== 'inactive') {
      try {
        recorder.stop();
      } catch {
        // Ignore stop race
      }
    }
  }, { once: true });
  activeBuildControllers.set(requestId, buildController);

  notifyProgress(requestId, originalUrl, 0, 0, {
    isLiveRecord: true,
    isTabCapture: true,
    bytes: 0
  });

  return new Promise((resolve, reject) => {
    const finalizeError = (code) => {
      activeTabCaptures.delete(requestId);
      activeBuildControllers.delete(requestId);
      releaseTabCaptureMedia(session);
      reject(new Error(code));
    };

    recorder.ondataavailable = (event) => {
      if (!event || !event.data || event.data.size === 0) {
        return;
      }
      if (totalBytes + event.data.size > LIMITS.MAX_HLS_BUFFER_BYTES) {
        if (recorder.state !== 'inactive') {
          try {
            recorder.stop();
          } catch {
            // Stop at max buffer ceiling
          }
        }
        return;
      }
      chunks.push(event.data);
      totalBytes += event.data.size;
      const elapsedSec = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
      notifyProgress(requestId, originalUrl, elapsedSec, 0, {
        isLiveRecord: true,
        isTabCapture: true,
        bytes: totalBytes
      });
    };

    recorder.onerror = () => finalizeError('TAB_CAPTURE_FAILED');

    recorder.onstop = () => {
      activeTabCaptures.delete(requestId);
      activeBuildControllers.delete(requestId);
      releaseTabCaptureMedia(session);
      if (session.cancelled) {
        reject(new Error(CANCEL_REASON));
        return;
      }
      if (chunks.length === 0) {
        reject(new Error('TAB_CAPTURE_FAILED'));
        return;
      }
      const blob = new Blob(chunks, { type: mimeType || 'video/webm' });
      chunks.length = 0;
      const blobUrl = URL.createObjectURL(blob);
      activeBlobUrls.add(blobUrl);
      resolve({
        blobUrl,
        outputExtension,
        byteLength: blob.size
      });
    };

    if (typeof stream.getVideoTracks === 'function') {
      for (const track of stream.getVideoTracks()) {
        track.addEventListener('ended', () => {
          if (recorder.state !== 'inactive') {
            try {
              recorder.stop();
            } catch {
              // Ignore track ended stop error
            }
          }
        }, { once: true });
      }
    }

    try {
      recorder.start(LIMITS.TAB_CAPTURE_TIMESLICE_MS);
    } catch {
      finalizeError('TAB_CAPTURE_FAILED');
    }
  });
}

/**
 * Stops one or all active MediaRecorder tab capture sessions cleanly.
 * @param {string} [requestId='']
 */
function stopTabCaptureSessions(requestId = '') {
  const targets = requestId
    ? [activeTabCaptures.get(requestId)].filter(Boolean)
    : Array.from(activeTabCaptures.values());
  for (const session of targets) {
    if (session.recorder && session.recorder.state !== 'inactive') {
      try {
        session.recorder.stop();
      } catch {
        // Ignore already stopped recorder
      }
    }
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
      audioUrl: message.audioUrl || '',
      audioOnly: Boolean(message.audioOnly),
      audioFormat: message.audioFormat || AUDIO_EXPORT_FORMATS.M4A,
      requestId,
      concurrency: message.concurrency,
      qualityPreference: message.qualityPreference
    })
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => sendResponse({ ok: false, error: err.message || 'HLS_ERROR' }));
    return true;
  }

  if (message.type === MESSAGE_TYPES.OFFSCREEN_RECORD_HLS_LIVE) {
    const requestId = message.requestId || `live_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    recordLiveHlsBlob({
      playlistUrl: message.playlistUrl,
      originalUrl: message.originalUrl || message.playlistUrl,
      audioUrl: message.audioUrl || '',
      requestId,
      concurrency: message.concurrency,
      qualityPreference: message.qualityPreference,
      pollIntervalMs: message.pollIntervalMs
    })
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => sendResponse({ ok: false, error: err.message || 'HLS_ERROR' }));
    return true;
  }

  if (message.type === MESSAGE_TYPES.OFFSCREEN_STOP_LIVE_RECORD) {
    if (message.requestId) {
      const recorder = activeLiveRecorders.get(message.requestId);
      if (recorder) {
        recorder.stopped = true;
        if (typeof recorder.wakeUp === 'function') {
          recorder.wakeUp();
        }
      }
    } else {
      for (const recorder of activeLiveRecorders.values()) {
        recorder.stopped = true;
        if (typeof recorder.wakeUp === 'function') {
          recorder.wakeUp();
        }
      }
    }
    sendResponse({ ok: true });
    return false;
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
    const mseResult = handleMseBlobMessage(message);
    if (
      mseResult
      && mseResult.ok
      && mseResult.blobUrl
      && message.action === 'finalize'
      && message.audioOnly
      && (message.audioFormat === AUDIO_EXPORT_FORMATS.WAV || message.audioFormat === AUDIO_EXPORT_FORMATS.OPUS)
    ) {
      fetch(mseResult.blobUrl)
        .then((res) => res.arrayBuffer())
        .then((buf) => decodeMediaPartsToAudioBlob([buf], message.audioFormat))
        .then(({ blob: outAudioBlob, extension }) => {
          URL.revokeObjectURL(mseResult.blobUrl);
          activeBlobUrls.delete(mseResult.blobUrl);
          const audioBlobUrl = URL.createObjectURL(outAudioBlob);
          activeBlobUrls.add(audioBlobUrl);
          sendResponse({
            ok: true,
            blobUrl: audioBlobUrl,
            outputExtension: extension,
            byteLength: outAudioBlob.size
          });
        })
        .catch((err) => sendResponse({ ok: false, error: (err && err.message) || 'NO_AUDIO_TRACK' }));
      return true;
    }
    sendResponse(mseResult);
    return false;
  }

  if (message.type === MESSAGE_TYPES.OFFSCREEN_CONVERT_IMAGE) {
    const requestId = message.requestId || `img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    convertImageBlob({
      targetUrl: message.targetUrl,
      targetFormat: message.targetFormat,
      width: message.width,
      height: message.height,
      rasterSizePx: message.rasterSizePx,
      jpgQualityPercent: message.jpgQualityPercent,
      maxImageResizePx: message.maxImageResizePx,
      symbolId: message.symbolId || '',
      requestId
    })
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => sendResponse({ ok: false, error: err.message || 'IMAGE_CONVERT_FAILED' }));
    return true;
  }

  if (message.type === MESSAGE_TYPES.OFFSCREEN_EXTRACT_SVG_SYMBOL) {
    const requestId = message.requestId || `svg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    extractSvgSymbolBlob({
      targetUrl: message.targetUrl,
      symbolId: message.symbolId || '',
      requestId
    })
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => sendResponse({ ok: false, error: err.message || 'DOWNLOAD_FAILED' }));
    return true;
  }

  if (message.type === MESSAGE_TYPES.OFFSCREEN_DECODE_WAV) {
    const requestId = message.requestId || `aud_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    decodeDirectMediaToWav({
      targetUrl: message.targetUrl,
      audioFormat: message.audioFormat,
      requestId
    })
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => sendResponse({ ok: false, error: err.message || 'NO_AUDIO_TRACK' }));
    return true;
  }

  if (message.type === MESSAGE_TYPES.OFFSCREEN_BUILD_ZIP_BLOB) {
    const requestId = message.requestId || `zip_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    buildZipBlobArchive({
      items: message.items,
      concurrency: message.concurrency,
      jpgQualityPercent: message.jpgQualityPercent,
      maxImageResizePx: message.maxImageResizePx,
      renameMode: message.renameMode,
      requestId
    })
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => sendResponse({ ok: false, error: err.message || 'DOWNLOAD_FAILED' }));
    return true;
  }

  if (message.type === MESSAGE_TYPES.OFFSCREEN_START_TAB_CAPTURE) {
    const requestId = message.requestId || `cap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    startTabCaptureRecording({
      streamId: message.streamId,
      originalUrl: message.originalUrl || '',
      tabCaptureBitrateMbps: message.tabCaptureBitrateMbps,
      requestId
    })
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => sendResponse({ ok: false, error: err.message || 'TAB_CAPTURE_FAILED' }));
    return true;
  }

  if (message.type === MESSAGE_TYPES.OFFSCREEN_STOP_TAB_CAPTURE) {
    stopTabCaptureSessions(message.requestId || '');
    sendResponse({ ok: true });
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
