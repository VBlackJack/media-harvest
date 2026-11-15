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
  LIMITS,
  MEDIA_SOURCES,
  MEDIA_TYPES,
  QUALITY_PREFERENCES,
  UNIT_CONVERSIONS
} from '../config/constants.js';
import { isDashDescriptor } from '../shared/fetch_utils.js';
import { t } from '../shared/i18n.js';
import { isSvgDataUrl } from '../shared/media_classifier.js';
import { formatBytes, formatDuration, getEstimatedStreamBytes, localizeError } from './popup_helpers.js';
import { closeCardPreview, refreshOpenPreview, toggleVideoPreview } from './preview_player.js';

/**
 * Resolves DOM factory and translation helpers from context with browser defaults.
 * @param {object} context
 * @returns {{ doc: Document, translate: Function, togglePreview: Function, refreshPreview: Function }}
 */
function resolveCardDeps(context = {}) {
  return {
    doc: context.documentRef || document,
    translate: context.translateFn || t,
    togglePreview: context.togglePreviewFn || toggleVideoPreview,
    refreshPreview: context.refreshPreviewFn || refreshOpenPreview
  };
}

/**
 * Builds an inline decorative SVG play triangle icon.
 * @param {Document} doc
 * @returns {HTMLSpanElement}
 */
function createPlayOverlay(doc) {
  const badge = doc.createElement('span');
  badge.className = 'thumb-play';
  badge.setAttribute('aria-hidden', 'true');
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '12');
  svg.setAttribute('height', '12');
  svg.setAttribute('fill', 'currentColor');
  const poly = doc.createElementNS('http://www.w3.org/2000/svg', 'polygon');
  poly.setAttribute('points', '6,4 20,12 6,20');
  svg.appendChild(poly);
  badge.appendChild(svg);
  return badge;
}

/**
 * Renders the visual content inside a thumbnail container.
 * @param {HTMLElement} thumbEl
 * @param {object} item
 * @param {Document} doc
 */
function renderThumbnailContent(thumbEl, item, doc) {
  const isVideoLike = item.type === MEDIA_TYPES.VIDEO || item.type === MEDIA_TYPES.STREAM;
  const isSvgImage = item.type === MEDIA_TYPES.IMAGE && (
    (item.ext || '').toLowerCase() === DEFAULT_FILENAMES.SVG_EXT || isSvgDataUrl(item.url)
  );
  thumbEl.classList.toggle('thumb-svg', isSvgImage);
  const key = `${item.type}|${item.poster || ''}|${item.ext || ''}|${isSvgImage ? item.url : ''}`;
  if (thumbEl.dataset.thumbKey === key) {
    return;
  }
  thumbEl.dataset.thumbKey = key;
  thumbEl.replaceChildren();

  if (item.type === MEDIA_TYPES.IMAGE) {
    const img = doc.createElement('img');
    img.src = item.url;
    img.alt = '';
    img.loading = 'lazy';
    thumbEl.appendChild(img);
    return;
  }

  if (item.poster) {
    const img = doc.createElement('img');
    img.src = item.poster;
    img.alt = '';
    thumbEl.appendChild(img);
    if (isVideoLike) {
      thumbEl.appendChild(createPlayOverlay(doc));
    }
    return;
  }

  thumbEl.textContent = item.ext || item.type;
}

/**
 * Creates a small metadata badge pill.
 * @param {string} label
 * @param {'default' | 'accent' | 'warning'} [variant='default']
 * @param {Document} [doc=document]
 * @returns {HTMLSpanElement}
 */
function createBadge(label, variant = 'default', doc = document) {
  const span = doc.createElement('span');
  if (variant === 'accent') {
    span.className = 'badge badge-accent';
  } else if (variant === 'warning') {
    span.className = 'badge badge-warning';
  } else {
    span.className = 'badge';
  }
  span.textContent = label;
  return span;
}

/**
 * Resolves the currently selected variant descriptor for a stream card.
 * @param {object | null} meta
 * @param {object | null} entry
 * @returns {object | null}
 */
function getSelectedVariant(meta, entry) {
  if (!meta || !Array.isArray(meta.variants) || meta.variants.length === 0) {
    return null;
  }
  const selectedUrl = entry && entry.qualitySelect && !entry.qualitySelect.classList.contains('hidden')
    ? entry.qualitySelect.value
    : '';
  return meta.variants.find((v) => v.url === selectedUrl) || meta.variants[0];
}

/**
 * Renders the metadata badges for a media card.
 * @param {HTMLElement} badgesEl
 * @param {object} item
 * @param {object | null} [entry=null]
 * @param {object} [context={}]
 */
