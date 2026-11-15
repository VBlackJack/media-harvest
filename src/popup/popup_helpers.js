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

import { LIMITS, MEDIA_TYPES, SORT_MODES, UNIT_CONVERSIONS } from '../config/constants.js';
import { t } from '../shared/i18n.js';

const ERROR_KEY_BY_CODE = Object.freeze({
  ENCRYPTED_STREAM: 'popup_error_encrypted_stream',
  RESTRICTED_PAGE: 'popup_error_restricted_page',
  DOWNLOAD_CANCELLED: 'popup_status_download_cancelled',
  EMPTY_PLAYLIST: 'popup_error_empty_playlist',
  LIVE_STREAM: 'popup_error_live_stream',
  FETCH_TIMEOUT: 'popup_error_fetch_timeout',
  INVALID_URL: 'popup_error_invalid_url',
  INVALID_DASH_MANIFEST: 'popup_error_invalid_manifest',
  PLAY_FIRST: 'popup_error_play_first',
  CLEAR_FAILED: 'popup_error_clear_failed',
  NO_ACTIVE_TAB: 'popup_error_no_active_tab',
  INVALID_FMP4_INIT: 'popup_error_invalid_fmp4',
  MISSING_AUDIO_TRACK: 'popup_error_missing_audio',
  TRANSMUXER_UNAVAILABLE: 'popup_error_transmux_failed',
  TRANSMUX_EMPTY: 'popup_error_transmux_failed',
  BUILD_ABORTED: 'popup_error_build_aborted',
  HLS_ERROR: 'popup_error_stream_failed',
  MSE_NOT_FOUND: 'popup_error_mse_failed',
  MSE_TIMEOUT: 'popup_error_mse_failed',
  MSE_EXPORT_FAILED: 'popup_error_mse_failed',
  COMPANION_UNAVAILABLE: 'popup_error_companion_unavailable',
  COMPANION_FAILED: 'popup_error_companion_failed',
  DOWNLOAD_FAILED: 'popup_error_generic_download'
});

/**
 * Formats byte counts into readable KB or MB strings.
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (!bytes || bytes <= 0) {
    return '';
  }
  if (bytes >= UNIT_CONVERSIONS.BYTES_PER_MB) {
    return `${(bytes / UNIT_CONVERSIONS.BYTES_PER_MB).toFixed(1)} MB`;
  }
  return `${Math.max(1, Math.round(bytes / UNIT_CONVERSIONS.BYTES_PER_KB))} KB`;
}

/**
 * Formats duration in seconds as M:SS.
 * @param {number} seconds
 * @returns {string}
 */
