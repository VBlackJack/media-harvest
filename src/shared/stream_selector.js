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
import { extractMediaId } from './preview_matcher.js';

const IDENTITY_QUERY_PARAMS = Object.freeze([
  'id',
  'docid',
  'vid',
  'media_id',
  'asset_id',
  'clip_id',
  'item_id'
]);

/**
 * Extracts origin plus directory path prefix for matching co-located stream files.
 * @param {string} rawUrl
 * @returns {string}
 */
export function getUrlDirectoryPrefix(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    const lastSlash = parsed.pathname.lastIndexOf('/');
    const dir = lastSlash >= 0 ? parsed.pathname.slice(0, lastSlash + 1) : '/';
    return `${parsed.origin}${dir}`;
  } catch {
    return '';
  }
}

/**
 * Detects URLs that represent audio-only renditions (e.g. X mp4a sub-playlists or DASH audio).
 * @param {string} rawUrl
 * @returns {boolean}
 */
export function isLikelyAudioOnlyStreamUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl) {
    return false;
  }
  return /\/(?:mp4a|aac|audio(?:-only|_only)?|snd)(?:\/|$)/i.test(rawUrl)
    || /[?&](?:mime|type|track)=audio\b/i.test(rawUrl)
    || /\/DASH_AUDIO/i.test(rawUrl)
    || /\.(?:aac|m4a|mp3|ogg|opus|wav)(?:$|[?#])/i.test(rawUrl);
}

/**
 * Detects progressive or segmented direct MP4/M4S URLs that lack an audio track.
 * @param {string} rawUrl
 * @returns {boolean}
 */
export function isLikelyVideoOnlyDirectUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl) {
    return false;
  }
  return /\/DASH_\d+\.(?:mp4|m4s)/i.test(rawUrl)
    || /(?:[?&]mime=video|\/video(?:only|-only)\b)/i.test(rawUrl);
}

/**
 * Detects rendition sub-playlists (codec or WxH folders, or audio/video-only URLs).
 * @param {string} rawUrl
 * @param {boolean} [isStream=true]
 * @returns {boolean}
 */
export function isLikelySubPlaylistUrl(rawUrl, isStream = true) {
  if (typeof rawUrl !== 'string' || !rawUrl) {
    return false;
  }
  if (isLikelyAudioOnlyStreamUrl(rawUrl) || isLikelyVideoOnlyDirectUrl(rawUrl)) {
    return true;
  }
  if (!isStream) {
    return false;
  }
  return /\/(?:avc1|hev1|hvc1|vp09|vp9|av01)(?:\/|$)/i.test(rawUrl)
    || /\/\d{2,4}x\d{2,4}(?:\/|$)/i.test(rawUrl);
}

function getUrlPathDepth(rawUrl) {
  try {
    return new URL(rawUrl).pathname.split('/').filter(Boolean).length;
  } catch {
    return 999;
  }
}

function scoreVideoCandidate(item) {
  if (!item || !item.url) {
    return -100000;
  }
  if (isLikelyAudioOnlyStreamUrl(item.url)) {
    return -10000;
  }
  if (item.isStream && !isLikelySubPlaylistUrl(item.url, true)) {
    return 3000;
  }
  if (!item.isStream && !isLikelyVideoOnlyDirectUrl(item.url)) {
    return 2000;
  }
  if (item.isStream) {
    return 1000;
  }
  return 500;
}

/**
 * Sorts video/stream candidates so master playlists precede sub-playlists and audio-only URLs.
 * Tie-breakers prefer shallower paths and earlier capture timestamps.
 * @param {Array<object>} candidates
 * @returns {Array<object>}
 */
export function rankVideoCandidates(candidates) {
  if (!Array.isArray(candidates) || candidates.length <= 1) {
    return Array.isArray(candidates) ? [...candidates] : [];
  }
  return candidates
    .map((item, idx) => ({ item, idx, score: scoreVideoCandidate(item), depth: getUrlPathDepth(item.url) }))
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      if (a.item.isStream && b.item.isStream && a.depth !== b.depth) {
        return a.depth - b.depth;
      }
      const timeA = Number(a.item.capturedAt) || 0;
      const timeB = Number(b.item.capturedAt) || 0;
      if (timeA > 0 && timeB > 0 && timeA !== timeB) {
        return timeA - timeB;
      }
      return b.idx - a.idx;
    })
    .map((entry) => entry.item);
}

/**
 * Finds a sibling audio-only sub-playlist when only split video/audio renditions were captured.
 * @param {object} chosen
 * @param {Array<object>} allItems
 * @returns {string}
 */
export function findSiblingStreamAudioUrl(chosen, allItems) {
  if (!chosen || !chosen.isStream || !isLikelySubPlaylistUrl(chosen.url, true) || !Array.isArray(allItems)) {
    return '';
  }
  const chosenMediaId = extractMediaId(chosen.url);
  const chosenDir = getUrlDirectoryPrefix(chosen.url);
  const match = allItems.find((item) => {
    if (!item || !item.url || item.url === chosen.url || !item.isStream) {
      return false;
    }
    if (!isLikelyAudioOnlyStreamUrl(item.url)) {
      return false;
    }
    if (chosenMediaId && extractMediaId(item.url) === chosenMediaId) {
      return true;
    }
    if (chosenDir && getUrlDirectoryPrefix(item.url) === chosenDir) {
      return true;
    }
    return false;
  });
  return match ? match.url : '';
}