export function renderBadges(badgesEl, item, entry = null, context = {}) {
  const { doc, translate } = resolveCardDeps(context);
  badgesEl.replaceChildren();
  const meta = context.hlsMetaByUrl ? context.hlsMetaByUrl.get(item.url) : null;
  const isDash = isDashDescriptor(item.url, item.mimeType, meta);
  if (item.isStream) {
    badgesEl.appendChild(createBadge(translate(isDash ? 'popup_badge_dash' : 'popup_badge_stream'), 'accent', doc));
    if (meta && meta.decryptableAes128) {
      badgesEl.appendChild(createBadge(translate('popup_badge_aes128'), 'default', doc));
    }
    if (meta && meta.isDynamic) {
      badgesEl.appendChild(createBadge(translate('popup_badge_live'), 'warning', doc));
    }
    if (meta && Array.isArray(meta.subtitles) && meta.subtitles.length > 0) {
      badgesEl.appendChild(createBadge(translate('popup_badge_subtitles'), 'default', doc));
    }
  } else if (item.isMse) {
    badgesEl.appendChild(createBadge(translate('popup_badge_mse'), 'accent', doc));
    if (item.ext) {
      badgesEl.appendChild(createBadge(item.ext.toUpperCase(), 'default', doc));
    }
    if (item.capped) {
      badgesEl.appendChild(createBadge(translate('popup_badge_mse_capped'), 'warning', doc));
    }
  } else if (item.ext) {
    badgesEl.appendChild(createBadge(item.ext.toUpperCase(), 'default', doc));
  }
  if (item.width && item.height) {
    badgesEl.appendChild(createBadge(`${item.width}x${item.height}`, 'default', doc));
  }
  const durationText = formatDuration(item.duration);
  if (durationText) {
    badgesEl.appendChild(createBadge(durationText, 'default', doc));
  }
  const sizeText = formatBytes(item.sizeBytes);
  if (sizeText) {
    badgesEl.appendChild(createBadge(sizeText, 'default', doc));
  }
  if (item.isStream && entry && context.getSettings) {
    const settings = context.getSettings();
    const estBytes = getEstimatedStreamBytes(entry, context.hlsMetaByUrl);
    const maxMb = String(Math.round(LIMITS.MAX_HLS_BUFFER_BYTES / UNIT_CONVERSIONS.BYTES_PER_MB));
    const thresholdBytes = settings.largeStreamWarningMb * UNIT_CONVERSIONS.BYTES_PER_MB;
    if (estBytes > LIMITS.MAX_HLS_BUFFER_BYTES) {
      badgesEl.appendChild(createBadge(translate('popup_badge_exceeds_limit', [maxMb]), 'warning', doc));
    } else if (thresholdBytes > 0 && estBytes >= thresholdBytes) {
      badgesEl.appendChild(createBadge(translate('popup_badge_large_stream'), 'warning', doc));
    }
    const chosenVariant = getSelectedVariant(meta, entry);
    if (
      isDash &&
      chosenVariant &&
      chosenVariant.mimeType === 'video/webm' &&
      meta &&
      Array.isArray(meta.audioTracks) &&
      meta.audioTracks.length > 0
    ) {
      badgesEl.appendChild(createBadge(translate('popup_badge_video_only'), 'warning', doc));
    }
  }
  badgesEl.appendChild(
    createBadge(
      item.source === MEDIA_SOURCES.NETWORK ? translate('popup_badge_network') : translate('popup_badge_dom'),
      'default',
      doc
    )
  );
}

/**
 * Updates inline cap-exceeded warning banner on a stream card without clobbering active errors.
 * @param {object} entry
 * @param {object} context
 */
export function updateStreamLimitWarning(entry, context = {}) {
  const { translate } = resolveCardDeps(context);
  if (!entry || entry.activeRequestId) {
    return;
  }
  const meta = context.hlsMetaByUrl ? context.hlsMetaByUrl.get(entry.item.url) : null;
  if (meta && (meta.encrypted || meta.isDynamic)) {
    return;
  }
  const estBytes = getEstimatedStreamBytes(entry, context.hlsMetaByUrl);
  if (estBytes > LIMITS.MAX_HLS_BUFFER_BYTES) {
    const maxMb = String(Math.round(LIMITS.MAX_HLS_BUFFER_BYTES / UNIT_CONVERSIONS.BYTES_PER_MB));
    entry.progressEl.className = 'error-line';
    entry.progressEl.textContent = translate('popup_warning_exceeds_limit', [maxMb]);
    entry.progressEl.classList.remove('hidden');
    entry.showingCapWarning = true;
  } else if (entry.showingCapWarning) {
    entry.showingCapWarning = false;
    entry.progressEl.classList.add('hidden');
    entry.progressEl.textContent = '';
  }
}

/**
 * Populates the optional audio track selector when a stream offers multiple audio tracks.
 * @param {object} entry
 * @param {object} meta
 * @param {Document} doc
 * @param {Function} translate
 */
