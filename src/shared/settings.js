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
  AUDIO_EXPORT_FORMATS,
  DEFAULT_FILENAMES,
  DEFAULT_SETTINGS,
  FILENAME_TEMPLATES,
  LIMITS,
  QUALITY_PREFERENCES,
  STORAGE_KEYS
} from '../config/constants.js';

const VALID_QUALITIES = new Set(Object.values(QUALITY_PREFERENCES));
const VALID_TEMPLATES = new Set(Object.values(FILENAME_TEMPLATES));
const VALID_AUDIO_FORMATS = new Set(Object.values(AUDIO_EXPORT_FORMATS));

/**
 * Clamps an integer setting within [min, max], falling back when invalid.
 * @param {unknown} raw
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clampInteger(raw, fallback, min, max) {
  const num = typeof raw === 'number'
    ? (Number.isFinite(raw) ? Math.trunc(raw) : Number.NaN)
    : Number.parseInt(String(raw), 10);
  if (!Number.isFinite(num)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, num));
}

/**
 * Normalizes a list or comma/newline-separated string of excluded overlay hostnames.
 * @param {unknown} raw
 * @returns {string[]}
 */
export function normalizeDisabledOverlayHosts(raw) {
  const entries = Array.isArray(raw)
    ? raw
    : (typeof raw === 'string' ? raw.split(/[\s,;]+/) : []);
  const seen = new Set();
  const out = [];
  for (const item of entries) {
    if (typeof item !== 'string') {
      continue;
    }
    const clean = item.trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0].replace(/^www\./, '');
    if (!clean || !/^[a-z0-9.-]+$/.test(clean) || !clean.includes('.')) {
      continue;
    }
    if (!seen.has(clean)) {
      seen.add(clean);
      out.push(clean);
      if (out.length >= LIMITS.MAX_DISABLED_OVERLAY_HOSTS) {
        break;
      }
    }
  }
  return out;
}

/**
 * Validates and normalizes user settings against defaults and safe bounds.
 * @param {object | null | undefined} raw
 * @returns {object}
 */
export function normalizeSettings(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    defaultQuality: VALID_QUALITIES.has(src.defaultQuality)
      ? src.defaultQuality
      : DEFAULT_SETTINGS.defaultQuality,
    filenameTemplate: VALID_TEMPLATES.has(src.filenameTemplate)
      ? src.filenameTemplate
      : DEFAULT_SETTINGS.filenameTemplate,
    minImageDimensionPx: clampInteger(
      src.minImageDimensionPx,
      DEFAULT_SETTINGS.minImageDimensionPx,
      LIMITS.MIN_IMAGE_DIMENSION_MIN_PX,
      LIMITS.MIN_IMAGE_DIMENSION_MAX_PX
    ),
    hlsFetchConcurrency: clampInteger(
      src.hlsFetchConcurrency,
      DEFAULT_SETTINGS.hlsFetchConcurrency,
      LIMITS.MIN_HLS_CONCURRENCY,
      LIMITS.MAX_HLS_CONCURRENCY
    ),
    largeStreamWarningMb: clampInteger(
      src.largeStreamWarningMb,
      DEFAULT_SETTINGS.largeStreamWarningMb,
      LIMITS.LARGE_STREAM_WARNING_MIN_MB,
      LIMITS.LARGE_STREAM_WARNING_MAX_MB
    ),
    jpgQualityPercent: clampInteger(
      src.jpgQualityPercent,
      DEFAULT_SETTINGS.jpgQualityPercent,
      LIMITS.JPG_QUALITY_MIN_PERCENT,
      LIMITS.JPG_QUALITY_MAX_PERCENT
    ),
    maxImageResizePx: clampInteger(
      src.maxImageResizePx,
      DEFAULT_SETTINGS.maxImageResizePx,
      0,
      LIMITS.MAX_IMAGE_RESIZE_MAX_PX
    ),
    audioExportFormat: VALID_AUDIO_FORMATS.has(src.audioExportFormat)
      ? src.audioExportFormat
      : DEFAULT_SETTINGS.audioExportFormat,
    tabCaptureBitrateMbps: clampInteger(
      src.tabCaptureBitrateMbps,
      DEFAULT_SETTINGS.tabCaptureBitrateMbps,
      LIMITS.TAB_CAPTURE_BITRATE_MIN_MBPS,
      LIMITS.TAB_CAPTURE_BITRATE_MAX_MBPS
    ),
    enableXOverlay: typeof src.enableXOverlay === 'boolean'
      ? src.enableXOverlay
      : DEFAULT_SETTINGS.enableXOverlay,
    enableSocialOverlay: typeof src.enableSocialOverlay === 'boolean'
      ? src.enableSocialOverlay
      : DEFAULT_SETTINGS.enableSocialOverlay,
    enableGenericVideoOverlay: typeof src.enableGenericVideoOverlay === 'boolean'
      ? src.enableGenericVideoOverlay
      : DEFAULT_SETTINGS.enableGenericVideoOverlay,
    enableMseCapture: typeof src.enableMseCapture === 'boolean'
      ? src.enableMseCapture
      : DEFAULT_SETTINGS.enableMseCapture,
    enableCompanionCookies: typeof src.enableCompanionCookies === 'boolean'
      ? src.enableCompanionCookies
      : DEFAULT_SETTINGS.enableCompanionCookies,
    promptSaveAs: typeof src.promptSaveAs === 'boolean'
      ? src.promptSaveAs
      : DEFAULT_SETTINGS.promptSaveAs,
    disabledOverlayHosts: normalizeDisabledOverlayHosts(src.disabledOverlayHosts)
  };
}

