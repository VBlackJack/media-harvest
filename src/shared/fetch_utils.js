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

import { LIMITS } from '../config/constants.js';
import { extractUrlExtension, isHttpUrl } from './media_classifier.js';

export const CANCEL_REASON = 'DOWNLOAD_CANCELLED';

/**
 * Checks whether a stream descriptor or URL indicates a DASH MPD manifest.
 * @param {string} url
 * @param {string} [mimeType='']
 * @param {object | null} [meta=null]
 * @returns {boolean}
 */
export function isDashDescriptor(url, mimeType = '', meta = null) {
  if (extractUrlExtension(url) === 'mpd') {
    return true;
  }
  if (typeof url === 'string' && url.includes('#dash-video-')) {
    return true;
  }
  if (typeof mimeType === 'string' && mimeType.toLowerCase().includes('dash+xml')) {
    return true;
  }
  return Boolean(meta && meta.streamFormat === 'dash');
}

/**
 * Sniffs the leading bytes of a fetched manifest string for an MPD root element.
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeDashXml(text) {
  return typeof text === 'string' && /<MPD[\s>]/i.test(text.slice(0, 512));
}

/**
 * Concatenates streamed Uint8Array chunks into a single ArrayBuffer without extra copies when 1 chunk.
 * @param {Array<Uint8Array>} chunks
 * @param {number} totalBytes
 * @returns {ArrayBuffer}
 */
function concatChunksToArrayBuffer(chunks, totalBytes) {
  if (chunks.length === 1) {
    const only = chunks[0];
    if (only.byteOffset === 0 && only.byteLength === only.buffer.byteLength) {
      return only.buffer;
    }
    return only.slice().buffer;
  }
  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged.buffer;
}

/**
 * Reads a response body while enforcing a shared byteTracker cap against LIMITS.MAX_HLS_BUFFER_BYTES.
 * Reserves declared Content-Length upfront when unencoded, or streams chunks when body reader exists.
 * @param {Response} response
 * @param {{ bytes: number } | undefined} byteTracker
 * @param {number} maxBytes
 * @returns {Promise<ArrayBuffer>}
 */
async function readBoundedBuffer(response, byteTracker, maxBytes) {
  if (!byteTracker) {
    return response.arrayBuffer();
  }

  const rawLength = response.headers && typeof response.headers.get === 'function'
    ? response.headers.get('content-length')
    : null;
  const contentEncoding = response.headers && typeof response.headers.get === 'function'
    ? (response.headers.get('content-encoding') || '').trim().toLowerCase()
    : '';
  const isEncoded = Boolean(
    contentEncoding &&
    contentEncoding !== 'identity' &&
    !/^\d+$/.test(contentEncoding)
  );
  const declaredLength = !isEncoded ? Number.parseInt(rawLength, 10) : Number.NaN;

  let reservedBytes = 0;
  if (Number.isFinite(declaredLength) && declaredLength > 0) {
    if (byteTracker.bytes + declaredLength > maxBytes) {
      throw new Error('STREAM_TOO_LARGE');
    }
    reservedBytes = declaredLength;
    byteTracker.bytes += reservedBytes;
  }

  try {
    const hasReader = response.body && typeof response.body.getReader === 'function';
    if (!hasReader) {
      const buffer = await response.arrayBuffer();
      const delta = buffer.byteLength - reservedBytes;
      if (byteTracker.bytes + delta > maxBytes) {
        throw new Error('STREAM_TOO_LARGE');
      }
      byteTracker.bytes += delta;
      reservedBytes += delta;
      return buffer;
    }

    const reader = response.body.getReader();
    const chunks = [];
    let actualBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (!value || value.byteLength === 0) {
          continue;
        }
        actualBytes += value.byteLength;
        if (actualBytes > reservedBytes) {
          const extra = actualBytes - reservedBytes;
          if (byteTracker.bytes + extra > maxBytes) {
            throw new Error('STREAM_TOO_LARGE');
          }
          byteTracker.bytes += extra;
          reservedBytes = actualBytes;
        }
        chunks.push(value);
      }
    } catch (err) {
      await reader.cancel().catch(() => {});
      throw err;
    }

    if (actualBytes < reservedBytes) {
      byteTracker.bytes -= (reservedBytes - actualBytes);
      reservedBytes = actualBytes;
    }
    return concatChunksToArrayBuffer(chunks, actualBytes);
  } catch (err) {
    byteTracker.bytes = Math.max(0, byteTracker.bytes - reservedBytes);
    throw err;
  }
}

/**
 * Fetches text or binary content with timeout, optional cancel AbortSignal, and byte-cap tracking.
 * @param {string} url
 * @param {{
 *   responseMode?: 'text' | 'buffer' | 'bufferWithStatus',
 *   timeoutMs?: number,
 *   headers?: Record<string, string>,
 *   cancelSignal?: AbortSignal | null,
 *   byteTracker?: { bytes: number },
 *   maxBytes?: number
 * }} [options]
 * @returns {Promise<string | ArrayBuffer | { status: number, buffer: ArrayBuffer }>}
 */
export async function fetchWithManagedTimeout(url, options = {}) {
  if (!isHttpUrl(url)) {
    throw new Error('INVALID_URL');
  }

  const {
    responseMode = 'text',
    timeoutMs = LIMITS.FETCH_TIMEOUT_MS,
    headers,
    cancelSignal = null,
    byteTracker,
    maxBytes = LIMITS.MAX_HLS_BUFFER_BYTES
  } = options;

  if (cancelSignal && cancelSignal.aborted) {
    throw new Error(cancelSignal.reason === CANCEL_REASON ? CANCEL_REASON : 'BUILD_ABORTED');
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
  }, timeoutMs);

  try {
    const fetchOpts = headers
      ? { signal: controller.signal, headers }
      : { signal: controller.signal };
    const response = await fetch(url, fetchOpts);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    if (responseMode === 'text') {
      return await response.text();
    }

    const buffer = await readBoundedBuffer(response, byteTracker, maxBytes);
    if (responseMode === 'bufferWithStatus') {
      return { status: response.status, buffer };
    }
    return buffer;
  } catch (err) {
    if (abortedByCancel || (cancelSignal && cancelSignal.aborted)) {
      throw new Error(cancelSignal && cancelSignal.reason === CANCEL_REASON ? CANCEL_REASON : 'BUILD_ABORTED');
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
