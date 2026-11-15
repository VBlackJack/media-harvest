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
  AUDIO_EXTENSIONS,
  DEFAULT_FILENAMES,
  IMAGE_EXTENSIONS,
  LIMITS,
  MEDIA_SOURCES,
  MEDIA_TYPES,
  MIME_EXTENSION_MAP,
  MIME_PREFIX_MAP,
  MSE_CONSTANTS,
  NON_MEDIA_MIME_TYPES,
  SEGMENT_EXTENSIONS,
  STREAM_EXTENSIONS,
  STREAM_MIME_TYPES,
  SUBTITLE_EXTENSIONS,
  SUBTITLE_MIME_TYPES,
  VIDEO_EXTENSIONS,
  X_INTEGRATION
} from '../config/constants.js';

const EXTENSION_TYPE_TABLE = [
  { extensions: STREAM_EXTENSIONS, type: MEDIA_TYPES.STREAM, isStream: true },
  { extensions: VIDEO_EXTENSIONS, type: MEDIA_TYPES.VIDEO, isStream: false },
  { extensions: IMAGE_EXTENSIONS, type: MEDIA_TYPES.IMAGE, isStream: false },
  { extensions: AUDIO_EXTENSIONS, type: MEDIA_TYPES.AUDIO, isStream: false },
  { extensions: SUBTITLE_EXTENSIONS, type: MEDIA_TYPES.SUBTITLE, isStream: false }
];

const EXTENSION_LOOKUP = new Map(
  EXTENSION_TYPE_TABLE.flatMap(({ extensions, type, isStream }) =>
    extensions.map((ext) => [ext, { type, ext, isStream }])
  )
);

const SEGMENT_SET = new Set(SEGMENT_EXTENSIONS);
const STREAM_MIME_SET = new Set(STREAM_MIME_TYPES);
const SUBTITLE_MIME_SET = new Set(SUBTITLE_MIME_TYPES);
const SUBTITLE_EXT_SET = new Set(SUBTITLE_EXTENSIONS);
const NON_MEDIA_MIME_SET = new Set(NON_MEDIA_MIME_TYPES);
const STREAM_EXT_SET = new Set(STREAM_EXTENSIONS);

const RASTER_DATA_URI_EXT_MAP = Object.freeze({
  png: 'png',
  jpeg: 'jpg',
  jpg: 'jpg',
  webp: 'webp',
  gif: 'gif',
  avif: 'avif'
});

/**
 * Extracts raster extension from a data:image/(png|jpeg|webp|gif|avif) URI, or empty string.
 * @param {string} rawUrl
 * @returns {string}
 */
export function extractRasterDataUrlExtension(rawUrl) {
  if (typeof rawUrl !== 'string') {
    return '';
  }
  const match = rawUrl.trim().match(/^data:image\/(png|jpeg|jpg|webp|gif|avif)[;,]/i);
  if (!match) {
    return '';
  }
  return RASTER_DATA_URI_EXT_MAP[match[1].toLowerCase()] || '';
}

/**
 * Checks whether a URL is a standalone raster image data URI.
 * @param {string} rawUrl
 * @returns {boolean}
 */
export function isRasterImageDataUrl(rawUrl) {
  return Boolean(extractRasterDataUrlExtension(rawUrl));
}

/**
 * Extracts a lowercase file extension from a URL pathname, ignoring query params.
 * @param {string} rawUrl
 * @returns {string}
 */
