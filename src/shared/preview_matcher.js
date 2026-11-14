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

import { MEDIA_TYPES } from '../config/constants.js';

const PLATFORM_MEDIA_ID_PATTERNS = [
  /(?:ext_tw_video|amplify_video|tweet_video)(?:_thumb)?\/(\d+)\//i,
  /\/(\d{10,24})\/(?:pu|vid|pl|img)\//i
];

/**
 * Extracts a stable numeric media ID from known video/thumbnail CDN URLs (e.g. X/twimg).
 * @param {string} rawUrl
 * @returns {string}
 */
export function extractMediaId(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl) {
    return '';
  }
  for (const pattern of PLATFORM_MEDIA_ID_PATTERNS) {
    const match = rawUrl.match(pattern);
    if (match && match[1]) {
      return match[1];
    }
  }
  return '';
}

/**
 * Picks the best available preview image (poster URL or captured video frame).
 * @param {object} videoElement
 * @returns {string}
 */
function pickVisualPreview(videoElement) {
  if (!videoElement) {
    return '';
  }
  return videoElement.poster || videoElement.frameDataUrl || '';
}

/**
 * Enriches detected video and stream items with poster/frame previews, dimensions,
 * and duration collected from page <video> elements.
 * @param {Array<object>} items
 * @param {Array<{ src: string, poster: string, frameDataUrl: string, width: number, height: number, duration: number }>} videoElements
 * @returns {Array<object>}
 */
export function attachVideoPreviews(items, videoElements) {
  if (!Array.isArray(items) || !Array.isArray(videoElements) || videoElements.length === 0) {
    return items || [];
  }

  const bySrc = new Map();
  const byMediaId = new Map();
  const previewCandidates = [];

  for (const ve of videoElements) {
    const visual = pickVisualPreview(ve);
    if (ve.src) {
      bySrc.set(ve.src, ve);
    }
    const idFromSrc = extractMediaId(ve.src);
    const idFromPoster = extractMediaId(ve.poster);
    if (idFromSrc) {
      byMediaId.set(idFromSrc, ve);
    }
    if (idFromPoster) {
      byMediaId.set(idFromPoster, ve);
    }
    if (visual) {
      previewCandidates.push(ve);
    }
  }

  const singleFallback = previewCandidates.length === 1 ? previewCandidates[0] : null;

  return items.map((item) => {
    if (item.type !== MEDIA_TYPES.VIDEO && item.type !== MEDIA_TYPES.STREAM) {
      return item;
    }

    const mediaId = extractMediaId(item.url);
    const matched = bySrc.get(item.url)
      || (mediaId ? byMediaId.get(mediaId) : null)
      || singleFallback;

    if (!matched) {
      return item;
    }

    const visual = pickVisualPreview(matched);
    return {
      ...item,
      poster: item.poster || visual,
      width: item.width || matched.width || 0,
      height: item.height || matched.height || 0,
      duration: item.duration || matched.duration || 0
    };
  });
}
