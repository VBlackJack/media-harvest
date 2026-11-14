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
import { applyTranslations, getUiLanguage, t } from '../src/shared/i18n.js';

test('t and getUiLanguage fall back cleanly when chrome.i18n is absent', () => {
  const prevChrome = globalThis.chrome;
  delete globalThis.chrome;
  try {
    assert.equal(t('popup_action_download'), 'popup_action_download');
    assert.equal(getUiLanguage(), 'en');
  } finally {
    globalThis.chrome = prevChrome;
  }
});

test('t, getUiLanguage, and applyTranslations hydrate nodes from chrome.i18n', () => {
  const prevChrome = globalThis.chrome;
  globalThis.chrome = {
    i18n: {
      getUILanguage: () => 'fr',
      getMessage: (key) => ({ title_key: 'Titre', tip_key: 'Infobulle' }[key] || '')
    }
  };

  try {
    assert.equal(getUiLanguage(), 'fr');
    assert.equal(t('title_key'), 'Titre');
    assert.equal(t('missing_key'), 'missing_key');

    const textNode = {
      attributes: new Map([['data-i18n', 'title_key']]),
      textContent: '',
      getAttribute(name) {
        return this.attributes.get(name) || null;
      }
    };
    const titleNode = {
      attributes: new Map([['data-i18n-title', 'tip_key']]),
      getAttribute(name) {
        return this.attributes.get(name) || null;
      },
      setAttribute(name, value) {
        this.attributes.set(name, value);
      }
    };

    const fakeRoot = {
      querySelectorAll(selector) {
        if (selector === '[data-i18n]') {
          return [textNode];
        }
        if (selector === '[data-i18n-title]') {
          return [titleNode];
        }
        return [];
      }
    };

    applyTranslations(fakeRoot);
    assert.equal(textNode.textContent, 'Titre');
    assert.equal(titleNode.attributes.get('title'), 'Infobulle');
    assert.equal(titleNode.attributes.get('aria-label'), 'Infobulle');
  } finally {
    globalThis.chrome = prevChrome;
  }
});
