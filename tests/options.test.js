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
import { DEFAULT_SETTINGS, LIMITS } from '../src/config/constants.js';
import { createOptionsController } from '../src/options/options.js';

function createFakeElement(initial = {}) {
  const classes = new Set(initial.classes || []);
  const listeners = new Map();
  return {
    value: initial.value || '',
    checked: Boolean(initial.checked),
    disabled: false,
    textContent: '',
    min: '',
    max: '',
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      toggle: (c, force) => (force ? classes.add(c) : classes.delete(c)),
      contains: (c) => classes.has(c)
    },
    addEventListener: (event, fn) => listeners.set(event, fn),
    dispatchEvent: async (ev) => {
      const fn = listeners.get(ev.type);
      if (fn) {
        await fn(ev);
      }
    },
    listeners
  };
}

function createFakeDocument() {
  const elements = new Map([
    ['optionsForm', createFakeElement()],
    ['statusBanner', createFakeElement({ classes: ['hidden'] })],
    ['defaultQuality', createFakeElement({ value: 'best' })],
    ['filenameTemplate', createFakeElement({ value: 'default' })],
    ['minImageDimensionPx', createFakeElement({ value: '80' })],
    ['hlsFetchConcurrency', createFakeElement({ value: '4' })],
    ['largeStreamWarningMb', createFakeElement({ value: '250' })],
    ['enableXOverlay', createFakeElement({ checked: true })],
    ['enableSocialOverlay', createFakeElement({ checked: true })],
    ['enableGenericVideoOverlay', createFakeElement({ checked: true })],
    ['enableMseCapture', createFakeElement({ checked: true })],
    ['enableCompanionCookies', createFakeElement({ checked: false })],
    ['promptSaveAs', createFakeElement({ checked: false })],
    ['checkCompanionBtn', createFakeElement()],
    ['companionStatus', createFakeElement()],
    ['resetBtn', createFakeElement()],
    ['resetConfirmBar', createFakeElement({ classes: ['hidden'] })],
    ['resetConfirmBtn', createFakeElement()],
    ['resetCancelBtn', createFakeElement()]
  ]);
  return {
    documentElement: { lang: '' },
    getElementById: (id) => elements.get(id)
  };
}

test('options controller syncs LIMITS bounds, confirms resets, keeps errors visible, and saves settings', async () => {
  const doc = createFakeDocument();
  let stored = { ...DEFAULT_SETTINGS, largeStreamWarningMb: 400 };
  let failSave = false;

  const controller = createOptionsController({
    documentRef: doc,
    loadSettingsFn: async () => stored,
    saveSettingsFn: async (next) => {
      if (failSave) {
        throw new Error('STORAGE_ERROR');
      }
      stored = next;
      return next;
    },
    translateFn: (key) => key,
    getUiLanguageFn: () => 'fr',
    applyTranslationsFn: () => {},
    sendMessageFn: async () => ({ ok: true, available: true, ytDlpVersion: '2026.01.01' })
  });

  await controller.init();
  assert.equal(doc.documentElement.lang, 'fr');
  assert.equal(controller.els.companionStatus.textContent, 'options_companion_connected');
  assert.equal(controller.els.companionStatus.classList.contains('is-connected'), true);
  assert.equal(controller.els.largeStreamWarningMb.max, String(LIMITS.LARGE_STREAM_WARNING_MAX_MB));
  assert.equal(controller.els.largeStreamWarningMb.value, '400');

  controller.els.hlsFetchConcurrency.value = '99';
  controller.els.largeStreamWarningMb.value = '2048';
  await controller.handleSubmit({ preventDefault: () => {} });
  assert.equal(stored.hlsFetchConcurrency, LIMITS.MAX_HLS_CONCURRENCY);
  assert.equal(stored.largeStreamWarningMb, LIMITS.LARGE_STREAM_WARNING_MAX_MB);
  assert.equal(controller.els.statusBanner.textContent, 'options_status_saved');
  assert.equal(controller.els.statusBanner.classList.contains('status-error'), false);

  // Reset requires inline confirmation before overwriting saved settings
  await controller.els.resetBtn.dispatchEvent({ type: 'click' });
  assert.equal(controller.els.resetConfirmBar.classList.contains('hidden'), false);
  assert.equal(stored.hlsFetchConcurrency, LIMITS.MAX_HLS_CONCURRENCY);

  await controller.els.resetCancelBtn.dispatchEvent({ type: 'click' });
  assert.equal(controller.els.resetConfirmBar.classList.contains('hidden'), true);
  assert.equal(stored.hlsFetchConcurrency, LIMITS.MAX_HLS_CONCURRENCY);

  await controller.els.resetBtn.dispatchEvent({ type: 'click' });
  await controller.els.resetConfirmBtn.dispatchEvent({ type: 'click' });
  assert.deepEqual(stored, DEFAULT_SETTINGS);
  assert.equal(controller.els.resetConfirmBar.classList.contains('hidden'), true);
  assert.equal(controller.els.statusBanner.textContent, 'options_status_reset');

  failSave = true;
  await controller.handleSubmit({ preventDefault: () => {} });
  assert.equal(controller.els.statusBanner.textContent, 'options_error_save_failed');
  assert.equal(controller.els.statusBanner.classList.contains('status-error'), true);
});
