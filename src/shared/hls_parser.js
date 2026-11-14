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

import { DEFAULT_FILENAMES, HLS_TAGS } from '../config/constants.js';

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
 * Resolves a possibly relative HLS URI against the playlist URL.
 * Returns an empty string if the URI cannot be resolved.
 * @param {string} uri
 * @param {string} baseUrl
 * @returns {string}
 */
export function resolveHlsUrl(uri, baseUrl) {
  if (typeof uri !== 'string' || !uri.trim()) {
    return '';
  }
  try {
    return new URL(uri.trim(), baseUrl).href;
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
 * Parses an HLS playlist text, handling both master playlists and media playlists.
 * @param {string} text
 * @param {string} baseUrl
 * @returns {{
 *   isMaster: boolean,
 *   encrypted: boolean,
 *   encryptionMethod: string,
 *   variants: Array<{ bandwidth: number, width: number, height: number, resolution: string, audioGroup: string, url: string }>,
 *   audioTracks: Array<{ groupId: string, name: string, language: string, url: string }>,
 *   initSegmentUrl: string | null,
 *   segments: Array<{ url: string, duration: number }>,
 *   outputExtension: string
 * }}
 */
export function parseHlsPlaylist(text, baseUrl) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const variants = [];
  const audioTracks = [];
  const segments = [];

  let initSegmentUrl = null;
  let pendingStreamAttrs = null;
  let pendingSegmentDuration = 0;
  let encrypted = false;
  let encryptionMethod = 'NONE';

  for (const line of lines) {
    if (line.startsWith(HLS_TAGS.KEY) || line.startsWith(HLS_TAGS.SESSION_KEY)) {
      const tagLength = line.startsWith(HLS_TAGS.SESSION_KEY)
        ? HLS_TAGS.SESSION_KEY.length
        : HLS_TAGS.KEY.length;
      const attrs = parseHlsAttributes(line.slice(tagLength));
      const method = (attrs.METHOD || 'NONE').toUpperCase();
      if (method !== 'NONE') {
        encrypted = true;
        encryptionMethod = method;
      }
      continue;
    }

    if (line.startsWith(HLS_TAGS.MEDIA)) {
      const attrs = parseHlsAttributes(line.slice(HLS_TAGS.MEDIA.length));
      const resolvedAudioUrl = attrs.URI ? resolveHlsUrl(attrs.URI, baseUrl) : '';
      if (attrs.TYPE === 'AUDIO' && resolvedAudioUrl) {
        audioTracks.push({
          groupId: attrs['GROUP-ID'] || '',
          name: attrs.NAME || attrs.LANGUAGE || 'audio',
          language: attrs.LANGUAGE || '',
          url: resolvedAudioUrl
        });
      }
      continue;
    }

    if (line.startsWith(HLS_TAGS.STREAM_INF)) {
      pendingStreamAttrs = parseHlsAttributes(line.slice(HLS_TAGS.STREAM_INF.length));
      continue;
    }

    if (line.startsWith(HLS_TAGS.MAP)) {
      const attrs = parseHlsAttributes(line.slice(HLS_TAGS.MAP.length));
      if (attrs.URI) {
        const resolvedMapUrl = resolveHlsUrl(attrs.URI, baseUrl);
        if (resolvedMapUrl) {
          initSegmentUrl = resolvedMapUrl;
        }
      }
      continue;
    }

    if (line.startsWith(HLS_TAGS.EXTINF)) {
      const durationStr = line.slice(HLS_TAGS.EXTINF.length).split(',')[0];
      pendingSegmentDuration = Number.parseFloat(durationStr) || 0;
      continue;
    }

    if (line.startsWith('#')) {
      continue;
    }

    const resolvedUrl = resolveHlsUrl(line, baseUrl);
    if (!resolvedUrl) {
      pendingStreamAttrs = null;
      pendingSegmentDuration = 0;
      continue;
    }
    if (pendingStreamAttrs) {
      const { width, height } = parseResolution(pendingStreamAttrs.RESOLUTION);
      variants.push({
        bandwidth: Number.parseInt(pendingStreamAttrs.BANDWIDTH, 10) || 0,
        width,
        height,
        resolution: pendingStreamAttrs.RESOLUTION || '',
        audioGroup: pendingStreamAttrs.AUDIO || '',
        url: resolvedUrl
      });
      pendingStreamAttrs = null;
      continue;
    }

    segments.push({
      url: resolvedUrl,
      duration: pendingSegmentDuration
    });
    pendingSegmentDuration = 0;
  }

  variants.sort((a, b) => (b.width * b.height - a.width * a.height) || (b.bandwidth - a.bandwidth));

  const isMaster = variants.length > 0;
  const totalDurationSec = Math.round(
    segments.reduce((acc, seg) => acc + (seg.duration || 0), 0)
  );
  const outputExtension = initSegmentUrl
    ? DEFAULT_FILENAMES.HLS_FMP4_EXT
    : DEFAULT_FILENAMES.HLS_TS_EXT;

  return {
    isMaster,
    encrypted,
    encryptionMethod,
    variants,
    audioTracks,
    initSegmentUrl,
    segments,
    totalDurationSec,
    outputExtension
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