/**
 * Extracts normalized hostname (without leading www.) from context URLs.
 * @param {{ pageUrl?: string, mediaUrl?: string }} context
 * @returns {string}
 */
function extractTemplateHost(context) {
  const rawHostUrl = (context && (context.pageUrl || context.mediaUrl)) || '';
  if (!rawHostUrl) {
    return '';
  }
  try {
    return new URL(rawHostUrl).hostname.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

/**
 * Formats YYYY-MM-DD date string from context clock.
 * @param {{ now?: Date }} context
 * @returns {string}
 */
function formatTemplateDate(context) {
  const date = context && context.now instanceof Date ? context.now : new Date();
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Applies a filename template to a derived stem and source URL context.
 * Folder templates produce "<folder>/<stem>" using forward slashes for Chrome downloads.
 * @param {string} template
 * @param {{ stem: string, pageUrl?: string, mediaUrl?: string, now?: Date }} context
 * @returns {string}
 */
export function applyFilenameTemplate(template, context) {
  const stem = (context && context.stem) || DEFAULT_FILENAMES.BASE;
  if (template === FILENAME_TEMPLATES.HOST_STEM || template === FILENAME_TEMPLATES.HOST_FOLDER) {
    const host = extractTemplateHost(context);
    if (!host) {
      return stem;
    }
    const separator = template === FILENAME_TEMPLATES.HOST_FOLDER ? '/' : '_';
    return `${host}${separator}${stem}`;
  }

  if (template === FILENAME_TEMPLATES.DATE_STEM || template === FILENAME_TEMPLATES.DATE_FOLDER) {
    const dateStr = formatTemplateDate(context);
    const separator = template === FILENAME_TEMPLATES.DATE_FOLDER ? '/' : '_';
    return `${dateStr}${separator}${stem}`;
  }

  return stem;
}

/**
 * Returns true if the filename template produces a subfolder prefix.
 * @param {string} template
 * @returns {boolean}
 */
export function isFolderFilenameTemplate(template) {
  return template === FILENAME_TEMPLATES.HOST_FOLDER || template === FILENAME_TEMPLATES.DATE_FOLDER;
}

/**
 * Loads normalized user settings from chrome.storage.sync.
 * @returns {Promise<object>}
 */
export async function loadSettings() {
  if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.sync) {
    return { ...DEFAULT_SETTINGS };
  }
  try {
    const stored = await chrome.storage.sync.get(STORAGE_KEYS.USER_SETTINGS);
    return normalizeSettings(stored[STORAGE_KEYS.USER_SETTINGS]);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * Persists normalized user settings into chrome.storage.sync.
 * @param {object} nextSettings
 * @returns {Promise<object>}
 */
export async function saveSettings(nextSettings) {
  const normalized = normalizeSettings(nextSettings);
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
    await chrome.storage.sync.set({ [STORAGE_KEYS.USER_SETTINGS]: normalized });
  }
  return normalized;
}
