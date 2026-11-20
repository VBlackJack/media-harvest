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
  LIMITS,
  QUALITY_PREFERENCES,
  STORAGE_KEYS
} from '../config/constants.js';
import { formatBytes } from '../popup/popup_helpers.js';
import { parseDashManifest } from '../shared/dash_parser.js';
import { isDashDescriptor, looksLikeDashXml } from '../shared/fetch_utils.js';
import {
  decodeBase64DataUri,
  decryptAes128Segment,
  importAes128Key,
  isBase64DataUri,
  resolveSegmentIv
} from '../shared/hls_crypto.js';
import {
  looksLikeAdtsAudio,
  transmuxAdtsSegmentsToFmp4Parts
} from '../shared/adts_transmuxer.js';
import { transmuxWebmOpusToFmp4Parts } from '../shared/mixed_mse_muxer.js';
import {
  mergeFmp4InitSegments,
  normalizeFmp4Fragment
} from '../shared/fmp4_muxer.js';
import {
  buildDualWebmStreamInit,
  rewriteAudioClusterForMux,
  splitWebmInitAndClusters
} from '../shared/webm_muxer.js';
import { resolveStreamPlan } from '../shared/stream_planner.js';
import { applyTranslations, getUiLanguage, t } from '../shared/i18n.js';
import { isHttpUrl } from '../shared/media_classifier.js';
import { clampInteger } from '../shared/settings.js';

const RETRYABLE_HTTP_STATUS = new Set([408, 429]);
const MAX_PENDING_DUAL_PAIRS = 8;

async function waitRetryBackoff(attempt, signal) {
  const baseMs = LIMITS.SEGMENT_RETRY_DELAY_MS || 250;
  const delayMs = baseMs * (2 ** attempt);
  await new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(new Error('DOWNLOAD_CANCELLED'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('DOWNLOAD_CANCELLED'));
    };
    const timer = setTimeout(() => {
      if (signal && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', onAbort);
      }
      resolve();
    }, delayMs);
    if (signal && typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

async function fetchWithRetry(fetchFn, url, options = {}) {
  const maxRetries = LIMITS.SEGMENT_FETCH_RETRIES || 2;
  const timeoutMs = LIMITS.FETCH_TIMEOUT_MS || 20000;
  let lastError = null;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (options.signal && options.signal.aborted) {
      throw new Error('DOWNLOAD_CANCELLED');
    }
    if (attempt > 0) {
      await waitRetryBackoff(attempt - 1, options.signal);
    }
    const attemptController = typeof AbortController === 'function' ? new AbortController() : null;
    let timedOut = false;
    let timer = null;
    const onOuterAbort = () => {
      if (attemptController) {
        attemptController.abort();
      }
    };
    if (attemptController) {
      if (options.signal && typeof options.signal.addEventListener === 'function') {
        options.signal.addEventListener('abort', onOuterAbort, { once: true });
      }
      timer = setTimeout(() => {
        timedOut = true;
        attemptController.abort();
      }, timeoutMs);
    }
    try {
      const fetchOpts = attemptController
        ? { ...options, signal: attemptController.signal }
        : options;
      const response = await fetchFn(url, fetchOpts);
      if (response.ok) {
        return response;
      }
      if (!RETRYABLE_HTTP_STATUS.has(response.status) && response.status < 500) {
        throw new Error(`HTTP_${response.status}`);
      }
      lastError = new Error(`HTTP_${response.status}`);
    } catch (err) {
      if (options.signal && options.signal.aborted) {
        throw new Error('DOWNLOAD_CANCELLED');
      }
      if (timedOut) {
        lastError = new Error('FETCH_TIMEOUT');
      } else if (err && (err.name === 'AbortError' || err.message === 'DOWNLOAD_CANCELLED')) {
        throw new Error('DOWNLOAD_CANCELLED');
      } else if (err && typeof err.message === 'string' && /^HTTP_4\d\d$/.test(err.message)) {
        throw err;
      } else {
        lastError = err;
      }
    } finally {
      if (timer !== null) {
        clearTimeout(timer);
      }
      if (options.signal && typeof options.signal.removeEventListener === 'function') {
        options.signal.removeEventListener('abort', onOuterAbort);
      }
    }
  }
  throw lastError || new Error('DOWNLOAD_FAILED');
}

/**
 * Resolves a single segment fetch request into decrypted ArrayBuffer bytes.
 * @param {object} req
 * @param {AbortSignal} signal
 * @param {Function} fetchFn
 * @param {Map<string, Promise<CryptoKey>>} keyCache
 * @returns {Promise<ArrayBuffer>}
 */
async function fetchAndDecryptSegment(req, signal, fetchFn, keyCache) {
  const headers = req.byteRange ? { Range: req.byteRange } : undefined;
  const response = await fetchWithRetry(fetchFn, req.url, { headers, signal });
  const rawBuf = await response.arrayBuffer();
  const keyUri = req.key && (req.key.keyUrl || req.key.uri);
  if (!keyUri) {
    return rawBuf;
  }

  let keyPromise = keyCache.get(keyUri);
  if (!keyPromise) {
    keyPromise = (async () => {
      if (isBase64DataUri(keyUri)) {
        return importAes128Key(decodeBase64DataUri(keyUri));
      }
      const keyRes = await fetchWithRetry(fetchFn, keyUri, { signal });
      return importAes128Key(await keyRes.arrayBuffer());
    })();
    keyCache.set(keyUri, keyPromise);
  }
  const cryptoKey = await keyPromise;
  const iv = resolveSegmentIv(req.key.ivHex, req.sequenceNumber);
  return decryptAes128Segment(rawBuf, cryptoKey, iv);
}

/**
 * Streams a direct progressive HTTP body reader directly to a FileSystemWritableFileStream.
 * @param {string} targetUrl
 * @param {FileSystemWritableFileStream} writable
 * @param {{ fetchFn?: Function, signal?: AbortSignal, onProgress?: Function }} [options={}]
 * @returns {Promise<number>}
 */
export async function streamProgressiveResponseToWritable(targetUrl, writable, options = {}) {
  const fetchFn = options.fetchFn || fetch;
  const signal = options.signal;
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};

  const response = await fetchWithRetry(fetchFn, targetUrl, { signal });

  let totalWritten = 0;
  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    while (true) {
      if (signal && signal.aborted) {
        await reader.cancel().catch(() => {});
        throw new Error('DOWNLOAD_CANCELLED');
      }
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      if (value && value.byteLength > 0) {
        await writable.write(value);
        totalWritten += value.byteLength;
        onProgress(1, 1, totalWritten);
      }
    }
    return totalWritten;
  }

  const fallbackBuf = await response.arrayBuffer();
  await writable.write(fallbackBuf);
  totalWritten = fallbackBuf.byteLength;
  onProgress(1, 1, totalWritten);
  return totalWritten;
}

