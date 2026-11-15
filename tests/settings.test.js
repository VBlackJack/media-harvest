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

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUDIO_EXPORT_FORMATS,
  DEFAULT_SETTINGS,
  FILENAME_TEMPLATES,
  QUALITY_PREFERENCES,
  STORAGE_KEYS
} from '../src/config/constants.js';
import {
  applyFilenameTemplate,
  isFolderFilenameTemplate,
  loadSettings,
  normalizeSettings,
  saveSettings
} from '../src/shared/settings.js';

test('normalizeSettings validates enums and clamps numeric thresholds safely', () => {
  assert.deepEqual(normalizeSettings(null), DEFAULT_SETTINGS);

  const normalized = normalizeSettings({
    defaultQuality: 'ultra_fake',
    filenameTemplate: FILENAME_TEMPLATES.HOST_STEM,
    minImageDimensionPx: -20,
    hlsFetchConcurrency: 99,
    largeStreamWarningMb: 99999,
    jpgQualityPercent: 12,
    audioExportFormat: AUDIO_EXPORT_FORMATS.WAV,
    enableXOverlay: false
  });

  assert.equal(normalized.defaultQuality, QUALITY_PREFERENCES.BEST);
  assert.equal(normalized.filenameTemplate, FILENAME_TEMPLATES.HOST_STEM);
  assert.equal(normalized.minImageDimensionPx, 0);
  assert.equal(normalized.hlsFetchConcurrency, 8);
  assert.equal(normalized.largeStreamWarningMb, 512);
  assert.equal(normalized.jpgQualityPercent, 50);
  assert.equal(normalized.audioExportFormat, AUDIO_EXPORT_FORMATS.WAV);
  assert.equal(normalized.enableXOverlay, false);

  const overQuality = normalizeSettings({ jpgQualityPercent: 180, audioExportFormat: 'ogg' });
  assert.equal(overQuality.jpgQualityPercent, 100);
  assert.equal(overQuality.audioExportFormat, AUDIO_EXPORT_FORMATS.M4A);
});

test('applyFilenameTemplate formats default, host_stem, and date_stem consistently', () => {
  const now = new Date(2026, 10, 14);
  assert.equal(
    applyFilenameTemplate(FILENAME_TEMPLATES.DEFAULT, { stem: 'clip', pageUrl: 'https://www.x.com/user/status/1', now }),
    'clip'
  );
  assert.equal(
    applyFilenameTemplate(FILENAME_TEMPLATES.HOST_STEM, { stem: 'clip', pageUrl: 'https://www.x.com/user/status/1', now }),
    'x.com_clip'
  );
  assert.equal(
    applyFilenameTemplate(FILENAME_TEMPLATES.DATE_STEM, { stem: 'clip', pageUrl: 'https://x.com/user/status/1', now }),
    '2026-11-14_clip'
  );
  assert.equal(
    applyFilenameTemplate(FILENAME_TEMPLATES.HOST_FOLDER, { stem: 'clip', pageUrl: 'https://www.x.com/user/status/1', now }),
    'x.com/clip'
  );
  assert.equal(
    applyFilenameTemplate(FILENAME_TEMPLATES.DATE_FOLDER, { stem: 'clip', pageUrl: 'https://x.com/user/status/1', now }),
    '2026-11-14/clip'
  );
  assert.equal(isFolderFilenameTemplate(FILENAME_TEMPLATES.HOST_FOLDER), true);
  assert.equal(isFolderFilenameTemplate(FILENAME_TEMPLATES.DATE_FOLDER), true);
  assert.equal(isFolderFilenameTemplate(FILENAME_TEMPLATES.HOST_STEM), false);
});

test('loadSettings and saveSettings interact cleanly with chrome.storage.sync', async () => {
  const prevChrome = globalThis.chrome;
  const syncStore = {};

  globalThis.chrome = {
    storage: {
      sync: {
        async get(key) {
          return { [key]: syncStore[key] };
        },
        async set(obj) {
          Object.assign(syncStore, obj);
        }
      }
    }
  };

  try {
    const initial = await loadSettings();
    assert.deepEqual(initial, DEFAULT_SETTINGS);

    const saved = await saveSettings({
      defaultQuality: QUALITY_PREFERENCES.LOWEST,
      filenameTemplate: FILENAME_TEMPLATES.DATE_STEM,
      minImageDimensionPx: 120,
      hlsFetchConcurrency: 2,
      largeStreamWarningMb: 100,
      enableXOverlay: false,
      enableSocialOverlay: false,
      enableGenericVideoOverlay: false,
      enableMseCapture: false,
      enableCompanionCookies: true
    });
    assert.equal(saved.defaultQuality, QUALITY_PREFERENCES.LOWEST);
    assert.equal(saved.enableSocialOverlay, false);
    assert.equal(saved.enableGenericVideoOverlay, false);
    assert.equal(saved.enableMseCapture, false);
    assert.equal(saved.enableCompanionCookies, true);
    assert.equal(syncStore[STORAGE_KEYS.USER_SETTINGS].hlsFetchConcurrency, 2);

    const reloaded = await loadSettings();
    assert.deepEqual(reloaded, saved);
  } finally {
    globalThis.chrome = prevChrome;
  }
});
