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

const SVG_XML_NS = 'http://www.w3.org/2000/svg';

/**
 * Escapes special regular-expression characters inside an identifier string.
 * @param {string} value
 * @returns {string}
 */
function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Splits a potential SVG sprite reference URL into base URL and symbol fragment identifier.
 * @param {string} rawUrl
 * @returns {{ baseUrl: string, symbolId: string }}
 */
export function splitSvgSpriteUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl || rawUrl.startsWith('data:')) {
    return { baseUrl: rawUrl || '', symbolId: '' };
  }
  const hashIdx = rawUrl.indexOf('#');
  if (hashIdx < 0) {
    return { baseUrl: rawUrl, symbolId: '' };
  }
  let symbolId = rawUrl.slice(hashIdx + 1).trim();
  try {
    symbolId = decodeURIComponent(symbolId);
  } catch {
    // Keep raw fragment when percent-encoding is malformed
  }
  return {
    baseUrl: rawUrl.slice(0, hashIdx),
    symbolId
  };
}

/**
 * Decodes an inline `data:image/svg+xml` URI into raw UTF-8 SVG markup.
 * @param {string} dataUrl
 * @returns {string}
 */
export function decodeSvgDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') {
    return '';
  }
  const commaIdx = dataUrl.indexOf(',');
  if (commaIdx < 0) {
    return '';
  }
  const header = dataUrl.slice(0, commaIdx).toLowerCase();
  const body = dataUrl.slice(commaIdx + 1);
  if (header.includes(';base64')) {
    try {
      if (typeof atob === 'function') {
        const binary = atob(body.replace(/\s+/g, ''));
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) {
          bytes[i] = binary.charCodeAt(i);
        }
        if (typeof TextDecoder === 'function') {
          return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
        }
        return binary;
      }
      return Buffer.from(body, 'base64').toString('utf8');
    } catch {
      return '';
    }
  }
  try {
    return decodeURIComponent(body);
  } catch {
    return body;
  }
}

/**
 * Strips prologs, comments, metadata blocks, active scripts/foreignObjects,
 * inline event attributes, javascript: hrefs, empty defs, and redundant whitespace.
 * @param {string} svgXml
 * @returns {string}
 */
export function optimizeSvgMarkup(svgXml) {
  if (typeof svgXml !== 'string') {
    return '';
  }
  const cleaned = svgXml
    .replace(/^\uFEFF/, '')
    .replace(/<\?xml[\s\S]*?\?>/gi, '')
    .replace(/<!DOCTYPE[\s\S]*?>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<metadata\b[^>]*>[\s\S]*?<\/metadata>/gi, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<script\b[^>]*\/\s*>/gi, '')
    .replace(/<foreignObject\b[^>]*>[\s\S]*?<\/foreignObject>/gi, '')
    .replace(/<foreignObject\b[^>]*\/\s*>/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s+(?:xlink:)?href\s*=\s*(?:"\s*(?:javascript|vbscript|data\s*:\s*text\/html)[^"]*"|'\s*(?:javascript|vbscript|data\s*:\s*text\/html)[^']*')/gi, '')
    .replace(/<defs\b[^>]*>\s*<\/defs>/gi, '')
    .replace(/>\s+</g, '><')
    .trim();
  return cleaned;
}

/**
 * Extracts a targeted `<symbol id="...">` from an external SVG sprite into a standalone SVG document.
 * Preserves sprite `<defs>` blocks and `<symbol viewBox>` when present, then optimizes output.
 * Returns empty string if the symbol cannot be located.
 * @param {string} spriteXml
 * @param {string} symbolId
 * @returns {string}
 */
export function extractSymbolFromSvgSprite(spriteXml, symbolId) {
  if (typeof spriteXml !== 'string' || !spriteXml || !symbolId) {
    return '';
  }
  const cleanId = escapeRegex(symbolId.trim());
  if (!cleanId) {
    return '';
  }
  const symbolRegex = new RegExp(
    `<symbol\\b([^>]*\\bid\\s*=\\s*(?:"${cleanId}"|'${cleanId}')[^>]*)>([\\s\\S]*?)<\\/symbol>`,
    'i'
  );
  const match = symbolRegex.exec(spriteXml);
  if (!match) {
    return '';
  }
  const openAttrs = match[1] || '';
  const innerBody = match[2] || '';
  const viewBoxMatch = /\bviewBox\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(openAttrs);
  const viewBoxValue = viewBoxMatch ? (viewBoxMatch[1] || viewBoxMatch[2] || '').trim() : '';
  const viewBoxAttr = viewBoxValue ? ` viewBox="${viewBoxValue}"` : '';

  const defsMatches = spriteXml.match(/<defs\b[^>]*>[\s\S]*?<\/defs>/gi) || [];
  const defsBlock = defsMatches.join('');

  const standalone = `<svg xmlns="${SVG_XML_NS}"${viewBoxAttr}>${defsBlock}${innerBody}</svg>`;
  return optimizeSvgMarkup(standalone);
}

const SKIP_SVG_COLORS = new Set(['none', 'transparent', 'currentcolor', 'inherit', 'initial', 'unset']);

/**
 * Normalizes a CSS/SVG hex or rgb() color string to lowercase `#rrggbb` when possible.
 * Returns empty string for non-paint keywords (`none`, `transparent`, `currentColor`, `url(...)`).
 * @param {string} rawColor
 * @returns {string}
 */
export function normalizeSvgColor(rawColor) {
  if (typeof rawColor !== 'string') {
    return '';
  }
  const clean = rawColor.trim().toLowerCase();
  if (!clean || SKIP_SVG_COLORS.has(clean) || clean.startsWith('url(') || clean.startsWith('var(')) {
    return '';
  }
  const hexMatch = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(clean);
  if (hexMatch) {
    const digits = hexMatch[1];
    if (digits.length === 3 || digits.length === 4) {
      return `#${digits[0]}${digits[0]}${digits[1]}${digits[1]}${digits[2]}${digits[2]}`;
    }
    return `#${digits.slice(0, 6)}`;
  }
  const rgbMatch = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*[,/]\s*[\d.]+%?)?\s*\)$/i.exec(clean);
  if (rgbMatch) {
    const toHex = (n) => Math.min(255, Math.max(0, Number(n))).toString(16).padStart(2, '0');
    return `#${toHex(rgbMatch[1])}${toHex(rgbMatch[2])}${toHex(rgbMatch[3])}`;
  }
  return clean;
}

