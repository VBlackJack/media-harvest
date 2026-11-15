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
  return {
    baseUrl: rawUrl.slice(0, hashIdx),
    symbolId: decodeURIComponent(rawUrl.slice(hashIdx + 1).trim())
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
    return typeof atob === 'function'
      ? atob(body)
      : Buffer.from(body, 'base64').toString('utf8');
  }
  return decodeURIComponent(body);
}

/**
 * Strips prologs, comments, metadata blocks, inline event attributes, empty defs,
 * and redundant inter-tag whitespace from SVG markup.
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
    .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
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
