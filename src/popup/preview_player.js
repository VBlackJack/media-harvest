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

import { LIMITS, MEDIA_TYPES } from '../config/constants.js';
import { parseDashManifest } from '../shared/dash_parser.js';
import {
  fetchWithManagedTimeout,
  isDashDescriptor,
  looksLikeDashXml
} from '../shared/fetch_utils.js';
import { parseHlsPlaylist, selectBestVariant } from '../shared/hls_parser.js';
import { t } from '../shared/i18n.js';
import { isHttpUrl } from '../shared/media_classifier.js';
import { transmuxTsSegmentsToMp4 } from '../shared/ts_transmuxer.js';

/**
 * Fetches a single preview segment buffer, honoring byte ranges when specified.
 * @param {string} url
 * @param {{ offset: number, length: number } | null} byteRange
 * @returns {Promise<ArrayBuffer>}
 */
async function fetchPreviewSegmentBuffer(url, byteRange) {
  if (!byteRange) {
    return fetchWithManagedTimeout(url, { responseMode: 'buffer' });
  }
  const headers = { Range: `bytes=${byteRange.offset}-${byteRange.offset + byteRange.length - 1}` };
  const { status, buffer } = await fetchWithManagedTimeout(url, {
    responseMode: 'bufferWithStatus',
    headers
  });
  if (status === 200) {
    return buffer.slice(byteRange.offset, byteRange.offset + byteRange.length);
  }
  return buffer;
}

/**
 * Revokes and clears a single card's preview Blob URL if present.
 * @param {object} entry
 */
export function revokeCardPreviewBlob(entry) {
  if (entry && entry.previewBlobUrl) {
    URL.revokeObjectURL(entry.previewBlobUrl);
    entry.previewBlobUrl = '';
  }
}

/**
 * Closes and cleans up any active video preview inside a card entry.
 * @param {object} entry
 */
export function closeCardPreview(entry) {
  for (const tag of ['video', 'audio']) {
    const activeMedia = entry.previewBox.querySelector(tag);
    if (activeMedia) {
      activeMedia.pause();
      activeMedia.removeAttribute('src');
      activeMedia.load();
    }
  }
  revokeCardPreviewBlob(entry);
  entry.previewBox.replaceChildren();
  entry.previewBox.classList.add('hidden');
  if (entry.previewBtn) {
    entry.previewBtn.textContent = t('popup_action_preview');
  }
  if (entry.thumbEl && entry.thumbEl.tagName === 'BUTTON') {
    entry.thumbEl.setAttribute('aria-label', t('popup_action_preview'));
    entry.thumbEl.setAttribute('aria-expanded', 'false');
  }
}

/**
 * Builds a playable preview clip URL from a parsed DASH manifest.
 * @param {string} rootText
 * @param {string} selectedUrl
 * @param {string} originalItemUrl
 * @returns {Promise<string>}
 */
async function buildDashPreviewUrl(rootText, selectedUrl, originalItemUrl) {
  const parsedDash = parseDashManifest(rootText, originalItemUrl);
  if (parsedDash.encrypted) {
    throw new Error('ENCRYPTED_STREAM');
  }
  if (parsedDash.isDynamic) {
    throw new Error('LIVE_STREAM');
  }
  const chosen = parsedDash.variants.find((v) => v.url === selectedUrl) ||
    parsedDash.variants[parsedDash.variants.length - 1] ||
    parsedDash.variants[0];
  if (!chosen || chosen.segments.length === 0) {
    throw new Error('PREVIEW_UNAVAILABLE');
  }
  if (chosen.isProgressive) {
    if (!isHttpUrl(chosen.segments[0].url)) {
      throw new Error('INVALID_URL');
    }
    return chosen.segments[0].url;
  }
  const clipUrls = chosen.initSegmentUrl
    ? [chosen.initSegmentUrl, ...chosen.segments.slice(0, LIMITS.PREVIEW_HLS_SEGMENTS).map((s) => s.url)]
    : chosen.segments.slice(0, LIMITS.PREVIEW_HLS_SEGMENTS).map((s) => s.url);
  const buffers = await Promise.all(
    clipUrls.map((segmentUrl) => fetchWithManagedTimeout(segmentUrl, { responseMode: 'buffer' }))
  );
  const mime = chosen.mimeType === 'video/webm' ? 'video/webm' : 'video/mp4';
  return URL.createObjectURL(new Blob(buffers, { type: mime }));
}

/**
 * Fetches a short fMP4/TS HLS or DASH preview clip as a Blob URL.
 * @param {string} selectedUrl
 * @param {string} originalItemUrl
 * @returns {Promise<string>}
 */