/**
 * Matches a captured master/muxed stream descriptor to a video-only direct URL.
 * @param {string} directUrl
 * @param {Array<object>} streams
 * @returns {object | null}
 */
export function findMatchingStreamForDirectUrl(directUrl, streams) {
  if (!directUrl || !Array.isArray(streams) || streams.length === 0) {
    return null;
  }
  const rankedStreams = rankVideoCandidates(streams).filter((s) => !isLikelyAudioOnlyStreamUrl(s.url));
  if (rankedStreams.length === 0) {
    return null;
  }
  const directDir = getUrlDirectoryPrefix(directUrl);
  if (directDir) {
    const dirMatch = rankedStreams.find((s) => getUrlDirectoryPrefix(s.url) === directDir);
    if (dirMatch) {
      return dirMatch;
    }
  }
  const directMediaId = extractMediaId(directUrl);
  if (directMediaId) {
    const idMatch = rankedStreams.find((s) => extractMediaId(s.url) === directMediaId);
    if (idMatch) {
      return idMatch;
    }
  }
  if (isLikelyVideoOnlyDirectUrl(directUrl) && rankedStreams.length === 1) {
    return rankedStreams[0];
  }
  return null;
}

function extractUrlIdentityParam(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    for (const key of IDENTITY_QUERY_PARAMS) {
      const val = parsed.searchParams.get(key);
      if (val && val.length >= 4) {
        return `${key}:${val}`;
      }
    }
    return '';
  } catch {
    return '';
  }
}

function getUrlPathnameLeaf(rawUrl) {
  try {
    const parts = new URL(rawUrl).pathname.split('/').filter(Boolean);
    return parts.length > 0 ? parts[parts.length - 1].toLowerCase() : '';
  } catch {
    return '';
  }
}

/**
 * Finds a companion HTTP audio stream matching a video-only URL by directory, media ID,
 * query identity param (e.g. CDN `id=...`), or load-balanced `videoplayback` endpoint.
 * @param {string} videoUrl
 * @param {Array<object>} networkItems
 * @returns {string}
 */
export function findCompanionAudioUrl(videoUrl, networkItems) {
  if (!videoUrl || !Array.isArray(networkItems)) {
    return '';
  }
  const videoDir = getUrlDirectoryPrefix(videoUrl);
  const videoMediaId = extractMediaId(videoUrl);
  const videoIdentity = extractUrlIdentityParam(videoUrl);
  const videoLeaf = getUrlPathnameLeaf(videoUrl);

  const audioCandidates = networkItems.filter((item) => (
    item
    && item.url
    && item.url !== videoUrl
    && !item.isStream
    && (item.type === MEDIA_TYPES.AUDIO || /\/DASH_AUDIO|[?&](?:mime|type|track)=audio\b/i.test(item.url))
  ));
  if (audioCandidates.length === 0) {
    return '';
  }

  const exactMatch = audioCandidates.find((item) => {
    if (videoDir && getUrlDirectoryPrefix(item.url) === videoDir) {
      return true;
    }
    if (videoMediaId && extractMediaId(item.url) === videoMediaId) {
      return true;
    }
    if (videoIdentity && extractUrlIdentityParam(item.url) === videoIdentity) {
      return true;
    }
    return false;
  });
  if (exactMatch) {
    return exactMatch.url;
  }

  if (videoLeaf === 'videoplayback' && isLikelyVideoOnlyDirectUrl(videoUrl)) {
    const queryAudio = audioCandidates.find((item) => getUrlPathnameLeaf(item.url) === 'videoplayback');
    if (queryAudio) {
      return queryAudio.url;
    }
  }
  return '';
}

/**
 * Inserts a newly captured network media entry while evicting stale non-master items first
 * so scrolling timelines (X, TikTok, Instagram) do not lose previously captured master manifests.
 * @param {Array<object>} existing
 * @param {object} entry
 * @param {number} maxCaptured
 * @returns {Array<object>}
 */
export function mergeCapturedMediaEntry(existing, entry, maxCaptured) {
  const list = Array.isArray(existing) ? existing.filter((item) => item && item.url !== entry.url) : [];
  list.unshift(entry);
  if (list.length <= maxCaptured) {
    return list;
  }
  const masters = [];
  const others = [];
  for (const item of list) {
    if (item.type === MEDIA_TYPES.STREAM && item.isStream && !isLikelySubPlaylistUrl(item.url, true)) {
      masters.push(item);
    } else {
      others.push(item);
    }
  }
  const keptMasters = masters.slice(0, maxCaptured);
  const remainingSlots = Math.max(0, maxCaptured - keptMasters.length);
  const keptUrls = new Set([
    ...keptMasters.map((m) => m.url),
    ...others.slice(0, remainingSlots).map((o) => o.url)
  ]);
  return list.filter((item) => keptUrls.has(item.url));
}