function buildPlaylistSegmentRequests(playlist) {
  const reqs = [];
  for (let i = 0; i < (playlist.segments || []).length; i += 1) {
    const seg = playlist.segments[i];
    reqs.push({
      url: seg.url,
      byteRange: seg.byteRange || '',
      key: seg.key || null,
      sequenceNumber: Number.isFinite(seg.sequenceNumber) ? seg.sequenceNumber : i
    });
  }
  return reqs;
}

/**
 * Streams dual-track segmented fMP4 (video + separate audio init + segment pairs) directly to disk.
 * Merges `[ftyp?, combinedMoov]` upfront and rewrites audio fragment track IDs on the fly.
 * @param {object} mediaPlaylist
 * @param {object} audioPlaylist
 * @param {FileSystemWritableFileStream} writable
 * @param {object} ctx
 * @returns {Promise<number>}
 */
async function streamDualFmp4ToWritable(mediaPlaylist, audioPlaylist, writable, ctx) {
  const { concurrency, signal, fetchFn, keyCache, onProgress } = ctx;
  const videoSegReqs = buildPlaylistSegmentRequests(mediaPlaylist);
  const audioSegReqs = buildPlaylistSegmentRequests(audioPlaylist);
  if (videoSegReqs.length === 0) {
    throw new Error('EMPTY_PLAYLIST');
  }

  const totalUnits = 2 + videoSegReqs.length + audioSegReqs.length;
  const [videoInitBuf, audioInitBuf] = await Promise.all([
    fetchAndDecryptSegment(
      { url: mediaPlaylist.initSegmentUrl, byteRange: mediaPlaylist.initSegmentByteRange || '', key: null, sequenceNumber: 0 },
      signal,
      fetchFn,
      keyCache
    ),
    fetchAndDecryptSegment(
      { url: audioPlaylist.initSegmentUrl, byteRange: audioPlaylist.initSegmentByteRange || '', key: null, sequenceNumber: 0 },
      signal,
      fetchFn,
      keyCache
    )
  ]);

  const { initParts, audioTrackId } = mergeFmp4InitSegments(videoInitBuf, audioInitBuf);
  let totalBytesWritten = 0;
  for (const part of initParts) {
    await writable.write(part);
    totalBytesWritten += part.byteLength;
  }
  let completedCount = 2;
  onProgress(completedCount, totalUnits, totalBytesWritten, true);

  const pairCount = Math.max(videoSegReqs.length, audioSegReqs.length);
  const stepWindow = Math.max(1, Math.floor(concurrency / 2));

  for (let start = 0; start < pairCount; start += stepWindow) {
    if (signal && signal.aborted) {
      throw new Error('DOWNLOAD_CANCELLED');
    }
    const end = Math.min(start + stepWindow, pairCount);
    const pairIndices = [];
    for (let idx = start; idx < end; idx += 1) {
      pairIndices.push(idx);
    }

    const pairBuffers = await Promise.all(
      pairIndices.map(async (idx) => {
        const vPromise = idx < videoSegReqs.length
          ? fetchAndDecryptSegment(videoSegReqs[idx], signal, fetchFn, keyCache)
          : Promise.resolve(null);
        const aPromise = idx < audioSegReqs.length
          ? fetchAndDecryptSegment(audioSegReqs[idx], signal, fetchFn, keyCache)
          : Promise.resolve(null);
        return Promise.all([vPromise, aPromise]);
      })
    );

    for (let i = 0; i < pairBuffers.length; i += 1) {
      if (signal && signal.aborted) {
        throw new Error('DOWNLOAD_CANCELLED');
      }
      const [vBuf, aBuf] = pairBuffers[i];
      if (vBuf) {
        const normalizedVideo = normalizeFmp4Fragment(new Uint8Array(vBuf), 0);
        await writable.write(normalizedVideo);
        totalBytesWritten += normalizedVideo.byteLength;
        completedCount += 1;
      }
      if (aBuf) {
        const rewrittenAudio = normalizeFmp4Fragment(new Uint8Array(aBuf), audioTrackId);
        await writable.write(rewrittenAudio);
        totalBytesWritten += rewrittenAudio.byteLength;
        completedCount += 1;
      }
      pairBuffers[i] = null;
      onProgress(completedCount, totalUnits, totalBytesWritten, true);
    }
  }

  return totalBytesWritten;
}