function populateAudioSelector(entry, meta, doc, translate) {
  const { audioSelect } = entry;
  if (!audioSelect) {
    return;
  }
  const tracks = Array.isArray(meta.audioTracks) ? meta.audioTracks : [];
  const chosenVariant = getSelectedVariant(meta, entry);
  const matchingGroupTracks = chosenVariant && chosenVariant.audioGroup
    ? tracks.filter((track) => !track.groupId || track.groupId === chosenVariant.audioGroup)
    : tracks;
  const candidateTracks = matchingGroupTracks.length > 0 ? matchingGroupTracks : tracks;

  if (candidateTracks.length <= 1) {
    audioSelect.replaceChildren();
    audioSelect.classList.add('hidden');
    return;
  }

  const prevValue = audioSelect.value;
  audioSelect.replaceChildren();
  for (const track of candidateTracks) {
    const option = doc.createElement('option');
    option.value = track.url;
    const label = [track.language, track.name].filter(Boolean).join(' - ')
      || translate('popup_audio_select_label');
    option.textContent = label;
    audioSelect.appendChild(option);
  }
  const keepIdx = prevValue ? candidateTracks.findIndex((tItem) => tItem.url === prevValue) : -1;
  audioSelect.selectedIndex = keepIdx >= 0 ? keepIdx : 0;
  audioSelect.classList.remove('hidden');
}

/**
 * Populates the optional subtitle track selector and download button for HLS subtitle groups.
 * @param {object} entry
 * @param {object} meta
 * @param {Document} doc
 * @param {Function} translate
 */
function populateSubtitleSelector(entry, meta, doc, translate) {
  const { subtitleSelect, subtitleBtn } = entry;
  if (!subtitleSelect || !subtitleBtn) {
    return;
  }
  const tracks = Array.isArray(meta.subtitles) ? meta.subtitles : [];
  if (tracks.length === 0) {
    subtitleSelect.replaceChildren();
    subtitleSelect.classList.add('hidden');
    subtitleBtn.classList.add('hidden');
    return;
  }

  const prevValue = subtitleSelect.value;
  subtitleSelect.replaceChildren();
  for (const track of tracks) {
    const option = doc.createElement('option');
    option.value = track.url;
    const label = [track.language, track.name].filter(Boolean).join(' - ')
      || translate('popup_subtitle_select_label');
    option.textContent = label;
    subtitleSelect.appendChild(option);
  }
  const keepIdx = prevValue ? tracks.findIndex((tItem) => tItem.url === prevValue) : -1;
  const defaultIdx = keepIdx >= 0 ? keepIdx : tracks.findIndex((tItem) => tItem.isDefault);
  subtitleSelect.selectedIndex = defaultIdx >= 0 ? defaultIdx : 0;
  subtitleSelect.classList.remove('hidden');
  subtitleBtn.classList.remove('hidden');
}

/**
 * Reveals the retry inspection action and surfaces the inspection failure reason.
 * @param {object} entry
 * @param {string} [errorCode='']
 * @param {object} [context={}]
 */
export function markInspectionFailed(entry, errorCode = '', context = {}) {
  if (!entry) {
    return;
  }
  if (entry.retryInspectBtn) {
    entry.retryInspectBtn.classList.remove('hidden');
  }
  if (errorCode && entry.progressEl && !entry.activeRequestId) {
    const { translate } = resolveCardDeps(context);
    const reason = localizeError(errorCode, translate);
    entry.progressEl.className = 'error-line';
    entry.progressEl.textContent = translate('popup_error_inspect_failed', [reason]);
    entry.progressEl.classList.remove('hidden');
  }
}

/**
 * Enables or disables video preview trigger controls on a media card.
 * @param {object} entry
 * @param {boolean} disabled
 */
function setPreviewDisabled(entry, disabled) {
  if (entry.previewBtn) {
    entry.previewBtn.disabled = disabled;
  }
  if (entry.thumbEl && entry.thumbEl.tagName === 'BUTTON') {
    entry.thumbEl.disabled = disabled;
    entry.thumbEl.classList.toggle('is-clickable', !disabled);
  }
  if (disabled && entry.previewBox && !entry.previewBox.classList.contains('hidden')) {
    closeCardPreview(entry);
  }
}

/**
 * Checks whether a stream entry can extract an autonomous M4A track without a companion binary.
 * @param {object} entry
 * @param {object | null} meta
 * @returns {{ hasSeparateAudio: boolean, canBrowserMuxedAudio: boolean, canMseAudio: boolean }}
 */
function resolveAudioExtractCapabilities(entry, meta) {
  const { item } = entry;
  const hasSeparateAudio = Boolean(meta && Array.isArray(meta.audioTracks) && meta.audioTracks.length > 0);
  const selectedVariantUrl = entry.qualitySelect && !entry.qualitySelect.classList.contains('hidden')
    ? entry.qualitySelect.value
    : '';
  const selectedVariant = meta && Array.isArray(meta.variants)
    ? (meta.variants.find((v) => v.url === selectedVariantUrl) || meta.variants[0] || null)
    : null;
  const isWebmStream = Boolean(
    (selectedVariant && typeof selectedVariant.mimeType === 'string' && selectedVariant.mimeType.toLowerCase().includes('webm'))
    || (item.ext || '').toLowerCase() === DEFAULT_FILENAMES.WEBM_EXT
  );
  const canBrowserMuxedAudio = Boolean(
    item.isStream
    && meta
    && !meta.encrypted
    && !meta.isDynamic
    && !isWebmStream
    && Array.isArray(meta.variants)
    && meta.variants.length > 0
  );
  const canMseAudio = Boolean(
    item.isMse
    && item.type === MEDIA_TYPES.VIDEO
    && (item.ext || '').toLowerCase() !== DEFAULT_FILENAMES.WEBM_EXT
  );
  return { hasSeparateAudio, canBrowserMuxedAudio, canMseAudio };
}

