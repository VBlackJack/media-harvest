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

import { DEFAULT_SETTINGS, LIMITS } from '../config/constants.js';
import { applyTranslations, getUiLanguage, t } from '../shared/i18n.js';
import { loadSettings, normalizeSettings, saveSettings } from '../shared/settings.js';

const els = {
  form: document.getElementById('optionsForm'),
  statusBanner: document.getElementById('statusBanner'),
  defaultQuality: document.getElementById('defaultQuality'),
  filenameTemplate: document.getElementById('filenameTemplate'),
  minImageDimensionPx: document.getElementById('minImageDimensionPx'),
  hlsFetchConcurrency: document.getElementById('hlsFetchConcurrency'),
  largeStreamWarningMb: document.getElementById('largeStreamWarningMb'),
  enableXOverlay: document.getElementById('enableXOverlay'),
  resetBtn: document.getElementById('resetBtn')
};

let statusTimer = null;

/**
 * Displays temporary feedback in the status banner.
 * @param {string} message
 */
function showStatus(message) {
  els.statusBanner.textContent = message;
  els.statusBanner.classList.remove('hidden');
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    els.statusBanner.classList.add('hidden');
    els.statusBanner.textContent = '';
  }, LIMITS.COPY_FEEDBACK_MS * 2);
}

/**
 * Populates form controls from a normalized settings object.
 * @param {object} settings
 */
function renderForm(settings) {
  els.defaultQuality.value = settings.defaultQuality;
  els.filenameTemplate.value = settings.filenameTemplate;
  els.minImageDimensionPx.value = String(settings.minImageDimensionPx);
  els.hlsFetchConcurrency.value = String(settings.hlsFetchConcurrency);
  els.largeStreamWarningMb.value = String(settings.largeStreamWarningMb);
  els.enableXOverlay.checked = Boolean(settings.enableXOverlay);
}

/**
 * Reads and normalizes form values into a settings object.
 * @returns {object}
 */
function readFormValues() {
  return normalizeSettings({
    defaultQuality: els.defaultQuality.value,
    filenameTemplate: els.filenameTemplate.value,
    minImageDimensionPx: els.minImageDimensionPx.value,
    hlsFetchConcurrency: els.hlsFetchConcurrency.value,
    largeStreamWarningMb: els.largeStreamWarningMb.value,
    enableXOverlay: els.enableXOverlay.checked
  });
}

els.form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const saved = await saveSettings(readFormValues());
  renderForm(saved);
  showStatus(t('options_status_saved'));
});

els.resetBtn.addEventListener('click', async () => {
  const restored = await saveSettings(DEFAULT_SETTINGS);
  renderForm(restored);
  showStatus(t('options_status_reset'));
});

document.documentElement.lang = getUiLanguage();
applyTranslations(document);
loadSettings().then(renderForm);