function createIncrementalTsCollector(TransmuxerCtor) {
  const transmuxer = new TransmuxerCtor({ keepOriginalTimestamps: false });
  const initHolder = { initSegment: null };
  const chunks = [];
  transmuxer.on('data', (segment) => {
    if (!initHolder.initSegment && segment && segment.initSegment && segment.initSegment.byteLength > 0) {
      initHolder.initSegment = new Uint8Array(segment.initSegment);
    }
    if (segment && segment.data && segment.data.byteLength > 0) {
      chunks.push(new Uint8Array(segment.data));
    }
  });
  return {
    pushSegment: (buf, isDiscontinuity, isLast) => {
      if (isDiscontinuity && typeof transmuxer.endTimeline === 'function') {
        transmuxer.endTimeline();
        transmuxer.flush();
      }
      transmuxer.push(buf instanceof Uint8Array ? buf : new Uint8Array(buf));
      transmuxer.flush();
      if (isLast && typeof transmuxer.endTimeline === 'function') {
        transmuxer.endTimeline();
      }
      const out = chunks.splice(0, chunks.length);
      return { initSegment: initHolder.initSegment, fragments: out };
    }
  };
}

/**
 * Streams dual-track DASH WebM (video + audio init + cluster pairs) directly to disk.
 * @param {object} mediaPlaylist
 * @param {object} audioPlaylist
 * @param {FileSystemWritableFileStream} writable
 * @param {object} ctx
 * @returns {Promise<number>}
 */
