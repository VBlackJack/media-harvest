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
  HLS_ENCRYPTION_METHODS,
  HLS_PLAYLIST_TYPES,
  HLS_TAGS
} from '../config/constants.js';
import { isBase64DataUri } from './hls_crypto.js';

/**
 * Parses comma-separated HLS attribute lists (e.g. BANDWIDTH=800000,URI="...").
 * @param {string} rawAttributes
 * @returns {Record<string, string>}
 */
export function parseHlsAttributes(rawAttributes) {
  const attrs = {};
  const pattern = /([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g;
  let match = pattern.exec(rawAttributes);

  while (match !== null) {
    const key = match[1];
    const value = match[3] !== undefined ? match[3] : match[2];
    attrs[key] = value;
    match = pattern.exec(rawAttributes);
  }

  return attrs;
}

/**
 * Resolves a possibly relative HLS URI against the playlist URL, restricting to HTTP(S).
 * Returns an empty string if the URI cannot be resolved or uses a non-HTTP scheme.
 * @param {string} uri
 * @param {string} baseUrl
 * @returns {string}
 */
export function resolveHlsUrl(uri, baseUrl) {
  if (typeof uri !== 'string' || !uri.trim()) {
    return '';
  }
  try {
    const resolved = new URL(uri.trim(), baseUrl);
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
      return '';
    }
    return resolved.href;
  } catch {
    return '';
  }
}

/**
 * Parses RESOLUTION=WxH strings into numeric dimensions.
 * @param {string} resolution
 * @returns {{ width: number, height: number }}
 */
function parseResolution(resolution) {
  if (!resolution || !resolution.includes('x')) {
    return { width: 0, height: 0 };
  }
  const [wStr, hStr] = resolution.split('x');
  const width = Number.parseInt(wStr, 10) || 0;
  const height = Number.parseInt(hStr, 10) || 0;
  return { width, height };
}

/**
 * Parses an HLS BYTERANGE specification ("length[@offset]") into numeric range bounds.
 * @param {string} spec
 * @param {number} [defaultOffset=0]
 * @returns {{ length: number, offset: number } | null}
 */
export function parseByteRangeSpec(spec, defaultOffset = 0) {
  if (typeof spec !== 'string' || !spec.trim()) {
    return null;
  }
  const [lenStr, offStr] = spec.trim().split('@');
  const length = Number.parseInt(lenStr, 10);
  if (!Number.isFinite(length) || length <= 0) {
    return null;
  }
  const offset = offStr !== undefined ? Number.parseInt(offStr, 10) : defaultOffset;
  if (!Number.isFinite(offset) || offset < 0) {
    return null;
  }
  return { length, offset };
}

/**
 * Resolves an HLS encryption key URI allowing HTTP(S) URLs or base64 data URIs.
 * @param {string} rawUri
 * @param {string} baseUrl
 * @returns {string}
 */
function resolveKeyUri(rawUri, baseUrl) {
  if (typeof rawUri !== 'string' || !rawUri.trim()) {
    return '';
  }
  const trimmed = rawUri.trim();
  if (isBase64DataUri(trimmed)) {
    return trimmed;
  }
  return resolveHlsUrl(trimmed, baseUrl);
}

/**
 * Inspects an EXT-X-KEY or EXT-X-SESSION-KEY tag line for encryption method and key metadata.
 * @param {string} line
 * @param {string} baseUrl
 * @returns {{ active: boolean, encrypted: boolean, drmEncrypted: boolean, encryptionMethod: string, keyUrl: string, ivHex: string }}
 */
function parseEncryptionTag(line, baseUrl) {
  const tagLength = line.startsWith(HLS_TAGS.SESSION_KEY)
    ? HLS_TAGS.SESSION_KEY.length
    : HLS_TAGS.KEY.length;
  const attrs = parseHlsAttributes(line.slice(tagLength));
  const method = (attrs.METHOD || HLS_ENCRYPTION_METHODS.NONE).toUpperCase();
  if (method === HLS_ENCRYPTION_METHODS.NONE) {
    return {
      active: false,
      encrypted: false,
      drmEncrypted: false,
      encryptionMethod: HLS_ENCRYPTION_METHODS.NONE,
      keyUrl: '',
      ivHex: ''
    };
  }
  const keyUrl = attrs.URI ? resolveKeyUri(attrs.URI, baseUrl) : '';
  const isClearAes128 = method === HLS_ENCRYPTION_METHODS.AES_128 && Boolean(keyUrl);
  return {
    active: true,
    encrypted: true,
    drmEncrypted: !isClearAes128,
    encryptionMethod: method,
    keyUrl,
    ivHex: attrs.IV || ''
  };
}

/**
 * Parses an `#EXT-X-MEDIA:` tag for AUDIO or SUBTITLES rendition groups.
 * @param {string} line
 * @param {string} baseUrl
 * @returns {{ trackType: 'AUDIO' | 'SUBTITLES', track: { groupId: string, name: string, language: string, url: string, isDefault: boolean } } | null}
 */
function parseMediaTrackTag(line, baseUrl) {
  const attrs = parseHlsAttributes(line.slice(HLS_TAGS.MEDIA.length));
  const resolvedTrackUrl = attrs.URI ? resolveHlsUrl(attrs.URI, baseUrl) : '';
  if ((attrs.TYPE !== 'AUDIO' && attrs.TYPE !== 'SUBTITLES') || !resolvedTrackUrl) {
    return null;
  }
  const fallbackName = attrs.TYPE === 'SUBTITLES' ? 'subtitles' : 'audio';
  return {
    trackType: attrs.TYPE,
    track: {
      groupId: attrs['GROUP-ID'] || '',
      name: attrs.NAME || attrs.LANGUAGE || fallbackName,
      language: attrs.LANGUAGE || '',
      url: resolvedTrackUrl,
      isDefault: attrs.DEFAULT === 'YES'
    }
  };
}

/**
 * Builds a master playlist variant descriptor from pending EXT-X-STREAM-INF attributes.
 * @param {Record<string, string>} streamAttrs
 * @param {string} resolvedUrl
 * @returns {object}
 */
function buildVariantEntry(streamAttrs, resolvedUrl) {
  const { width, height } = parseResolution(streamAttrs.RESOLUTION);
  return {
    bandwidth: Number.parseInt(streamAttrs.BANDWIDTH, 10) || 0,
    width,
    height,
    resolution: streamAttrs.RESOLUTION || '',
    audioGroup: streamAttrs.AUDIO || '',
    url: resolvedUrl
  };
}

/**
 * Parses an HLS playlist text, handling both master playlists and media playlists.
 * Supports EXT-X-KEY, EXT-X-SESSION-KEY, EXT-X-MAP (with optional BYTERANGE), and EXT-X-BYTERANGE.
 * @param {string} text
 * @param {string} baseUrl
 * @returns {{
 *   format: string,
 *   isMaster: boolean,
 *   encrypted: boolean,
 *   encryptionMethod: string,
 *   variants: Array<{ bandwidth: number, width: number, height: number, resolution: string, audioGroup: string, url: string }>,
 *   audioTracks: Array<{ groupId: string, name: string, language: string, url: string }>,
 *   initSegmentUrl: string | null,
 *   initSegmentByteRange: { length: number, offset: number } | null,
 *   segments: Array<{ url: string, duration: number, byteRange: { length: number, offset: number } | null }>,
 *   totalDurationSec: number,
 *   outputExtension: string
 * }}
 */
export function parseHlsPlaylist(text, baseUrl) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const variants = [];
  const audioTracks = [];
  const subtitles = [];
  const seenSubtitleUrls = new Set();
  const segments = [];
  const prevByteRangeEndByUrl = new Map();

  let initSegmentUrl = null;
  let initSegmentByteRange = null;
  let pendingStreamAttrs = null;
  let pendingSegmentDuration = 0;
  let pendingByteRangeSpec = null;
  let currentKey = null;
  let encrypted = false;
  let drmEncrypted = false;
  let hasAes128 = false;
  let encryptionMethod = HLS_ENCRYPTION_METHODS.NONE;
  let hasEndList = false;
  let playlistType = '';
  let mediaSequence = 0;
  let targetDurationSec = 0;

  for (const line of lines) {
    if (line.startsWith(HLS_TAGS.MEDIA_SEQUENCE)) {
      const seqVal = Number.parseInt(line.slice(HLS_TAGS.MEDIA_SEQUENCE.length).trim(), 10);
      if (Number.isFinite(seqVal) && seqVal >= 0) {
        mediaSequence = seqVal;
      }
      continue;
    }

    if (line.startsWith(HLS_TAGS.TARGET_DURATION)) {
      const targetVal = Number.parseInt(line.slice(HLS_TAGS.TARGET_DURATION.length).trim(), 10);
      if (Number.isFinite(targetVal) && targetVal > 0) {
        targetDurationSec = targetVal;
      }
      continue;
    }

    if (line.startsWith(HLS_TAGS.KEY) || line.startsWith(HLS_TAGS.SESSION_KEY)) {
      const enc = parseEncryptionTag(line, baseUrl);
      if (!enc.active) {
        if (line.startsWith(HLS_TAGS.KEY)) {
          currentKey = null;
        }
        continue;
      }
      encrypted = true;
      encryptionMethod = enc.encryptionMethod;
      if (enc.drmEncrypted) {
        drmEncrypted = true;
      } else {
        hasAes128 = true;
        if (line.startsWith(HLS_TAGS.KEY)) {
          currentKey = {
            method: enc.encryptionMethod,
            keyUrl: enc.keyUrl,
            ivHex: enc.ivHex
          };
        }
      }
      continue;
    }

    if (line === HLS_TAGS.ENDLIST || line.startsWith(HLS_TAGS.ENDLIST)) {
      hasEndList = true;
      continue;
    }

    if (line.startsWith(HLS_TAGS.PLAYLIST_TYPE)) {
      playlistType = line.slice(HLS_TAGS.PLAYLIST_TYPE.length).trim().toUpperCase();
      continue;
    }

    if (line.startsWith(HLS_TAGS.MEDIA)) {
      const parsedMedia = parseMediaTrackTag(line, baseUrl);
      if (parsedMedia) {
        if (parsedMedia.trackType === 'AUDIO') {
          audioTracks.push(parsedMedia.track);
        } else if (!seenSubtitleUrls.has(parsedMedia.track.url)) {
          seenSubtitleUrls.add(parsedMedia.track.url);
          subtitles.push(parsedMedia.track);
        }
      }
      continue;
    }

    if (line.startsWith(HLS_TAGS.STREAM_INF)) {
      pendingStreamAttrs = parseHlsAttributes(line.slice(HLS_TAGS.STREAM_INF.length));
      continue;
    }

    if (line.startsWith(HLS_TAGS.MAP)) {
      const attrs = parseHlsAttributes(line.slice(HLS_TAGS.MAP.length));
      const resolvedMapUrl = attrs.URI ? resolveHlsUrl(attrs.URI, baseUrl) : '';
      if (resolvedMapUrl) {
        initSegmentUrl = resolvedMapUrl;
        initSegmentByteRange = attrs.BYTERANGE ? parseByteRangeSpec(attrs.BYTERANGE, 0) : null;
      }
      continue;
    }

    if (line.startsWith(HLS_TAGS.BYTERANGE)) {
      pendingByteRangeSpec = line.slice(HLS_TAGS.BYTERANGE.length).trim();
      continue;
    }

    if (line.startsWith(HLS_TAGS.EXTINF)) {
      pendingSegmentDuration = Number.parseFloat(line.slice(HLS_TAGS.EXTINF.length).split(',')[0]) || 0;
      continue;
    }

    if (line.startsWith('#')) {
      continue;
    }

    const resolvedUrl = resolveHlsUrl(line, baseUrl);
    if (!resolvedUrl) {
      pendingStreamAttrs = null;
      pendingSegmentDuration = 0;
      pendingByteRangeSpec = null;
      continue;
    }
    if (pendingStreamAttrs) {
      variants.push(buildVariantEntry(pendingStreamAttrs, resolvedUrl));
      pendingStreamAttrs = null;
      continue;
    }

    let byteRange = null;
    if (pendingByteRangeSpec) {
      byteRange = parseByteRangeSpec(pendingByteRangeSpec, prevByteRangeEndByUrl.get(resolvedUrl) ?? 0);
      if (byteRange) {
        prevByteRangeEndByUrl.set(resolvedUrl, byteRange.offset + byteRange.length);
      }
      pendingByteRangeSpec = null;
    }

    segments.push({
      url: resolvedUrl,
      duration: pendingSegmentDuration,
      byteRange,
      sequenceNumber: mediaSequence + segments.length,
      key: currentKey ? { ...currentKey } : null
    });
    pendingSegmentDuration = 0;
  }

  variants.sort((a, b) => (b.width * b.height - a.width * a.height) || (b.bandwidth - a.bandwidth));

  const totalDurationSec = Math.round(segments.reduce((acc, seg) => acc + (seg.duration || 0), 0));
  const isMaster = variants.length > 0;
  const isDynamic = !isMaster &&
    segments.length > 0 &&
    !hasEndList &&
    (playlistType === HLS_PLAYLIST_TYPES.EVENT || playlistType !== HLS_PLAYLIST_TYPES.VOD);
  return {
    format: 'hls',
    isMaster,
    isDynamic,
    hasEndList,
    playlistType,
    mediaSequence,
    targetDurationSec,
    encrypted,
    drmEncrypted,
    decryptableAes128: Boolean(hasAes128 && !drmEncrypted),
    encryptionMethod,
    variants,
    audioTracks,
    subtitles,
    initSegmentUrl,
    initSegmentByteRange,
    segments,
    totalDurationSec,
    outputExtension: initSegmentUrl ? DEFAULT_FILENAMES.HLS_FMP4_EXT : DEFAULT_FILENAMES.HLS_TS_EXT
  };
}

/**
 * Estimates stream byte size from declared variant bandwidth (bits/s) and duration.
 * @param {number} bandwidthBps
 * @param {number} durationSec
 * @returns {number}
 */
export function estimateHlsBytes(bandwidthBps, durationSec) {
  if (!bandwidthBps || bandwidthBps <= 0 || !durationSec || durationSec <= 0) {
    return 0;
  }
  return Math.round((bandwidthBps / 8) * durationSec);
}

/**
 * Selects the highest quality variant from a parsed master playlist.
 * @param {Array<{ bandwidth: number, width: number, height: number, url: string }>} variants
 * @returns {object | null}
 */
export function selectBestVariant(variants) {
  if (!Array.isArray(variants) || variants.length === 0) {
    return null;
  }
  return variants[0];
}
