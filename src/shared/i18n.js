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

/**
 * Resolves a localized message using Chrome's i18n API with a safe key fallback.
 * @param {string} key
 * @param {string | Array<string>} [substitutions]
 * @returns {string}
 */
export function t(key, substitutions) {
  if (typeof chrome !== 'undefined' && chrome.i18n && typeof chrome.i18n.getMessage === 'function') {
    const translated = chrome.i18n.getMessage(key, substitutions);
    if (translated) {
      return translated;
    }
  }
  return key;
}

/**
 * Returns the active browser UI language code (e.g. 'fr' or 'en').
 * @returns {string}
 */
export function getUiLanguage() {
  if (typeof chrome !== 'undefined' && chrome.i18n && typeof chrome.i18n.getUILanguage === 'function') {
    return chrome.i18n.getUILanguage() || 'en';
  }
  return 'en';
}

/**
 * Hydrates all DOM nodes marked with data-i18n or data-i18n-title.
 * @param {ParentNode} root
 */
export function applyTranslations(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) {
    const key = el.getAttribute('data-i18n');
    if (key) {
      el.textContent = t(key);
    }
  }

  for (const el of root.querySelectorAll('[data-i18n-title]')) {
    const key = el.getAttribute('data-i18n-title');
    if (key) {
      const value = t(key);
      el.setAttribute('title', value);
      el.setAttribute('aria-label', value);
    }
  }
}