async function streamDualWebmToWritable(mediaPlaylist, audioPlaylist, writable, ctx) {
  const { concurrency, signal, fetchFn, keyCache, onProgress } = ctx;
  const videoSegReqs = buildPlaylistSegmentRequests(mediaPlaylist);
  const audioSegReqs = buildPlaylistSegmentRequests(audioPlaylist);
  const videoInitReq = mediaPlaylist.initSegmentUrl
    ? { url: mediaPlaylist.initSegmentUrl, byteRange: mediaPlaylist.initSegmentByteRange || '', key: null, sequenceNumber: 0 }
    : videoSegReqs.shift();
  const audioInitReq = audioPlaylist.initSegmentUrl
    ? { url: audioPlaylist.initSegmentUrl, byteRange: audioPlaylist.initSegmentByteRange || '', key: null, sequenceNumber: 0 }
    : audioSegReqs.shift();
  if (!videoInitReq || !audioInitReq) {
    throw new Error('EMPTY_PLAYLIST');
  }
  const totalUnits = 2 + videoSegReqs.length + audioSegReqs.length;
  const [videoInitBuf, audioInitBuf] = await Promise.all([
    fetchAndDecryptSegment(videoInitReq, signal, fetchFn, keyCache),
    fetchAndDecryptSegment(audioInitReq, signal, fetchFn, keyCache)
  ]);
  const { prefixParts, audioTrackNumber, videoScale, audioScale } = buildDualWebmStreamInit(
    videoInitBuf,
    audioInitBuf
  );
  let totalBytesWritten = 0;
  for (const part of prefixParts) {
    await writable.write(part);
    totalBytesWritten += part.byteLength;
  }
  if (!mediaPlaylist.initSegmentUrl) {
    for (const cluster of splitWebmInitAndClusters(videoInitBuf).clusters) {
      await writable.write(cluster);
      totalBytesWritten += cluster.byteLength;
    }
  }
  if (!audioPlaylist.initSegmentUrl) {
    for (const cluster of splitWebmInitAndClusters(audioInitBuf).clusters) {
      const muxed = rewriteAudioClusterForMux(cluster, audioTrackNumber, audioScale, videoScale);
      await writable.write(muxed);
      totalBytesWritten += muxed.byteLength;
    }
  }
  let completedCount = 2;
  onProgress(completedCount, totalUnits, totalBytesWritten, true);

  const pairCount = Math.max(videoSegReqs.length, audioSegReqs.length);
  const stepWindow = Math.max(1, Math.floor(concurrency / 2));
  for (let start = 0; start < pairCount; start += stepWindow) {
    if (signal && signal.aborted) {
      throw new Error('DOWNLOAD_CANCELLED');
    }
    const end = Math.min(start + stepWindow, pairCount);
    const pairIndices = Array.from({ length: end - start }, (_, k) => start + k);
    const pairBuffers = await Promise.all(
      pairIndices.map((idx) => Promise.all([
        idx < videoSegReqs.length ? fetchAndDecryptSegment(videoSegReqs[idx], signal, fetchFn, keyCache) : null,
        idx < audioSegReqs.length ? fetchAndDecryptSegment(audioSegReqs[idx], signal, fetchFn, keyCache) : null
      ]))
    );
    for (let i = 0; i < pairBuffers.length; i += 1) {
      const [vBuf, aBuf] = pairBuffers[i];
      if (vBuf) {
        const vBytes = new Uint8Array(vBuf);
        await writable.write(vBytes);
        totalBytesWritten += vBytes.byteLength;
        completedCount += 1;
      }
      if (aBuf) {
        const rewritten = rewriteAudioClusterForMux(aBuf, audioTrackNumber, audioScale, videoScale);
        await writable.write(rewritten);
        totalBytesWritten += rewritten.byteLength;
        completedCount += 1;
      }
      pairBuffers[i] = null;
      onProgress(completedCount, totalUnits, totalBytesWritten, true);
    }
  }
  return totalBytesWritten;
}

/**
 * Streams dual-track playlists requiring incremental transmuxing (HLS TS video + separate audio,
 * or fMP4 video + ADTS AAC / TS / WebM Opus audio) directly to disk in bounded windows.
 * @param {object} mediaPlaylist
 * @param {object} audioPlaylist
 * @param {FileSystemWritableFileStream} writable
 * @param {object} ctx
 * @returns {Promise<number>}
 */