export async function buildStreamPreviewUrl(selectedUrl, originalItemUrl) {
  const fetchTarget = isDashDescriptor(selectedUrl) || isDashDescriptor(originalItemUrl)
    ? originalItemUrl
    : selectedUrl;
  const rootText = await fetchWithManagedTimeout(fetchTarget, { responseMode: 'text' });

  if (
    isDashDescriptor(selectedUrl) ||
    isDashDescriptor(originalItemUrl) ||
    looksLikeDashXml(rootText)
  ) {
    return buildDashPreviewUrl(rootText, selectedUrl, originalItemUrl);
  }

  let parsed = parseHlsPlaylist(rootText, fetchTarget);
  if (parsed.encrypted) {
    throw new Error('ENCRYPTED_STREAM');
  }
  if (parsed.isDynamic) {
    throw new Error('LIVE_STREAM');
  }

  if (parsed.isMaster) {
    const lowestOrFirst = parsed.variants[parsed.variants.length - 1] || selectBestVariant(parsed.variants);
    if (!lowestOrFirst) {
      throw new Error('PREVIEW_UNAVAILABLE');
    }
    const variantText = await fetchWithManagedTimeout(lowestOrFirst.url, { responseMode: 'text' });
    parsed = parseHlsPlaylist(variantText, lowestOrFirst.url);
    if (parsed.encrypted) {
      throw new Error('ENCRYPTED_STREAM');
    }
    if (parsed.isDynamic) {
      throw new Error('LIVE_STREAM');
    }
  }

  if (parsed.segments.length === 0) {
    throw new Error('PREVIEW_UNAVAILABLE');
  }

  const leadingSegments = parsed.segments.slice(0, LIMITS.PREVIEW_HLS_SEGMENTS);
  const requests = parsed.initSegmentUrl
    ? [
        { url: parsed.initSegmentUrl, byteRange: parsed.initSegmentByteRange || null },
        ...leadingSegments.map((s) => ({ url: s.url, byteRange: s.byteRange || null }))
      ]
    : leadingSegments.map((s) => ({ url: s.url, byteRange: s.byteRange || null }));

  const buffers = await Promise.all(
    requests.map((req) => fetchPreviewSegmentBuffer(req.url, req.byteRange))
  );

  const outputBuffers = parsed.initSegmentUrl
    ? buffers
    : [transmuxTsSegmentsToMp4(buffers)];

  const blob = new Blob(outputBuffers, { type: 'video/mp4' });
  return URL.createObjectURL(blob);
}

/**
 * Updates expanded UI labels and ARIA state on preview trigger controls.
 * @param {object} entry
 * @param {boolean} expanded
 */
function setPreviewExpandedState(entry, expanded) {
  const label = expanded ? t('popup_action_hide_preview') : t('popup_action_preview');
  if (entry.previewBtn) {
    entry.previewBtn.textContent = label;
  }
  if (entry.thumbEl && entry.thumbEl.tagName === 'BUTTON') {
    entry.thumbEl.setAttribute('aria-label', label);
    entry.thumbEl.setAttribute('aria-expanded', String(expanded));
  }
}

/**
 * Toggles an inline video preview player inside a media card.
 * @param {object} entry
 */
export async function toggleVideoPreview(entry) {
  const { item, qualitySelect, previewBtn, previewBox } = entry;
  if (!previewBox.classList.contains('hidden')) {
    closeCardPreview(entry);
    return;
  }

  previewBtn.disabled = true;
  previewBox.replaceChildren();
  const note = document.createElement('div');
  note.className = 'preview-note';
  note.textContent = t('popup_preview_loading');
  previewBox.appendChild(note);
  previewBox.classList.remove('hidden');

  try {
    const selectedUrl = !qualitySelect.classList.contains('hidden') ? qualitySelect.value : item.url;
    let playableUrl = item.url;
    if (item.isStream) {
      const previewUrl = await buildStreamPreviewUrl(selectedUrl, item.url);
      if (!entry.card.isConnected || previewBox.classList.contains('hidden')) {
        if (previewUrl.startsWith('blob:')) {
          URL.revokeObjectURL(previewUrl);
        }
        return;
      }
      if (previewUrl.startsWith('blob:')) {
        revokeCardPreviewBlob(entry);
        entry.previewBlobUrl = previewUrl;
      }
      playableUrl = previewUrl;
    } else if (!entry.card.isConnected || previewBox.classList.contains('hidden')) {
      return;
    }

    const isAudio = item.type === MEDIA_TYPES.AUDIO;
    const player = document.createElement(isAudio ? 'audio' : 'video');
    player.className = isAudio ? 'preview-audio' : 'preview-video';
    player.controls = true;
    player.autoplay = true;
    if (!isAudio) {
      player.muted = true;
      player.playsInline = true;
      if (item.poster) {
        player.poster = item.poster;
      }
    }
    player.src = playableUrl;
    player.addEventListener('error', () => {
      previewBox.replaceChildren();
      const errNote = document.createElement('div');
      errNote.className = 'preview-note';
      errNote.textContent = t('popup_preview_unavailable');
      previewBox.appendChild(errNote);
    });

    previewBox.replaceChildren(player);
    setPreviewExpandedState(entry, true);
  } catch (err) {
    if (!entry.card.isConnected || previewBox.classList.contains('hidden')) {
      return;
    }
    previewBox.replaceChildren();
    const errNote = document.createElement('div');
    errNote.className = 'preview-note';
    if (err.message === 'ENCRYPTED_STREAM') {
      errNote.textContent = t('popup_error_encrypted_stream');
    } else if (err.message === 'LIVE_STREAM') {
      errNote.textContent = t('popup_error_live_stream');
    } else {
      errNote.textContent = t('popup_preview_unavailable');
    }
    previewBox.appendChild(errNote);
    setPreviewExpandedState(entry, true);
  } finally {
    previewBtn.disabled = false;
  }
}

/**
 * Reloads an already open inline preview when stream quality selection changes.
 * @param {object} entry
 */
export async function refreshOpenPreview(entry) {
  if (!entry || !entry.previewBox || entry.previewBox.classList.contains('hidden')) {
    return;
  }
  closeCardPreview(entry);
  await toggleVideoPreview(entry);
}
