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
import { runWithConcurrency } from '../shared/fetch_utils.js';
import { t } from '../shared/i18n.js';

export { runWithConcurrency };

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
  NO_SEPARATE_AUDIO_TRACK: 'popup_error_no_separate_audio',
  INVALID_KEY: 'popup_error_invalid_key',
  IMAGE_CONVERT_FAILED: 'popup_error_image_convert',
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
  if (filter === 'svg') {
    return (item.ext || '').toLowerCase() === 'svg';
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
 * Checks whether an image item passes quick pixel-size and format filters.
 * Non-image items pass through unchanged.
 * @param {object} item
 * @param {{ minImagePx?: number, imageExt?: string }} [options={}]
 * @returns {boolean}
 */
export function matchesImageQuickFilters(item, { minImagePx = 0, imageExt = '' } = {}) {
  if (!item || item.type !== MEDIA_TYPES.IMAGE) {
    return true;
  }
  const minPx = Number(minImagePx) || 0;
  if (minPx > 0) {
    const maxSide = Math.max(Number(item.width) || 0, Number(item.height) || 0);
    if (maxSide < minPx) {
      return false;
    }
  }
  const normalizedTarget = typeof imageExt === 'string' ? imageExt.trim().toLowerCase() : '';
  if (normalizedTarget) {
    const itemExt = (item.ext || '').toLowerCase();
    if (normalizedTarget === 'jpg') {
      return itemExt === 'jpg' || itemExt === 'jpeg';
    }
    return itemExt === normalizedTarget;
  }
  return true;
}

/**
 * Checks whether an item matches the user's search query, supporting:
 * - Extension matching: 'ext:mp4', 'ext:m3u8', 'ext:jpg'
 * - Type filters: 'is:stream', 'is:video', 'is:image', 'is:audio', 'is:subtitles'
 * - Size filters: '>5m', '<1m', '>500k'
 * - Resolution tokens: '1080p', '720p', '4k'
 * - Multi-term substring matching across filename, url, title, and extension.
 * @param {object} item
 * @param {string} rawQuery
 * @returns {boolean}
 */
export function matchesSearch(item, rawQuery) {
  const query = typeof rawQuery === 'string' ? rawQuery.trim().toLowerCase() : '';
  if (!query) {
    return true;
  }
  const tokens = query.split(/\s+/).filter(Boolean);
  const ext = (item.ext || '').toLowerCase();
  const fields = [item.suggestedFilename, item.url, item.title, ext];

  return tokens.every((token) => {
    if (token.startsWith('ext:')) {
      const targetExt = token.slice(4).replace(/^\./, '');
      return ext === targetExt;
    }
    if (token.startsWith('is:')) {
      const typeTarget = token.slice(3);
      if (typeTarget === 'stream') return Boolean(item.isStream);
      if (typeTarget === 'mse') return Boolean(item.isMse);
      if (typeTarget === 'direct') return !item.isStream && !item.isMse;
      if (typeTarget === 'video') return item.type === 'video' || item.type === 'stream';
      if (typeTarget === 'image') return item.type === 'image';
      if (typeTarget === 'svg') return ext === 'svg';
      if (typeTarget === 'audio') return item.type === 'audio';
      if (typeTarget === 'subtitles' || typeTarget === 'subtitle') return item.type === 'subtitle';
    }
    if (token === '1080p') {
      return (item.height || 0) >= 1080 || (item.width || 0) >= 1920;
    }
    if (token === '720p') {
      return (item.height || 0) >= 720 || (item.width || 0) >= 1280;
    }
    if (token === '4k' || token === '2160p') {
      return (item.height || 0) >= 2160 || (item.width || 0) >= 3840;
    }
    const sizeMatch = token.match(/^([><]=?)(\d+(?:\.\d+)?)\s*([kmgt]?b?)$/);
    if (sizeMatch) {
      const op = sizeMatch[1];
      const num = parseFloat(sizeMatch[2]);
      const unit = (sizeMatch[3] || '').replace(/b$/, '');
      let multiplier = 1;
      if (unit === 'k') multiplier = 1024;
      else if (unit === 'm') multiplier = 1024 * 1024;
      else if (unit === 'g') multiplier = 1024 * 1024 * 1024;
      else if (unit === 't') multiplier = 1024 * 1024 * 1024 * 1024;
      const targetBytes = num * multiplier;
      const itemBytes = item.sizeBytes || item.estimatedBytes || 0;
      if (op === '>') return itemBytes > targetBytes;
      if (op === '>=') return itemBytes >= targetBytes;
      if (op === '<') return itemBytes > 0 && itemBytes < targetBytes;
      if (op === '<=') return itemBytes > 0 && itemBytes <= targetBytes;
    }
    return fields.some((val) => typeof val === 'string' && val.toLowerCase().includes(token));
  });
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