async function streamDualMixedToWritable(mediaPlaylist, audioPlaylist, writable, ctx) {
  const { concurrency, signal, fetchFn, keyCache, onProgress, TransmuxerCtor } = ctx;
  const videoSegReqs = buildPlaylistSegmentRequests(mediaPlaylist);
  const audioSegReqs = buildPlaylistSegmentRequests(audioPlaylist);
  if (videoSegReqs.length === 0) {
    throw new Error('EMPTY_PLAYLIST');
  }
  const hasVideoInit = Boolean(mediaPlaylist.initSegmentUrl);
  const hasAudioInit = Boolean(audioPlaylist.initSegmentUrl);
  const videoDiscontinuities = new Set(Array.isArray(mediaPlaylist.discontinuityIndices) ? mediaPlaylist.discontinuityIndices : []);
  const audioDiscontinuities = new Set(Array.isArray(audioPlaylist.discontinuityIndices) ? audioPlaylist.discontinuityIndices : []);
  const videoCollector = !hasVideoInit && typeof TransmuxerCtor === 'function' ? createIncrementalTsCollector(TransmuxerCtor) : null;
  const audioCollector = !hasAudioInit && typeof TransmuxerCtor === 'function' ? createIncrementalTsCollector(TransmuxerCtor) : null;

  let videoInitBytes = hasVideoInit
    ? new Uint8Array(await fetchAndDecryptSegment({ url: mediaPlaylist.initSegmentUrl, byteRange: mediaPlaylist.initSegmentByteRange || '', key: null, sequenceNumber: 0 }, signal, fetchFn, keyCache))
    : null;
  let audioInitBytes = hasAudioInit
    ? new Uint8Array(await fetchAndDecryptSegment({ url: audioPlaylist.initSegmentUrl, byteRange: audioPlaylist.initSegmentByteRange || '', key: null, sequenceNumber: 0 }, signal, fetchFn, keyCache))
    : null;
  const audioIsWebmOpus = Boolean(hasAudioInit && (audioPlaylist.mimeType === 'audio/webm' || (audioInitBytes && audioInitBytes[0] === 0x1a)));

  let mergedTrackId = 0;
  let wroteHeader = false;
  let totalBytesWritten = 0;
  let completedCount = (hasVideoInit ? 1 : 0) + (hasAudioInit ? 1 : 0);
  const totalUnits = completedCount + videoSegReqs.length + audioSegReqs.length;
  const pendingPairs = [];

  const flushHeaderAndPending = async () => {
    while (pendingPairs.length > 0 && pendingPairs[0].ready) {
      const pair = pendingPairs.shift();
      for (const vf of pair.vFrags) {
        const out = normalizeFmp4Fragment(vf, 0);
        await writable.write(out);
        totalBytesWritten += out.byteLength;
      }
      for (const af of pair.aFrags) {
        const out = normalizeFmp4Fragment(af, mergedTrackId);
        await writable.write(out);
        totalBytesWritten += out.byteLength;
      }
    }
  };

  const pairCount = Math.max(videoSegReqs.length, audioSegReqs.length);
  const stepWindow = Math.max(1, Math.floor(concurrency / 2));
  for (let start = 0; start < pairCount; start += stepWindow) {
    if (signal && signal.aborted) {
      throw new Error('DOWNLOAD_CANCELLED');
    }
    const end = Math.min(start + stepWindow, pairCount);
    const pairIndices = Array.from({ length: end - start }, (_, k) => start + k);
    const pairBuffers = await Promise.all(
      pairIndices.map((idx) => Promise.all([
        idx < videoSegReqs.length ? fetchAndDecryptSegment(videoSegReqs[idx], signal, fetchFn, keyCache) : null,
        idx < audioSegReqs.length ? fetchAndDecryptSegment(audioSegReqs[idx], signal, fetchFn, keyCache) : null
      ]))
    );

    for (let i = 0; i < pairBuffers.length; i += 1) {
      const idx = pairIndices[i];
      const [vBuf, aBuf] = pairBuffers[i];
      let vFrags = [];
      let aFrags = [];
      let convertedAudioInit = null;
  let audioDecodeTimeTicks = 0;
  let audioSeqNum = 1;

      if (vBuf) {
        if (hasVideoInit) {
          vFrags = [new Uint8Array(vBuf)];
        } else if (videoCollector) {
          const pushed = videoCollector.pushSegment(vBuf, idx > 0 && videoDiscontinuities.has(idx), idx === videoSegReqs.length - 1);
          if (!videoInitBytes && pushed.initSegment) {
            videoInitBytes = pushed.initSegment;
          }
          vFrags = pushed.fragments;
        }
        completedCount += 1;
      }

      if (aBuf) {
        if (audioIsWebmOpus && audioInitBytes) {
          const opusFmp4 = transmuxWebmOpusToFmp4Parts([audioInitBytes, aBuf], {
            baseMediaDecodeTime: audioDecodeTimeTicks,
            startSequenceNumber: audioSeqNum
          });
          if (!convertedAudioInit) {
            convertedAudioInit = opusFmp4.initSegment;
          }
          aFrags = opusFmp4.dataChunks;
          audioDecodeTimeTicks = opusFmp4.nextMediaDecodeTime;
          audioSeqNum = opusFmp4.nextSequenceNumber;
        } else if (hasAudioInit) {
          aFrags = [new Uint8Array(aBuf)];
        } else if (looksLikeAdtsAudio(aBuf)) {
          const adtsParts = transmuxAdtsSegmentsToFmp4Parts([aBuf], {
            baseMediaDecodeTime: audioDecodeTimeTicks,
            startSequenceNumber: audioSeqNum
          });
          if (!convertedAudioInit) {
            convertedAudioInit = adtsParts.initSegment;
          }
          aFrags = adtsParts.dataChunks;
          audioDecodeTimeTicks = adtsParts.nextMediaDecodeTime;
          audioSeqNum = adtsParts.nextSequenceNumber;
        } else if (audioCollector) {
          const pushed = audioCollector.pushSegment(aBuf, idx > 0 && audioDiscontinuities.has(idx), idx === audioSegReqs.length - 1);
          if (!audioInitBytes && pushed.initSegment) {
            convertedAudioInit = pushed.initSegment;
          }
          aFrags = pushed.fragments;
        }
        completedCount += 1;
      }

      if (!wroteHeader && videoInitBytes && (convertedAudioInit || (!audioIsWebmOpus && audioInitBytes))) {
        const effAudioInit = convertedAudioInit || audioInitBytes;
        const { initParts, audioTrackId } = mergeFmp4InitSegments(videoInitBytes, effAudioInit);
        mergedTrackId = audioTrackId;
        for (const part of initParts) {
          await writable.write(part);
          totalBytesWritten += part.byteLength;
        }
        wroteHeader = true;
      }

      pendingPairs.push({ vFrags, aFrags, ready: true });
      if (wroteHeader) {
        await flushHeaderAndPending();
      } else if (pendingPairs.length > MAX_PENDING_DUAL_PAIRS) {
        pendingPairs.length = 0;
        throw new Error('HLS_EMPTY');
      }
      pairBuffers[i] = null;
      onProgress(completedCount, totalUnits, totalBytesWritten, true);
    }
  }
  if (!wroteHeader || totalBytesWritten === 0) {
    throw new Error('HLS_EMPTY');
  }
  return totalBytesWritten;
}