export function extractUrlExtension(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl) {
    return '';
  }
  if (isSvgDataUrl(rawUrl)) {
    return DEFAULT_FILENAMES.SVG_EXT;
  }
  const rasterDataExt = extractRasterDataUrlExtension(rawUrl);
  if (rasterDataExt) {
    return rasterDataExt;
  }
  if (isMseUrl(rawUrl)) {
    return '';
  }

  try {
    const parsed = new URL(rawUrl);
    const segments = parsed.pathname.split('/');
    const lastSegment = segments[segments.length - 1] || '';
    const dotIndex = lastSegment.lastIndexOf('.');
    if (dotIndex <= 0 || dotIndex === lastSegment.length - 1) {
      return '';
    }
    return lastSegment.slice(dotIndex + 1).toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Normalizes a Content-Type header value by stripping charset or parameters.
 * @param {string} mimeHeader
 * @returns {string}
 */
export function normalizeMimeType(mimeHeader) {
  if (typeof mimeHeader !== 'string') {
    return '';
  }
  return mimeHeader.split(';')[0].trim().toLowerCase();
}

/**
 * Checks whether a URL points to an HTTP(S) resource rather than blob/data.
 * @param {string} rawUrl
 * @returns {boolean}
 */
export function isHttpUrl(rawUrl) {
  if (typeof rawUrl !== 'string') {
    return false;
  }
  return rawUrl.startsWith('https://') || rawUrl.startsWith('http://');
}

/**
 * Checks whether a URL is a standalone SVG data URI (`data:image/svg+xml,...`).
 * @param {string} rawUrl
 * @returns {boolean}
 */
export function isSvgDataUrl(rawUrl) {
  if (typeof rawUrl !== 'string') {
    return false;
  }
  return /^data:image\/svg\+xml[;,]/i.test(rawUrl.trim());
}

/**
 * Checks whether a URL can be downloaded via Chrome downloads (HTTP/HTTPS or image data URI).
 * @param {string} rawUrl
 * @returns {boolean}
 */
export function isDownloadableMediaUrl(rawUrl) {
  return isHttpUrl(rawUrl) || isSvgDataUrl(rawUrl) || isRasterImageDataUrl(rawUrl);
}

/**
 * Classifies a media URL and optional MIME type into a normalized descriptor.
 * Returns null for unsupported URLs or individual HLS/DASH media segments.
 * @param {string} rawUrl
 * @param {string} [mimeHeader='']
 * @returns {{ type: string, ext: string, isStream: boolean } | null}
 */
export function classifyMedia(rawUrl, mimeHeader = '') {
  if (isSvgDataUrl(rawUrl)) {
    return {
      type: MEDIA_TYPES.IMAGE,
      ext: DEFAULT_FILENAMES.SVG_EXT,
      isStream: false
    };
  }
  const rasterDataExt = extractRasterDataUrlExtension(rawUrl);
  if (rasterDataExt) {
    return {
      type: MEDIA_TYPES.IMAGE,
      ext: rasterDataExt,
      isStream: false
    };
  }
  if (!isHttpUrl(rawUrl)) {
    return null;
  }

  const ext = extractUrlExtension(rawUrl);
  if (ext && SEGMENT_SET.has(ext)) {
    return null;
  }

  const mime = normalizeMimeType(mimeHeader);
  if (mime) {
    if (
      (mime === 'text/plain' || mime === 'application/xml' || mime === 'text/xml') &&
      (STREAM_EXT_SET.has(ext) || SUBTITLE_EXT_SET.has(ext))
    ) {
      return { ...EXTENSION_LOOKUP.get(ext) };
    }
    if (NON_MEDIA_MIME_SET.has(mime) || mime === 'text/plain') {
      return null;
    }
  }
  if (mime && STREAM_MIME_SET.has(mime)) {
    return {
      type: MEDIA_TYPES.STREAM,
      ext: MIME_EXTENSION_MAP[mime] || STREAM_EXTENSIONS[0],
      isStream: true
    };
  }
  if (mime && SUBTITLE_MIME_SET.has(mime)) {
    return {
      type: MEDIA_TYPES.SUBTITLE,
      ext: MIME_EXTENSION_MAP[mime] || SUBTITLE_EXTENSIONS[0],
      isStream: false
    };
  }

  if (ext && EXTENSION_LOOKUP.has(ext)) {
    return { ...EXTENSION_LOOKUP.get(ext) };
  }

  if (mime) {
    for (const [prefix, mediaType] of Object.entries(MIME_PREFIX_MAP)) {
      if (mime.startsWith(prefix)) {
        const mappedExt = MIME_EXTENSION_MAP[mime] || mime.slice(prefix.length).split('+')[0];
        return {
          type: mediaType,
          ext: mappedExt || DEFAULT_FILENAMES.FALLBACK_EXT,
          isStream: false
        };
      }
    }
  }

  return null;
}

/**
 * Sanitizes a single path segment for safe cross-platform Chrome download paths.
 * @param {string} rawSegment
 * @param {number} maxLength
 * @returns {string}
 */
function sanitizePathSegment(rawSegment, maxLength = LIMITS.MAX_FILENAME_LENGTH) {
  return String(rawSegment || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/[\s_]+/g, '_')
    .replace(/\.+$/g, '')
    .slice(0, maxLength)
    .replace(/^_+|_+$/g, '');
}

/**
 * Produces a cross-platform safe filename (or safe forward-slash relative path) with an explicit extension.
 * @param {string} rawName
 * @param {string} fallbackExt
 * @param {{ allowFolders?: boolean }} [options]
 * @returns {string}
 */
export function sanitizeFilename(rawName, fallbackExt = DEFAULT_FILENAMES.FALLBACK_EXT, options = {}) {
  const safeExt = (fallbackExt || DEFAULT_FILENAMES.FALLBACK_EXT)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '') || DEFAULT_FILENAMES.FALLBACK_EXT;

  const rawText = rawName || DEFAULT_FILENAMES.BASE;
  const allowFolders = Boolean(options && options.allowFolders);
  let folderPrefix = '';
  let leafSegment = rawText;

  if (allowFolders && rawText.includes('/')) {
    const parts = rawText.split('/').filter(Boolean);
    if (parts.length > 1) {
      leafSegment = parts[parts.length - 1];
      const safeFolders = parts
        .slice(0, -1)
        .map((segment) => sanitizePathSegment(segment.replace(/^\.+$/, '')))
        .filter((segment) => segment && segment !== '.' && segment !== '..');
      if (safeFolders.length > 0) {
        folderPrefix = `${safeFolders.join('/')}/`;
      }
    }
  }

  const cleanedBase = sanitizePathSegment(leafSegment, LIMITS.MAX_FILENAME_LENGTH);
  const base = cleanedBase || DEFAULT_FILENAMES.BASE;
  const suffix = `.${safeExt}`;
  const finalLeaf = base.toLowerCase().endsWith(suffix) ? base : `${base}${suffix}`;
  return `${folderPrefix}${finalLeaf}`;
}