export function formatDuration(seconds) {
  if (!seconds || seconds <= 0) {
    return '';
  }
  const mins = Math.floor(seconds / UNIT_CONVERSIONS.SECONDS_PER_MINUTE);
  const secs = Math.floor(seconds % UNIT_CONVERSIONS.SECONDS_PER_MINUTE);
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

/**
 * Maps internal error codes from background/offscreen to localized messages.
 * @param {string} errorCode
 * @param {(key: string, substitutions?: Array<string>) => string} [translateFn=t]
 * @returns {string}
 */
export function localizeError(errorCode, translateFn = t) {
  if (errorCode === 'STREAM_TOO_LARGE') {
    const maxMb = String(Math.round(LIMITS.MAX_HLS_BUFFER_BYTES / UNIT_CONVERSIONS.BYTES_PER_MB));
    return translateFn('popup_error_stream_too_large', [maxMb]);
  }
  const mappedKey = ERROR_KEY_BY_CODE[errorCode];
  if (mappedKey) {
    return translateFn(mappedKey);
  }
  return translateFn('popup_error_download_failed', [errorCode || translateFn('popup_error_unknown')]);
}

/**
 * Checks whether an item matches the active category filter.
 * @param {object} item
 * @param {string} filter
 * @returns {boolean}
 */
export function matchesFilter(item, filter) {
  if (filter === 'all') {
    return true;
  }
  if (filter === 'videos') {
    return item.type === MEDIA_TYPES.VIDEO || item.type === MEDIA_TYPES.STREAM;
  }
  if (filter === 'images') {
    return item.type === MEDIA_TYPES.IMAGE;
  }
  if (filter === 'audio') {
    return item.type === MEDIA_TYPES.AUDIO;
  }
  if (filter === 'subtitles') {
    return item.type === MEDIA_TYPES.SUBTITLE;
  }
  return true;
}

/**
 * Computes estimated byte size for a stream item based on selected or default variant.
 * @param {object} entry
 * @param {Map<string, object>} metaByUrl
 * @returns {number}
 */
export function getEstimatedStreamBytes(entry, metaByUrl) {
  const meta = metaByUrl ? metaByUrl.get(entry.item.url) : null;
  if (!meta || !Array.isArray(meta.variants) || meta.variants.length === 0) {
    return entry.item.estimatedBytes || 0;
  }
  const selectedUrl = entry.qualitySelect && !entry.qualitySelect.classList.contains('hidden')
    ? entry.qualitySelect.value
    : '';
  const selectedVariant = meta.variants.find((v) => v.url === selectedUrl) || meta.variants[0];
  return (selectedVariant && selectedVariant.estimatedBytes) || 0;
}

/**
 * Runs async worker tasks over an item array with bounded concurrency.
 * @template T, R
 * @param {Array<T>} items
 * @param {number} concurrency
 * @param {(item: T, index: number) => Promise<R>} worker
 * @returns {Promise<Array<R>>}
 */
export async function runWithConcurrency(items, concurrency, worker) {
  if (!Array.isArray(items) || items.length === 0) {
    return [];
  }
  const limit = Math.max(1, Math.min(concurrency || LIMITS.INSPECT_CONCURRENCY, items.length));
  const results = new Array(items.length);
  let nextIndex = 0;

  const runWorker = async () => {
    while (nextIndex < items.length) {
      const idx = nextIndex;
      nextIndex += 1;
      results[idx] = await worker(items[idx], idx);
    }
  };

  await Promise.all(Array.from({ length: limit }, () => runWorker()));
  return results;
}

/**
 * Checks whether an item matches the user's free-text filter query.
 * @param {object} item
 * @param {string} rawQuery
 * @returns {boolean}
 */
export function matchesSearch(item, rawQuery) {
  const query = typeof rawQuery === 'string' ? rawQuery.trim().toLowerCase() : '';
  if (!query) {
    return true;
  }
  const fields = [item.suggestedFilename, item.url, item.title];
  return fields.some((val) => typeof val === 'string' && val.toLowerCase().includes(query));
}

/**
 * Computes sorting metric for a media item given optional stream inspection metadata.
 * @param {object} item
 * @param {string} sortBy
 * @param {Map<string, object> | undefined} metaByUrl
 * @returns {number}
 */
function getItemSortMetric(item, sortBy, metaByUrl) {
  const meta = metaByUrl ? metaByUrl.get(item.url) : null;
  if (sortBy === SORT_MODES.SIZE_DESC) {
    const maxVariantBytes = meta && Array.isArray(meta.variants)
      ? Math.max(0, ...meta.variants.map((v) => v.estimatedBytes || 0))
      : 0;
    return item.sizeBytes || maxVariantBytes || item.estimatedBytes || 0;
  }
  if (sortBy === SORT_MODES.RESOLUTION_DESC) {
    const domPixels = (item.width || 0) * (item.height || 0);
    const maxVariantPixels = meta && Array.isArray(meta.variants)
      ? Math.max(0, ...meta.variants.map((v) => (v.width || 0) * (v.height || 0)))
      : 0;
    return Math.max(domPixels, maxVariantPixels);
  }
  if (sortBy === SORT_MODES.DURATION_DESC) {
    return item.duration || (meta && meta.totalDurationSec) || 0;
  }
  return 0;
}

/**
 * Returns a copy of media items ordered according to sortBy while keeping default order stable.
 * @param {Array<object>} items
 * @param {string} sortBy
 * @param {Map<string, object> | undefined} [metaByUrl]
 * @returns {Array<object>}
 */
export function sortMediaItems(items, sortBy, metaByUrl) {
  if (!Array.isArray(items) || !sortBy || sortBy === SORT_MODES.DEFAULT) {
    return Array.isArray(items) ? [...items] : [];
  }
  return items
    .map((item, idx) => ({ item, idx, metric: getItemSortMetric(item, sortBy, metaByUrl) }))
    .sort((a, b) => (b.metric - a.metric) || (a.idx - b.idx))
    .map((entry) => entry.item);
}