/**
 * Streams an HLS or DASH manifest directly to disk chunk-by-chunk without exceeding RAM caps.
 * Processes segment batches in bounded sliding windows and immediately flushes ordered chunks.
 * @param {object} job
 * @param {FileSystemWritableFileStream} writable
 * @param {{ fetchFn?: Function, signal?: AbortSignal, onProgress?: Function }} [options={}]
 * @returns {Promise<number>}
 */
export async function streamPlaylistToWritable(job, writable, options = {}) {
  const fetchFn = options.fetchFn || fetch;
  const signal = options.signal;
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};

  const rootUrl = job.url || job.playlistUrl;
  const preferredVariantUrl = job.playlistUrl || job.url;
  const preferredAudioUrl = typeof job.audioUrl === 'string' ? job.audioUrl : '';
  if (!isHttpUrl(rootUrl)) {
    throw new Error('INVALID_URL');
  }

  if (!job.isStream) {
    return streamProgressiveResponseToWritable(preferredVariantUrl, writable, options);
  }

  const qualityPref = job.qualityPreference || QUALITY_PREFERENCES.BEST;
  const plan = await resolveStreamPlan({
    masterOrMediaUrl: rootUrl,
    preferredVariantUrl,
    qualityPreference: qualityPref,
    preferredAudioUrl,
    allowLiveHls: true,
    allowLiveDash: true,
    encryptedErrorCode: 'DRM_PROTECTED',
    fetchText: async (url) => {
      const res = await fetchWithRetry(fetchFn, url, { signal });
      return res.text();
    }
  });
  const mediaPlaylist = plan.mediaPlaylist;
  let audioPlaylist = plan.audioPlaylist;
  if (
    mediaPlaylist.mimeType === 'video/webm' &&
    audioPlaylist &&
    (audioPlaylist.mimeType || '').toLowerCase() !== 'audio/webm'
  ) {
    audioPlaylist = null;
  }

  if (mediaPlaylist.drmEncrypted || (mediaPlaylist.encrypted && !mediaPlaylist.decryptableAes128)) {
    throw new Error('DRM_PROTECTED');
  }

  if (mediaPlaylist.isProgressive && mediaPlaylist.progressiveUrl) {
    return streamProgressiveResponseToWritable(mediaPlaylist.progressiveUrl, writable, options);
  }

  const concurrency = clampInteger(
    job.concurrency,
    LIMITS.HLS_FETCH_CONCURRENCY,
    LIMITS.MIN_HLS_CONCURRENCY,
    LIMITS.MAX_HLS_CONCURRENCY
  );
  const keyCache = new Map();
  const TransmuxerCtor = options.TransmuxerCtor
    || (globalThis.muxjs && globalThis.muxjs.Transmuxer);

  if (
    mediaPlaylist.mimeType === 'video/webm' &&
    audioPlaylist &&
    audioPlaylist.mimeType === 'audio/webm'
  ) {
    return streamDualWebmToWritable(mediaPlaylist, audioPlaylist, writable, {
      concurrency,
      signal,
      fetchFn,
      keyCache,
      onProgress
    });
  }

  if (
    mediaPlaylist.initSegmentUrl &&
    audioPlaylist &&
    audioPlaylist.initSegmentUrl &&
    mediaPlaylist.mimeType !== 'video/webm' &&
    audioPlaylist.mimeType !== 'audio/webm'
  ) {
    return streamDualFmp4ToWritable(mediaPlaylist, audioPlaylist, writable, {
      concurrency,
      signal,
      fetchFn,
      keyCache,
      onProgress
    });
  }

  if (
    audioPlaylist &&
    Array.isArray(audioPlaylist.segments) &&
    audioPlaylist.segments.length > 0 &&
    mediaPlaylist.mimeType !== 'video/webm' &&
    (mediaPlaylist.initSegmentUrl || typeof TransmuxerCtor === 'function')
  ) {
    return streamDualMixedToWritable(mediaPlaylist, audioPlaylist, writable, {
      concurrency,
      signal,
      fetchFn,
      keyCache,
      onProgress,
      TransmuxerCtor
    });
  }

  const requests = [];
  if (mediaPlaylist.initSegmentUrl) {
    requests.push({
      url: mediaPlaylist.initSegmentUrl,
      byteRange: mediaPlaylist.initSegmentByteRange || '',
      key: null,
      sequenceNumber: 0
    });
  }
  requests.push(...buildPlaylistSegmentRequests(mediaPlaylist));
  if (requests.length === 0) {
    throw new Error('EMPTY_PLAYLIST');
  }
  const shouldTransmuxTs = Boolean(
    typeof TransmuxerCtor === 'function'
    && !mediaPlaylist.initSegmentUrl
    && mediaPlaylist.ext !== DEFAULT_FILENAMES.HLS_FMP4_EXT
  );
  const discontinuitySet = mediaPlaylist.discontinuityIndices instanceof Set
    ? mediaPlaylist.discontinuityIndices
    : new Set(Array.isArray(mediaPlaylist.discontinuityIndices) ? mediaPlaylist.discontinuityIndices : []);

  let transmuxer = null;
  let wroteInitSegment = false;
  const queuedMp4Parts = [];
  if (shouldTransmuxTs) {
    transmuxer = new TransmuxerCtor({ keepOriginalTimestamps: false });
    transmuxer.on('data', (segment) => {
      if (!wroteInitSegment && segment && segment.initSegment && segment.initSegment.byteLength > 0) {
        wroteInitSegment = true;
        queuedMp4Parts.push(new Uint8Array(segment.initSegment));
      }
      if (segment && segment.data && segment.data.byteLength > 0) {
        queuedMp4Parts.push(new Uint8Array(segment.data));
      }
    });
  }

  let totalBytesWritten = 0;
  let completedCount = 0;

  // Fetch in ordered windows of `concurrency` size so memory stays bounded to one window.
  for (let start = 0; start < requests.length; start += concurrency) {
    if (signal && signal.aborted) {
      throw new Error('DOWNLOAD_CANCELLED');
    }
    const batch = requests.slice(start, start + concurrency);
    const buffers = await Promise.all(
      batch.map((req) => fetchAndDecryptSegment(req, signal, fetchFn, keyCache))
    );
    for (let i = 0; i < buffers.length; i += 1) {
      if (signal && signal.aborted) {
        throw new Error('DOWNLOAD_CANCELLED');
      }
      const chunk = buffers[i];
      if (transmuxer) {
        const segIdx = start + i;
        if (segIdx > 0 && discontinuitySet.has(segIdx)) {
          if (typeof transmuxer.endTimeline === 'function') {
            transmuxer.endTimeline();
          }
          transmuxer.flush();
        }
        transmuxer.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
        if (segIdx === requests.length - 1 || i === buffers.length - 1) {
          transmuxer.flush();
        }
        while (queuedMp4Parts.length > 0) {
          const part = queuedMp4Parts.shift();
          await writable.write(part);
          totalBytesWritten += part.byteLength;
        }
      } else {
        await writable.write(chunk);
        totalBytesWritten += chunk.byteLength;
      }
      completedCount += 1;
      buffers[i] = null;
      onProgress(completedCount, requests.length, totalBytesWritten, shouldTransmuxTs);
    }
  }

  return totalBytesWritten;
}