/**
 * Extracts a deduplicated ordered color palette (`#rrggbb` / CSS named colors) from SVG markup.
 * Inspects `fill`, `stroke`, `stop-color`, and inline `style` paint declarations.
 * @param {string} svgXml
 * @returns {string[]}
 */
export function extractSvgPalette(svgXml) {
  if (typeof svgXml !== 'string' || !svgXml) {
    return [];
  }
  const seen = new Set();
  const attrRegex = /\b(?:fill|stroke|stop-color)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  let match;
  while ((match = attrRegex.exec(svgXml)) !== null) {
    const norm = normalizeSvgColor(match[1] ?? match[2] ?? '');
    if (norm) {
      seen.add(norm);
    }
  }

  const styleRegex = /\b(?:fill|stroke|stop-color)\s*:\s*([^;}"']+)/gi;
  while ((match = styleRegex.exec(svgXml)) !== null) {
    const norm = normalizeSvgColor(match[1] || '');
    if (norm) {
      seen.add(norm);
    }
  }
  return Array.from(seen);
}

/**
 * Replaces occurrences of `targetColor` inside SVG paint attributes and inline CSS styles.
 * @param {string} svgXml
 * @param {string} targetColor
 * @param {string} newColor
 * @returns {string}
 */
export function replaceSvgColor(svgXml, targetColor, newColor) {
  if (typeof svgXml !== 'string' || !svgXml || !targetColor || !newColor) {
    return svgXml || '';
  }
  const normalizedTarget = normalizeSvgColor(targetColor);
  if (!normalizedTarget) {
    return svgXml;
  }
  const cleanReplacement = String(newColor).trim();

  let updated = svgXml.replace(
    /(\b(?:fill|stroke|stop-color)\s*=\s*)(?:"([^"]*)"|'([^']*)')/gi,
    (full, prefix, dq, sq) => {
      const val = dq ?? sq ?? '';
      return normalizeSvgColor(val) === normalizedTarget ? `${prefix}"${cleanReplacement}"` : full;
    }
  );

  updated = updated.replace(
    /(\b(?:fill|stroke|stop-color)\s*:\s*)([^;}"']+)/gi,
    (full, prefix, val) => (
      normalizeSvgColor(val) === normalizedTarget ? `${prefix}${cleanReplacement}` : full
    )
  );

  return updated;
}

/**
 * Converts all explicit paint colors in SVG markup to `currentColor`.
 * @param {string} svgXml
 * @returns {string}
 */
export function convertSvgToCurrentColor(svgXml) {
  if (typeof svgXml !== 'string' || !svgXml) {
    return svgXml || '';
  }
  let updated = svgXml;
  for (const color of extractSvgPalette(svgXml)) {
    updated = replaceSvgColor(updated, color, 'currentColor');
  }
  return updated;
}
