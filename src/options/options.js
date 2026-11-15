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

import { DEFAULT_SETTINGS, LIMITS, MESSAGE_TYPES } from '../config/constants.js';
import { applyTranslations, getUiLanguage, t } from '../shared/i18n.js';
import { loadSettings, normalizeSettings, saveSettings } from '../shared/settings.js';

/**
 * Resolves DOM element references from an HTML document for the options page.
 * @param {Document} doc
 * @returns {object}
 */
export function collectOptionElements(doc) {
  return {
    form: doc.getElementById('optionsForm'),
    statusBanner: doc.getElementById('statusBanner'),
    defaultQuality: doc.getElementById('defaultQuality'),
    filenameTemplate: doc.getElementById('filenameTemplate'),
    minImageDimensionPx: doc.getElementById('minImageDimensionPx'),
    hlsFetchConcurrency: doc.getElementById('hlsFetchConcurrency'),
    largeStreamWarningMb: doc.getElementById('largeStreamWarningMb'),
    enableXOverlay: doc.getElementById('enableXOverlay'),
    enableSocialOverlay: doc.getElementById('enableSocialOverlay'),
    enableGenericVideoOverlay: doc.getElementById('enableGenericVideoOverlay'),
    enableMseCapture: doc.getElementById('enableMseCapture'),
    enableCompanionCookies: doc.getElementById('enableCompanionCookies'),
    promptSaveAs: doc.getElementById('promptSaveAs'),
    checkCompanionBtn: doc.getElementById('checkCompanionBtn'),
    companionStatus: doc.getElementById('companionStatus'),
    resetBtn: doc.getElementById('resetBtn'),
    resetConfirmBar: doc.getElementById('resetConfirmBar'),
    resetConfirmBtn: doc.getElementById('resetConfirmBtn'),
    resetCancelBtn: doc.getElementById('resetCancelBtn')
  };
}

/**
 * Synchronizes numeric input min/max constraints with LIMITS constants.
 * @param {object} els
 */
export function applyInputBounds(els) {
  if (els.minImageDimensionPx) {
    els.minImageDimensionPx.min = String(LIMITS.MIN_IMAGE_DIMENSION_MIN_PX);
    els.minImageDimensionPx.max = String(LIMITS.MIN_IMAGE_DIMENSION_MAX_PX);
  }
  if (els.hlsFetchConcurrency) {
    els.hlsFetchConcurrency.min = String(LIMITS.MIN_HLS_CONCURRENCY);
    els.hlsFetchConcurrency.max = String(LIMITS.MAX_HLS_CONCURRENCY);
  }
  if (els.largeStreamWarningMb) {
    els.largeStreamWarningMb.min = String(LIMITS.LARGE_STREAM_WARNING_MIN_MB);
    els.largeStreamWarningMb.max = String(LIMITS.LARGE_STREAM_WARNING_MAX_MB);
  }
}

/**
 * Builds the controller managing options form state, persistence, and status feedback.
 * @param {object} deps
 * @returns {object}
 */