/**
 * Controller managing the direct-to-disk streaming page UI and File System Access workflow.
 * @param {object} [deps={}]
 * @returns {object}
 */
export function createStreamSaverController(deps = {}) {
  const doc = deps.documentRef || document;
  const win = deps.windowRef || window;
  const chromeApi = deps.chromeApi || chrome;
  const translateFn = deps.translateFn || t;
  const getLangFn = deps.getUiLanguageFn || getUiLanguage;
  const applyI18nFn = deps.applyTranslationsFn || applyTranslations;
  const fetchFn = deps.fetchFn || fetch;

  const els = {
    sourceUrl: doc.getElementById('sourceUrl'),
    startBtn: doc.getElementById('startBtn'),
    cancelBtn: doc.getElementById('cancelBtn'),
    progressBar: doc.getElementById('progressBar'),
    statusText: doc.getElementById('statusText')
  };

  let activeJob = null;
  let activeAbortController = null;

  /**
   * Updates status line text and visual tone.
   * @param {string} message
   * @param {'neutral' | 'error' | 'done'} [tone='neutral']
   */
  function setStatus(message, tone = 'neutral') {
    if (!els.statusText) {
      return;
    }
    els.statusText.textContent = message;
    els.statusText.classList.toggle('is-error', tone === 'error');
    els.statusText.classList.toggle('is-done', tone === 'done');
  }

  /**
   * Updates progress bar percentage.
   * @param {number} done
   * @param {number} total
   */
  function setProgress(done, total) {
    if (!els.progressBar) {
      return;
    }
    const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
    els.progressBar.style.width = `${pct}%`;
  }

  /**
   * Opens the native save file picker (under user click gesture) and streams segments directly to disk.
   */
  async function handleStartClick() {
    if (!activeJob) {
      setStatus(translateFn('saver_error_missing_job'), 'error');
      return;
    }
    if (typeof win.showSaveFilePicker !== 'function') {
      setStatus(translateFn('saver_error_unsupported'), 'error');
      return;
    }

    let fileHandle;
    try {
      fileHandle = await win.showSaveFilePicker({
        suggestedName: activeJob.suggestedFilename || `${DEFAULT_FILENAMES.BASE}.${DEFAULT_FILENAMES.HLS_FMP4_EXT}`
      });
    } catch (err) {
      if (err && err.name === 'AbortError') {
        setStatus(translateFn('saver_status_cancelled'));
        return;
      }
      setStatus(translateFn('saver_error_failed', [(err && err.message) || 'PICKER_FAILED']), 'error');
      return;
    }

    activeAbortController = new AbortController();
    if (els.startBtn) {
      els.startBtn.disabled = true;
    }
    if (els.cancelBtn) {
      els.cancelBtn.classList.remove('hidden');
      els.cancelBtn.disabled = false;
    }
    setStatus(translateFn('saver_status_preparing'));
    setProgress(0, 1);

    let writable = null;
    try {
      writable = await fileHandle.createWritable();
      const totalBytes = await streamPlaylistToWritable(activeJob, writable, {
        fetchFn,
        signal: activeAbortController.signal,
        onProgress: (done, total, bytes, transmuxing) => {
          setProgress(done, total);
          setStatus(translateFn(
            transmuxing ? 'saver_status_transmuxing' : 'saver_status_streaming',
            [String(done), String(total), formatBytes(bytes)]
          ));
        }
      });
      await writable.close();
      writable = null;
      setProgress(1, 1);
      setStatus(translateFn('saver_status_done', [formatBytes(totalBytes)]), 'done');
    } catch (err) {
      if (writable && typeof writable.abort === 'function') {
        await writable.abort().catch(() => {});
      }
      if (err && (err.name === 'AbortError' || err.message === 'DOWNLOAD_CANCELLED')) {
        setStatus(translateFn('saver_status_cancelled'));
      } else {
        setStatus(translateFn('saver_error_failed', [(err && err.message) || 'STREAM_ERROR']), 'error');
      }
    } finally {
      activeAbortController = null;
      if (els.startBtn) {
        els.startBtn.disabled = false;
      }
      if (els.cancelBtn) {
        els.cancelBtn.classList.add('hidden');
      }
    }
  }

  /**
   * Aborts an active disk streaming transfer.
   */
  function handleCancelClick() {
    if (activeAbortController) {
      activeAbortController.abort();
    }
    if (els.cancelBtn) {
      els.cancelBtn.disabled = true;
    }
  }

  /**
   * Initializes page i18n labels, loads the session job payload, and attaches button handlers.
   * @returns {Promise<void>}
   */
  async function init() {
    doc.documentElement.lang = getLangFn();
    applyI18nFn(doc);

    if (els.startBtn) {
      els.startBtn.addEventListener('click', handleStartClick);
    }
    if (els.cancelBtn) {
      els.cancelBtn.addEventListener('click', handleCancelClick);
    }

    const search = win.location && typeof win.location.search === 'string' ? win.location.search : '';
    const params = new URLSearchParams(search);
    const jobId = params.get('jobId') || '';
    const sessionApi = chromeApi && chromeApi.storage && chromeApi.storage.session;
    if (!jobId || !sessionApi || typeof sessionApi.get !== 'function') {
      if (els.startBtn) {
        els.startBtn.disabled = true;
      }
      setStatus(translateFn('saver_error_missing_job'), 'error');
      return;
    }

    const key = `${STORAGE_KEYS.STREAM_SAVER_JOB_PREFIX}${jobId}`;
    const stored = await sessionApi.get(key);
    activeJob = (stored && stored[key]) || null;
    if (!activeJob) {
      if (els.startBtn) {
        els.startBtn.disabled = true;
      }
      setStatus(translateFn('saver_error_missing_job'), 'error');
      return;
    }
    if (els.sourceUrl) {
      els.sourceUrl.textContent = activeJob.playlistUrl || activeJob.url || '-';
    }
    if (typeof win.showSaveFilePicker !== 'function') {
      if (els.startBtn) {
        els.startBtn.disabled = true;
      }
      setStatus(translateFn('saver_error_unsupported'), 'error');
      return;
    }
    setStatus(translateFn('saver_status_ready'));
  }

  return {
    els,
    init,
    handleStartClick,
    handleCancelClick
  };
}

if (typeof document !== 'undefined') {
  createStreamSaverController().init();
}