/**
 * Updates visibility of the audio extraction button based on stream/MSE capabilities or companion availability.
 * @param {object} entry
 * @param {object} [context={}]
 */
export function refreshAudioExtractButton(entry, context = {}) {
  if (!entry || !entry.audioExtractBtn) {
    return;
  }
  const { item } = entry;
  const meta = context.hlsMetaByUrl ? context.hlsMetaByUrl.get(item.url) : null;
  const { hasSeparateAudio, canBrowserMuxedAudio, canMseAudio } = resolveAudioExtractCapabilities(entry, meta);
  const companionOk = !item.isMse && Boolean(context.isCompanionAvailable && context.isCompanionAvailable());
  const visible = !item.isBlocked && (hasSeparateAudio || canBrowserMuxedAudio || canMseAudio || companionOk);
  entry.audioExtractBtn.classList.toggle('hidden', !visible);
}

/**
 * Applies inspected stream metadata (DRM, live status, video/audio variants) onto a card.
 * @param {object} entry
 * @param {object} meta
 * @param {object} context
 */
export function applyStreamMetadata(entry, meta, context = {}) {
  const { doc, translate } = resolveCardDeps(context);
  const { item, qualitySelect, downloadBtn, progressEl, retryInspectBtn } = entry;

  if (retryInspectBtn) {
    retryInspectBtn.classList.add('hidden');
  }

  if (meta.encrypted) {
    item.isBlocked = true;
    downloadBtn.disabled = true;
    if (entry.selectCheckbox) {
      entry.selectCheckbox.checked = false;
      entry.selectCheckbox.disabled = true;
      if (context.onSelectionChange) {
        context.onSelectionChange(entry, false);
      }
    }
    setPreviewDisabled(entry, true);
    progressEl.className = 'error-line';
    progressEl.textContent = translate('popup_error_encrypted_stream');
    progressEl.classList.remove('hidden');
    renderBadges(entry.badgesEl, item, entry, context);
    refreshAudioExtractButton(entry, context);
    return;
  }

  const isLiveDvr = Boolean(
    meta.isDynamic && (meta.streamFormat === 'hls' || meta.streamFormat === 'dash')
  );
  if (meta.isDynamic && !isLiveDvr) {
    item.isDynamic = true;
    item.isBlocked = true;
    item.canRecordLive = false;
    downloadBtn.disabled = true;
    if (entry.selectCheckbox) {
      entry.selectCheckbox.checked = false;
      entry.selectCheckbox.disabled = true;
      if (context.onSelectionChange) {
        context.onSelectionChange(entry, false);
      }
    }
    setPreviewDisabled(entry, true);
    progressEl.className = 'error-line';
    progressEl.textContent = translate('popup_error_live_stream');
    progressEl.classList.remove('hidden');
    renderBadges(entry.badgesEl, item, entry, context);
    refreshAudioExtractButton(entry, context);
    return;
  }

  item.isDynamic = isLiveDvr;
  item.isBlocked = false;
  item.canRecordLive = isLiveDvr;
  downloadBtn.disabled = Boolean(entry.activeRequestId);
  downloadBtn.textContent = translate(isLiveDvr ? 'popup_action_record_live' : 'popup_action_download');
  if (entry.selectCheckbox) {
    if (isLiveDvr) {
      entry.selectCheckbox.checked = false;
      entry.selectCheckbox.disabled = true;
      if (context.onSelectionChange) {
        context.onSelectionChange(entry, false);
      }
    } else {
      entry.selectCheckbox.disabled = false;
    }
  }

  setPreviewDisabled(entry, isLiveDvr);
  if (!entry.activeRequestId && !entry.showingCapWarning) {
    progressEl.classList.add('hidden');
    progressEl.textContent = '';
  }

  if (Array.isArray(meta.variants) && meta.variants.length > 0) {
    qualitySelect.replaceChildren();
    for (const variant of meta.variants) {
      const option = doc.createElement('option');
      option.value = variant.url;
      const bitrateKbps = variant.bandwidth
        ? `${Math.round(variant.bandwidth / UNIT_CONVERSIONS.BITS_PER_KB)} kbps`
        : '';
      const estSize = variant.estimatedBytes ? `(~${formatBytes(variant.estimatedBytes)})` : '';
      option.textContent = [variant.resolution, bitrateKbps, estSize].filter(Boolean).join(' ')
        || translate('popup_quality_best');
      qualitySelect.appendChild(option);
    }
    const settings = context.getSettings ? context.getSettings() : {};
    qualitySelect.selectedIndex = settings.defaultQuality === QUALITY_PREFERENCES.LOWEST
      ? qualitySelect.options.length - 1
      : 0;
    qualitySelect.classList.remove('hidden');
  }

  populateAudioSelector(entry, meta, doc, translate);
  populateSubtitleSelector(entry, meta, doc, translate);

  if (meta.totalDurationSec && !item.duration) {
    item.duration = meta.totalDurationSec;
  }
  renderBadges(entry.badgesEl, item, entry, context);
  updateStreamLimitWarning(entry, context);
  refreshAudioExtractButton(entry, context);
}

