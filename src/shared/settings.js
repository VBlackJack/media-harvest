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
  DEFAULT_SETTINGS,
  FILENAME_TEMPLATES,
  LIMITS,
  QUALITY_PREFERENCES,
  STORAGE_KEYS
} from '../config/constants.js';

const VALID_QUALITIES = new Set(Object.values(QUALITY_PREFERENCES));
const VALID_TEMPLATES = new Set(Object.values(FILENAME_TEMPLATES));
const MAX_MIN_IMAGE_DIMENSION_PX = 2000;
const MAX_LARGE_STREAM_WARNING_MB = 2048;

/**
 * Clamps an integer setting within [min, max], falling back when invalid.
 * @param {unknown} raw
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clampInteger(raw, fallback, min, max) {
  const num = Number.parseInt(raw, 10);
  if (!Number.isFinite(num)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, num));
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
      0,
      MAX_MIN_IMAGE_DIMENSION_PX
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
      0,
      MAX_LARGE_STREAM_WARNING_MB
    ),
    enableXOverlay: typeof src.enableXOverlay === 'boolean'
      ? src.enableXOverlay
      : DEFAULT_SETTINGS.enableXOverlay
  };
}

/**
 * Applies a filename template to a derived stem and source URL context.
 * @param {string} template
 * @param {{ stem: string, pageUrl?: string, mediaUrl?: string, now?: Date }} context
 * @returns {string}
 */
export function applyFilenameTemplate(template, context) {
  const stem = (context && context.stem) || DEFAULT_FILENAMES.BASE;
  if (template === FILENAME_TEMPLATES.HOST_STEM) {
    const rawHostUrl = (context && (context.pageUrl || context.mediaUrl)) || '';
    try {
      const host = new URL(rawHostUrl).hostname.replace(/^www\./i, '');
      if (host) {
        return `${host}_${stem}`;
      }
    } catch {
      // Fall through to plain stem
    }
    return stem;
  }

  if (template === FILENAME_TEMPLATES.DATE_STEM) {
    const date = context && context.now instanceof Date ? context.now : new Date();
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}_${stem}`;
  }

  return stem;
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