/**
 * Checks whether a string uses the internal virtual MSE stream scheme.
 * @param {string} rawUrl
 * @returns {boolean}
 */
export function isMseUrl(rawUrl) {
  return typeof rawUrl === 'string' && rawUrl.startsWith(MSE_CONSTANTS.URL_PREFIX);
}

/**
 * Classifies an MSE codec/MIME header string into a canonical media descriptor.
 * @param {string} mimeHeader
 * @returns {{ type: string, ext: string, isStream: boolean, isMse: boolean }}
 */
export function classifyMseMime(mimeHeader) {
  const mime = normalizeMimeType(mimeHeader);
  const mappedExt = MIME_EXTENSION_MAP[mime];
  if (mime.startsWith('audio/')) {
    return {
      type: MEDIA_TYPES.AUDIO,
      ext: mappedExt || 'm4a',
      isStream: false,
      isMse: true
    };
  }
  return {
    type: MEDIA_TYPES.VIDEO,
    ext: mappedExt || 'mp4',
    isStream: false,
    isMse: true
  };
}

/**
 * Derives a readable filename stem from a URL, page context (e.g. X status), or page title.
 * @param {string} rawUrl
 * @param {string} [pageTitle='']
 * @param {string} [pageUrl='']
 * @returns {string}
 */
export function deriveFilenameStem(rawUrl, pageTitle = '', pageUrl = '') {
  if (pageUrl) {
    try {
      const parsedPage = new URL(pageUrl);
      if (X_INTEGRATION.HOSTNAMES.includes(parsedPage.hostname.toLowerCase())) {
        const tweetMatch = parsedPage.pathname.match(X_INTEGRATION.TWEET_PATH_PATTERN);
        if (tweetMatch) {
          return `${tweetMatch[1]}_${tweetMatch[2]}`;
        }
      }
    } catch {
      // Ignore malformed pageUrl
    }
  }

  if (isMseUrl(rawUrl) || isSvgDataUrl(rawUrl) || isRasterImageDataUrl(rawUrl)) {
    return pageTitle || DEFAULT_FILENAMES.BASE;
  }

  try {
    const parsed = new URL(rawUrl);
    const segments = parsed.pathname.split('/').filter(Boolean);
    const last = segments[segments.length - 1] || '';
    const dotIndex = last.lastIndexOf('.');
    const urlStem = dotIndex > 0 ? last.slice(0, dotIndex) : last;
    if (urlStem && urlStem.length >= 3 && !/^[0-9a-f]{16,}$/i.test(urlStem)) {
      return urlStem;
    }
  } catch {
    // Fall back to page title below
  }
  return pageTitle || DEFAULT_FILENAMES.BASE;
}

/**
 * Merges and deduplicates media entries by URL, preferring richer metadata.
 * @param {Array<object>} items
 * @returns {Array<object>}
 */
export function deduplicateMedia(items) {
  const byUrl = new Map();

  for (const item of items) {
    if (!item || !item.url) {
      continue;
    }
    const existing = byUrl.get(item.url);
    if (!existing) {
      byUrl.set(item.url, { ...item });
      continue;
    }
    const keepNetworkStream = existing.source === MEDIA_SOURCES.NETWORK
      && existing.isStream
      && item.source === MEDIA_SOURCES.DOM
      && !item.isStream;
    byUrl.set(item.url, {
      ...existing,
      ...item,
      type: keepNetworkStream ? existing.type : (item.type || existing.type),
      ext: keepNetworkStream ? existing.ext : (item.ext || existing.ext),
      isStream: keepNetworkStream ? existing.isStream : Boolean(item.isStream || existing.isStream),
      source: existing.source === MEDIA_SOURCES.NETWORK ? MEDIA_SOURCES.NETWORK : item.source,
      mimeType: item.mimeType || existing.mimeType || '',
      width: item.width || existing.width || 0,
      height: item.height || existing.height || 0,
      sizeBytes: item.sizeBytes || existing.sizeBytes || 0,
      title: item.title || existing.title || '',
      referer: item.referer || existing.referer || '',
      isMse: Boolean(item.isMse || existing.isMse),
      mseId: item.mseId || existing.mseId || '',
      blobUrl: item.blobUrl || existing.blobUrl || '',
      svgMarkup: item.svgMarkup || existing.svgMarkup || ''
    });
  }

  return Array.from(byUrl.values());
}
