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
  IMAGE_CONVERT_FORMATS,
  LIMITS
} from '../config/constants.js';
import { fetchWithManagedTimeout } from '../shared/fetch_utils.js';
import { decodeBase64ToBytes } from '../shared/hls_crypto.js';
import {
  extractUrlExtension,
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

const CANCEL_REASON = 'DOWNLOAD_CANCELLED';

/**
 * Decodes an SVG or raster image `data:image/...` URI into a Blob.
 * @param {string} dataUrl
 * @param {string} [defaultMime='image/svg+xml;charset=utf-8']
 * @returns {Blob}
 */
export function imageDataUrlToBlob(dataUrl, defaultMime = 'image/svg+xml;charset=utf-8') {
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

function resolveRasterSizePx(rawSize) {
  const num = Number(rawSize);
  if (!Number.isFinite(num) || num <= 0) {
    return 0;
  }
  return Math.max(64, Math.min(4096, Math.round(num)));
}

/**
 * Computes canvas export dimensions, scaling SVGs or clamping raster widths.
 * @param {number} naturalWidth
 * @param {number} naturalHeight
 * @param {number} hintWidth
 * @param {number} hintHeight
 * @param {boolean} isSvg
 * @param {number} [rasterSizePx=0]
 * @param {number} [maxImageResizePx=0]
 * @returns {{ width: number, height: number }}
 */
export function resolveConvertDimensions(
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
 * Resolves and optimizes standalone SVG XML or extracts a symbol from an external sprite sheet.
 * @param {string} targetUrl
 * @param {string} symbolIdHint
 * @param {AbortSignal} cancelSignal
 * @returns {Promise<string>}
 */
export async function resolveSvgSourceText(targetUrl, symbolIdHint, cancelSignal) {
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
 * Fetches or decodes an image/SVG and rasterizes it to a PNG or JPG Blob.
 * @param {string} targetUrl
 * @param {string} targetFormat
 * @param {number} hintWidth
 * @param {number} hintHeight
 * @param {number} rasterSizePx
 * @param {AbortSignal} cancelSignal
 * @param {number} [jpgQualityPercent]
 * @param {string} [symbolIdHint]
 * @param {number} [maxImageResizePx=0]
 * @returns {Promise<Blob>}
 */
export async function rasterizeImageToBlob(
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