export function createOptionsController(deps = {}) {
  const doc = deps.documentRef || document;
  const loadFn = deps.loadSettingsFn || loadSettings;
  const saveFn = deps.saveSettingsFn || saveSettings;
  const translateFn = deps.translateFn || t;
  const getLangFn = deps.getUiLanguageFn || getUiLanguage;
  const applyI18nFn = deps.applyTranslationsFn || applyTranslations;
  const els = collectOptionElements(doc);
  let statusTimer = null;

  /**
   * Displays temporary feedback in the status banner.
   * @param {string} message
   * @param {boolean} [isError=false]
   */
  function showStatus(message, isError = false) {
    els.statusBanner.textContent = message;
    els.statusBanner.classList.remove('hidden');
    els.statusBanner.classList.toggle('status-error', isError);
    clearTimeout(statusTimer);
    if (!isError) {
      statusTimer = setTimeout(() => {
        els.statusBanner.classList.add('hidden');
        els.statusBanner.classList.remove('status-error');
        els.statusBanner.textContent = '';
      }, LIMITS.COPY_FEEDBACK_MS * 2);
    }
  }

  /**
   * Hides the inline reset confirmation prompt.
   */
  function hideResetConfirm() {
    if (els.resetConfirmBar) {
      els.resetConfirmBar.classList.add('hidden');
    }
    if (els.resetBtn) {
      els.resetBtn.disabled = false;
    }
  }

  /**
   * Reveals inline confirmation before resetting saved preferences.
   */
  function requestReset() {
    if (!els.resetConfirmBar) {
      return handleReset();
    }
    els.resetConfirmBar.classList.remove('hidden');
    if (els.resetBtn) {
      els.resetBtn.disabled = true;
    }
    return Promise.resolve();
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
    if (els.enableSocialOverlay) {
      els.enableSocialOverlay.checked = Boolean(settings.enableSocialOverlay);
    }
    if (els.enableGenericVideoOverlay) {
      els.enableGenericVideoOverlay.checked = Boolean(settings.enableGenericVideoOverlay);
    }
    if (els.enableMseCapture) {
      els.enableMseCapture.checked = Boolean(settings.enableMseCapture);
    }
    if (els.enableCompanionCookies) {
      els.enableCompanionCookies.checked = Boolean(settings.enableCompanionCookies);
    }
    if (els.promptSaveAs) {
      els.promptSaveAs.checked = Boolean(settings.promptSaveAs);
    }
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
      enableXOverlay: els.enableXOverlay.checked,
      enableSocialOverlay: els.enableSocialOverlay ? els.enableSocialOverlay.checked : true,
      enableGenericVideoOverlay: els.enableGenericVideoOverlay ? els.enableGenericVideoOverlay.checked : true,
      enableMseCapture: els.enableMseCapture ? els.enableMseCapture.checked : true,
      enableCompanionCookies: Boolean(els.enableCompanionCookies && els.enableCompanionCookies.checked),
      promptSaveAs: Boolean(els.promptSaveAs && els.promptSaveAs.checked)
    });
  }

  const sendMessageFn = deps.sendMessageFn
    || ((msg) => (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.sendMessage === 'function'
      ? chrome.runtime.sendMessage(msg)
      : Promise.resolve({ available: false })));

  /**
   * Queries optional local companion availability and updates status indicator.
   * @returns {Promise<void>}
   */
  async function checkCompanion() {
    if (!els.companionStatus) {
      return;
    }
    try {
      const res = await sendMessageFn({ type: MESSAGE_TYPES.CHECK_COMPANION });
      const available = Boolean(res && res.ok && res.available);
      els.companionStatus.classList.toggle('is-connected', available);
      if (available) {
        const version = res.ytDlpVersion || 'ok';
        els.companionStatus.textContent = translateFn('options_companion_connected', [version]);
      } else {
        els.companionStatus.textContent = translateFn('options_companion_not_connected');
      }
    } catch {
      els.companionStatus.classList.remove('is-connected');
      els.companionStatus.textContent = translateFn('options_companion_not_connected');
    }
  }

  /**
   * Saves the current form values and shows confirmation or error feedback.
   */
  async function handleSubmit(event) {
    if (event && typeof event.preventDefault === 'function') {
      event.preventDefault();
    }
    hideResetConfirm();
    try {
      const saved = await saveFn(readFormValues());
      renderForm(saved);
      showStatus(translateFn('options_status_saved'));
    } catch {
      showStatus(translateFn('options_error_save_failed'), true);
    }
  }

  /**
   * Restores default settings and persists them.
   */
  async function handleReset() {
    hideResetConfirm();
    try {
      const restored = await saveFn(DEFAULT_SETTINGS);
      renderForm(restored);
      showStatus(translateFn('options_status_reset'));
    } catch {
      showStatus(translateFn('options_error_save_failed'), true);
    }
  }

  /**
   * Initializes translations, numeric bounds, event bindings, and initial settings load.
   * @returns {Promise<void>}
   */
  async function init() {
    doc.documentElement.lang = getLangFn();
    applyI18nFn(doc);
    applyInputBounds(els);
    els.form.addEventListener('submit', handleSubmit);
    els.resetBtn.addEventListener('click', requestReset);
    if (els.resetConfirmBtn) {
      els.resetConfirmBtn.addEventListener('click', handleReset);
    }
    if (els.resetCancelBtn) {
      els.resetCancelBtn.addEventListener('click', hideResetConfirm);
    }
    if (els.checkCompanionBtn) {
      els.checkCompanionBtn.addEventListener('click', checkCompanion);
    }
    try {
      const loaded = await loadFn();
      renderForm(loaded);
    } catch {
      renderForm(DEFAULT_SETTINGS);
      showStatus(translateFn('options_error_save_failed'), true);
    }
    await checkCompanion();
  }

  return {
    els,
    showStatus,
    renderForm,
    readFormValues,
    requestReset,
    hideResetConfirm,
    handleSubmit,
    handleReset,
    checkCompanion,
    init
  };
}

if (typeof document !== 'undefined') {
  createOptionsController().init();
}