/**
 * Builds the copy-URL icon button with visible copied feedback.
 * @param {object} entry
 * @param {(text: string, isError?: boolean) => void} onStatus
 * @param {Document} doc
 * @param {Function} translate
 * @param {object} [context={}]
 * @returns {HTMLButtonElement}
 */
function createCopyButton(entry, onStatus, doc, translate, context = {}) {
  const copyBtn = doc.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'icon-btn';
  copyBtn.title = translate('popup_action_copy_url');
  copyBtn.setAttribute('aria-label', translate('popup_action_copy_url'));

  const copySvg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  copySvg.setAttribute('aria-hidden', 'true');
  copySvg.setAttribute('viewBox', '0 0 24 24');
  copySvg.setAttribute('width', '14');
  copySvg.setAttribute('height', '14');
  copySvg.setAttribute('fill', 'none');
  copySvg.setAttribute('stroke', 'currentColor');
  copySvg.setAttribute('stroke-width', '2');
  const copyRect = doc.createElementNS('http://www.w3.org/2000/svg', 'rect');
  copyRect.setAttribute('x', '9');
  copyRect.setAttribute('y', '9');
  copyRect.setAttribute('width', '13');
  copyRect.setAttribute('height', '13');
  copyRect.setAttribute('rx', '2');
  const copyPath = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
  copyPath.setAttribute('d', 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1');
  copySvg.append(copyRect, copyPath);
  copyBtn.appendChild(copySvg);

  let resetTimer = null;
  copyBtn.addEventListener('click', async () => {
    try {
      const targetUrl = (entry.qualitySelect && !entry.qualitySelect.classList.contains('hidden') && entry.qualitySelect.value)
        ? entry.qualitySelect.value
        : entry.item.url;
      const writeFn = context.writeClipboardFn
        || (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function'
          ? (text) => navigator.clipboard.writeText(text)
          : null);
      if (writeFn) {
        await writeFn(targetUrl);
      }
      copyBtn.title = translate('popup_action_copied');
      copyBtn.classList.add('is-copied');
      onStatus(translate('popup_action_copied'));
      clearTimeout(resetTimer);
      resetTimer = setTimeout(() => {
        copyBtn.title = translate('popup_action_copy_url');
        copyBtn.classList.remove('is-copied');
      }, LIMITS.COPY_FEEDBACK_MS);
    } catch (err) {
      onStatus(localizeError(err && err.message, translate), true);
    }
  });

  return copyBtn;
}

/**
 * Decodes inline SVG markup from a card item or data URI, or fetches remote SVG XML.
 * @param {object} item
 * @returns {Promise<string>}
 */
async function resolveSvgMarkup(item) {
  if (item.svgMarkup) {
    return item.svgMarkup;
  }
  if (isSvgDataUrl(item.url)) {
    const commaIdx = item.url.indexOf(',');
    if (commaIdx >= 0) {
      const header = item.url.slice(0, commaIdx).toLowerCase();
      const body = item.url.slice(commaIdx + 1);
      return header.includes(';base64') ? atob(body) : decodeURIComponent(body);
    }
  }
  const resp = await fetch(item.url);
  if (!resp.ok) {
    throw new Error('DOWNLOAD_FAILED');
  }
  return resp.text();
}

/**
 * Builds the Copy SVG code button for inline and external SVG cards.
 * @param {object} entry
 * @param {(text: string, isError?: boolean) => void} onStatus
 * @param {Document} doc
 * @param {Function} translate
 * @param {object} [context={}]
 * @returns {HTMLButtonElement}
 */
function createCopySvgButton(entry, onStatus, doc, translate, context = {}) {
  const svgBtn = doc.createElement('button');
  svgBtn.type = 'button';
  svgBtn.className = 'action-chip copy-svg-btn';
  svgBtn.textContent = translate('popup_action_copy_svg');

  let resetTimer = null;
  svgBtn.addEventListener('click', async () => {
    try {
      const markup = await resolveSvgMarkup(entry.item);
      const writeFn = context.writeClipboardFn
        || (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function'
          ? (text) => navigator.clipboard.writeText(text)
          : null);
      if (writeFn) {
        await writeFn(markup);
      }
      svgBtn.textContent = translate('popup_action_copied');
      svgBtn.classList.add('is-copied');
      onStatus(translate('popup_action_copied'));
      clearTimeout(resetTimer);
      resetTimer = setTimeout(() => {
        svgBtn.textContent = translate('popup_action_copy_svg');
        svgBtn.classList.remove('is-copied');
      }, LIMITS.COPY_FEEDBACK_MS);
    } catch (err) {
      onStatus(localizeError(err && err.message, translate), true);
    }
  });

  return svgBtn;
}

/**
 * Builds a quick PNG/JPG conversion button for raster images and SVG graphics.
 * @param {'png' | 'jpg'} targetFormat
 * @param {object} entry
 * @param {Document} doc
 * @param {Function} translate
 * @param {object} context
 * @returns {HTMLButtonElement}
 */
function createImageConvertButton(targetFormat, entry, doc, translate, context) {
  const isPng = targetFormat === IMAGE_CONVERT_FORMATS.PNG;
  const btn = doc.createElement('button');
  btn.type = 'button';
  btn.className = 'action-chip convert-btn';
  btn.textContent = translate(isPng ? 'popup_action_convert_png' : 'popup_action_convert_jpg');
  btn.title = translate(isPng ? 'popup_action_convert_png_title' : 'popup_action_convert_jpg_title');
  btn.addEventListener('click', () => {
    if (context.onConvertImage) {
      context.onConvertImage(entry, targetFormat);
    }
  });
  return btn;
}

/**
 * Creates a reusable media card entry with bound listeners reading entry.item.
 * @param {object} item
 * @param {object} context
 * @returns {object}
 */
export function createMediaCard(item, context = {}) {
  const { doc, translate, togglePreview, refreshPreview } = resolveCardDeps(context);
  const isVideoLike = item.type === MEDIA_TYPES.VIDEO || item.type === MEDIA_TYPES.STREAM;
  const canPreview = !item.isMse && (isVideoLike || item.type === MEDIA_TYPES.AUDIO);
  const canLightbox = !item.isMse && item.type === MEDIA_TYPES.IMAGE && Boolean(item.url);
  const card = doc.createElement('article');
  card.className = 'media-card';

  const row = doc.createElement('div');
  row.className = 'media-row';

  const selectCheckbox = doc.createElement('input');
  selectCheckbox.type = 'checkbox';
  selectCheckbox.className = 'card-select';
  selectCheckbox.setAttribute('aria-label', translate('popup_card_select_aria'));
  selectCheckbox.checked = Boolean(context.isSelected && context.isSelected(item.url));
  selectCheckbox.disabled = Boolean(item.isBlocked);
  row.appendChild(selectCheckbox);

  const thumbEl = doc.createElement(canPreview || canLightbox ? 'button' : 'div');
  if (canPreview) {
    thumbEl.type = 'button';
    thumbEl.className = 'thumb thumb-btn is-clickable';
    thumbEl.setAttribute('aria-label', translate('popup_action_preview'));
    thumbEl.setAttribute('aria-expanded', 'false');
  } else if (canLightbox) {
    thumbEl.type = 'button';
    thumbEl.className = 'thumb thumb-btn is-clickable';
    thumbEl.setAttribute('aria-label', translate('popup_action_lightbox_open'));
  } else {
    thumbEl.className = 'thumb';
  }
  renderThumbnailContent(thumbEl, item, doc);
  row.appendChild(thumbEl);

  const meta = doc.createElement('div');
  meta.className = 'meta';

  const nameEl = doc.createElement('div');
  nameEl.className = 'filename';
  nameEl.textContent = item.suggestedFilename || item.url;
  const fullName = item.suggestedFilename || '';
  nameEl.title = fullName && fullName !== item.url ? `${fullName}\n${item.url}` : item.url;
  meta.appendChild(nameEl);

  const badgesEl = doc.createElement('div');
  badgesEl.className = 'badges';
  meta.appendChild(badgesEl);

  row.appendChild(meta);
  card.appendChild(row);

  const previewBox = doc.createElement('div');
  previewBox.className = 'preview-box hidden';
  card.appendChild(previewBox);

  const controls = doc.createElement('div');
  controls.className = 'controls';

  const qualitySelect = doc.createElement('select');
  qualitySelect.className = 'quality-select hidden';
  qualitySelect.setAttribute('aria-label', translate('popup_quality_select_label'));
  controls.appendChild(qualitySelect);

  const audioSelect = doc.createElement('select');
  audioSelect.className = 'quality-select audio-select hidden';
  audioSelect.setAttribute('aria-label', translate('popup_audio_select_label'));
  controls.appendChild(audioSelect);

  const subtitleSelect = doc.createElement('select');
  subtitleSelect.className = 'quality-select subtitle-select hidden';
  subtitleSelect.setAttribute('aria-label', translate('popup_subtitle_select_label'));
  controls.appendChild(subtitleSelect);

  const entry = {
    item,
    card,
    selectCheckbox,
    thumbEl,
    nameEl,
    badgesEl,
    previewBox,
    qualitySelect,
    audioSelect,
    subtitleSelect,
    subtitleBtn: null,
    previewBtn: null,
    retryInspectBtn: null,
    downloadBtn: null,
    cancelBtn: null,
    progressEl: null,
    previewBlobUrl: '',
    activeRequestId: '',
    showingCapWarning: false,
    hlsHydrated: false
  };

  selectCheckbox.addEventListener('change', () => {
    if (context.onSelectionChange) {
      context.onSelectionChange(entry, Boolean(selectCheckbox.checked));
    }
  });

  renderBadges(badgesEl, item, entry, context);

  qualitySelect.addEventListener('change', () => {
    const streamMeta = context.hlsMetaByUrl ? context.hlsMetaByUrl.get(entry.item.url) : null;
    if (streamMeta) {
      populateAudioSelector(entry, streamMeta, doc, translate);
    }
    renderBadges(entry.badgesEl, entry.item, entry, context);
    updateStreamLimitWarning(entry, context);
    refreshAudioExtractButton(entry, context);
    refreshPreview(entry);
  });

  if (canPreview) {
    const previewBtn = doc.createElement('button');
    previewBtn.type = 'button';
    previewBtn.className = 'action-chip';
    previewBtn.textContent = translate('popup_action_preview');
    const handlePreview = () => togglePreview(entry);
    previewBtn.addEventListener('click', handlePreview);
    thumbEl.addEventListener('click', handlePreview);
    controls.appendChild(previewBtn);
    entry.previewBtn = previewBtn;
  } else if (canLightbox) {
    thumbEl.addEventListener('click', () => {
      if (context.onOpenLightbox) {
        context.onOpenLightbox(entry);
      }
    });
  }

  if (item.isStream) {
    const subtitleBtn = doc.createElement('button');
    subtitleBtn.type = 'button';
    subtitleBtn.className = 'action-chip subtitle-btn hidden';
    subtitleBtn.textContent = translate('popup_action_download_subtitle');
    subtitleBtn.addEventListener('click', () => {
      if (context.onDownloadSubtitle && subtitleSelect.value) {
        context.onDownloadSubtitle(entry, subtitleSelect.value);
      }
    });
    controls.appendChild(subtitleBtn);
    entry.subtitleBtn = subtitleBtn;

    const retryInspectBtn = doc.createElement('button');
    retryInspectBtn.type = 'button';
    retryInspectBtn.className = 'action-chip hidden';
    retryInspectBtn.textContent = translate('popup_action_retry_inspect');
    retryInspectBtn.addEventListener('click', () => {
      retryInspectBtn.classList.add('hidden');
      if (!entry.activeRequestId && entry.progressEl) {
        entry.progressEl.classList.add('hidden');
        entry.progressEl.textContent = '';
      }
      entry.hlsHydrated = false;
      if (context.onHydrateRequest) {
        context.onHydrateRequest(entry);
      }
    });
    controls.appendChild(retryInspectBtn);
    entry.retryInspectBtn = retryInspectBtn;
  }

  const copyBtn = isSvgDataUrl(item.url)
    ? null
    : createCopyButton(entry, context.onStatus || (() => {}), doc, translate, context);
  if (copyBtn) {
    controls.appendChild(copyBtn);
    entry.copyBtn = copyBtn;
  }

  const itemExt = (item.ext || '').toLowerCase();
  if (item.type === MEDIA_TYPES.IMAGE && !item.isMse) {
    if (itemExt === DEFAULT_FILENAMES.SVG_EXT || isSvgDataUrl(item.url)) {
      const copySvgBtn = createCopySvgButton(entry, context.onStatus || (() => {}), doc, translate, context);
      controls.appendChild(copySvgBtn);
      entry.copySvgBtn = copySvgBtn;
    }
    if (itemExt !== IMAGE_CONVERT_FORMATS.PNG) {
      const toPngBtn = createImageConvertButton(IMAGE_CONVERT_FORMATS.PNG, entry, doc, translate, context);
      controls.appendChild(toPngBtn);
      entry.convertPngBtn = toPngBtn;
    }
    if (itemExt !== IMAGE_CONVERT_FORMATS.JPG && itemExt !== 'jpeg') {
      const toJpgBtn = createImageConvertButton(IMAGE_CONVERT_FORMATS.JPG, entry, doc, translate, context);
      controls.appendChild(toJpgBtn);
      entry.convertJpgBtn = toJpgBtn;
    }
  }

  const isCompanionEligible = !item.isMse && (
    item.type === MEDIA_TYPES.VIDEO ||
    item.type === MEDIA_TYPES.STREAM ||
    item.type === MEDIA_TYPES.AUDIO
  );
  const isMseAudioEligible = Boolean(
    item.isMse && item.type === MEDIA_TYPES.VIDEO && itemExt !== DEFAULT_FILENAMES.WEBM_EXT
  );
  if (isMseAudioEligible || (!item.isMse && (item.type === MEDIA_TYPES.VIDEO || item.type === MEDIA_TYPES.STREAM))) {
    const audioExtractBtn = doc.createElement('button');
    audioExtractBtn.type = 'button';
    audioExtractBtn.className = 'action-chip audio-extract-btn hidden';
    audioExtractBtn.textContent = translate('popup_action_extract_audio');
    audioExtractBtn.title = translate('popup_action_extract_audio_title');
    audioExtractBtn.addEventListener('click', () => {
      const streamMeta = context.hlsMetaByUrl ? context.hlsMetaByUrl.get(entry.item.url) : null;
      const { hasSeparateAudio, canBrowserMuxedAudio, canMseAudio } = resolveAudioExtractCapabilities(entry, streamMeta);
      const canBrowserAudio = hasSeparateAudio || canBrowserMuxedAudio || canMseAudio;
      const chosenUrl = !qualitySelect.classList.contains('hidden') ? qualitySelect.value : entry.item.url;
      const chosenAudioUrl = !audioSelect.classList.contains('hidden') ? audioSelect.value : '';
      if (context.onExtractAudio) {
        context.onExtractAudio(entry, chosenUrl, chosenAudioUrl, !canBrowserAudio);
      }
    });
    controls.appendChild(audioExtractBtn);
    entry.audioExtractBtn = audioExtractBtn;
    refreshAudioExtractButton(entry, context);
  }
  if (isCompanionEligible) {
    const companionBtn = doc.createElement('button');
    companionBtn.type = 'button';
    companionBtn.className = 'action-chip companion-btn';
    if (!context.isCompanionAvailable || !context.isCompanionAvailable()) {
      companionBtn.classList.add('hidden');
    }
    companionBtn.textContent = translate('popup_action_companion_item');
    companionBtn.addEventListener('click', () => {
      const chosenUrl = !qualitySelect.classList.contains('hidden') ? qualitySelect.value : entry.item.url;
      if (context.onCompanionDownload) {
        context.onCompanionDownload(entry, chosenUrl);
      }
    });
    controls.appendChild(companionBtn);
    entry.companionBtn = companionBtn;
  }

  let stopRecordBtn = null;
  if (item.isStream) {
    stopRecordBtn = doc.createElement('button');
    stopRecordBtn.type = 'button';
    stopRecordBtn.className = 'btn btn-primary hidden';
    stopRecordBtn.textContent = translate('popup_action_stop_record');
    stopRecordBtn.addEventListener('click', () => {
      if (!entry.activeRequestId) {
        return;
      }
      stopRecordBtn.disabled = true;
      if (context.onStopRecord) {
        context.onStopRecord(entry.activeRequestId);
      }
    });
    controls.appendChild(stopRecordBtn);
  }

  const cancelBtn = doc.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'btn btn-cancel hidden';
  cancelBtn.textContent = translate('popup_action_cancel');
  cancelBtn.addEventListener('click', () => {
    if (!entry.activeRequestId) {
      return;
    }
    cancelBtn.disabled = true;
    if (context.onCancel) {
      context.onCancel(entry.activeRequestId);
    }
  });
  controls.appendChild(cancelBtn);

  const downloadBtn = doc.createElement('button');
  downloadBtn.type = 'button';
  downloadBtn.className = 'btn btn-primary';
  downloadBtn.textContent = translate('popup_action_download');
  controls.appendChild(downloadBtn);
  card.appendChild(controls);

  const progressEl = doc.createElement('div');
  progressEl.className = 'progress-line hidden';
  progressEl.setAttribute('aria-live', 'polite');
  card.appendChild(progressEl);

  entry.downloadBtn = downloadBtn;
  entry.stopRecordBtn = stopRecordBtn;
  entry.cancelBtn = cancelBtn;
  entry.progressEl = progressEl;

  downloadBtn.addEventListener('click', () => {
    const chosenUrl = !qualitySelect.classList.contains('hidden') ? qualitySelect.value : entry.item.url;
    const chosenAudioUrl = !audioSelect.classList.contains('hidden') ? audioSelect.value : '';
    if (context.onDownload) {
      context.onDownload(entry, chosenUrl, chosenAudioUrl, {
        recordLive: Boolean(entry.item.canRecordLive)
      });
    }
  });

  if (item.isStream && item.type === MEDIA_TYPES.STREAM && context.onHydrateRequest) {
    context.onHydrateRequest(entry);
  }

  return entry;
}

/**
 * Updates an existing card entry in place without disturbing active previews or selects.
 * @param {object} entry
 * @param {object} nextItem
 * @param {object} context
 */
export function updateCardEntry(entry, nextItem, context = {}) {
  const { doc } = resolveCardDeps(context);
  const prevBlocked = Boolean(entry.item && entry.item.isBlocked);
  entry.item = nextItem;
  if (prevBlocked) {
    entry.item.isBlocked = prevBlocked;
  }
  entry.nameEl.textContent = nextItem.suggestedFilename || nextItem.url;
  const nextFullName = nextItem.suggestedFilename || '';
  entry.nameEl.title = nextFullName && nextFullName !== nextItem.url
    ? `${nextFullName}\n${nextItem.url}`
    : nextItem.url;
  if (entry.selectCheckbox) {
    entry.selectCheckbox.disabled = Boolean(entry.item.isBlocked);
    if (context.isSelected) {
      entry.selectCheckbox.checked = !entry.item.isBlocked && Boolean(context.isSelected(nextItem.url));
    }
  }
  renderThumbnailContent(entry.thumbEl, nextItem, doc);
  renderBadges(entry.badgesEl, nextItem, entry, context);
  updateStreamLimitWarning(entry, context);
  if (entry.companionBtn && context.isCompanionAvailable) {
    entry.companionBtn.classList.toggle('hidden', !context.isCompanionAvailable());
  }
  refreshAudioExtractButton(entry, context);
  if (nextItem.isStream && nextItem.type === MEDIA_TYPES.STREAM && !entry.hlsHydrated && context.onHydrateRequest) {
    context.onHydrateRequest(entry);
  }
}
