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

(() => {
  if (typeof globalThis === 'undefined' || globalThis.__mediaHarvestOverlayCommon) {
    return;
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const openMenus = new Set();
  let globalDismissBound = false;

  /**
   * Translates an extension i18n message key safely in content script contexts.
   * @param {string} key
   * @param {string[]} [subs]
   * @returns {string}
   */
  function msg(key, subs) {
    try {
      if (typeof chrome !== 'undefined' && chrome.i18n && typeof chrome.i18n.getMessage === 'function') {
        const val = chrome.i18n.getMessage(key, subs);
        if (val) {
          return val;
        }
      }
    } catch {
      // Ignore invalidated extension context errors
    }
    return key;
  }

  /**
   * Maps internal error codes to localized overlay button labels consistently across overlays.
   * @param {string} errorCode
   * @param {(key: string, subs?: string[]) => string} [translateFn=msg]
   * @returns {string}
   */
  function formatOverlayError(errorCode, translateFn = msg) {
    switch (errorCode) {
      case 'PLAY_FIRST':
        return translateFn('x_btn_play_first');
      case 'ENCRYPTED_STREAM':
      case 'DRM_PROTECTED':
        return translateFn('x_btn_encrypted');
      case 'STREAM_TOO_LARGE':
        return translateFn('x_btn_too_large');
      case 'FETCH_TIMEOUT':
        return translateFn('x_btn_timeout');
      case 'DOWNLOAD_CANCELLED':
        return translateFn('x_btn_cancelled');
      case 'NO_AUDIO_TRACK':
        return translateFn('popup_error_no_audio_track');
      default:
        return translateFn('x_btn_error');
    }
  }

  /**
   * Creates a standard inline download SVG icon.
   * @param {number} [size=16]
   * @returns {SVGElement}
   */
  function createDownloadIcon(size = 16) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute(
      'd',
      'M12 3a1 1 0 0 1 1 1v9.59l2.3-2.3a1 1 0 1 1 1.4 1.42l-4 4a1 1 0 0 1-1.4 0l-4-4a1 1 0 1 1 1.4-1.42l2.3 2.3V4a1 1 0 0 1 1-1zm-7 15a1 1 0 0 1 1 1v1h12v-1a1 1 0 1 1 2 0v2a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-2a1 1 0 0 1 1-1z'
    );
    path.setAttribute('fill', 'currentColor');
    svg.appendChild(path);
    return svg;
  }

  /**
   * Creates a compact downward chevron SVG icon for overlay quality menus.
   * @param {number} [size=12]
   * @returns {SVGElement}
   */
  function createChevronIcon(size = 12) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', 'M7 10l5 5 5-5z');
    path.setAttribute('fill', 'currentColor');
    svg.appendChild(path);
    return svg;
  }

  function closeMenuEntry(entry, restoreFocus = false) {
    if (!entry) {
      return;
    }
    entry.qualityWrap.classList.remove(entry.openClass);
    entry.toggleBtn.setAttribute('aria-expanded', 'false');
    openMenus.delete(entry);
    if (restoreFocus && typeof entry.toggleBtn.focus === 'function') {
      entry.toggleBtn.focus();
    }
  }

  function closeAllMenus(exceptEntry = null, restoreFocus = false) {
    for (const entry of Array.from(openMenus)) {
      if (entry !== exceptEntry) {
        closeMenuEntry(entry, restoreFocus);
      }
    }
  }

  function ensureGlobalMenuDismissal() {
    if (globalDismissBound || typeof document === 'undefined' || typeof document.addEventListener !== 'function') {
      return;
    }
    globalDismissBound = true;
    document.addEventListener('click', (event) => {
      if (openMenus.size === 0) {
        return;
      }
      const target = event && event.target;
      for (const entry of Array.from(openMenus)) {
        if (!target || typeof entry.qualityWrap.contains !== 'function' || !entry.qualityWrap.contains(target)) {
          closeMenuEntry(entry, false);
        }
      }
    });
    document.addEventListener('keydown', (event) => {
      if (!event || event.key !== 'Escape' || openMenus.size === 0) {
        return;
      }
      closeAllMenus(null, true);
    });
  }

  /**
   * Attaches accessible toggle, outside-click dismissal, Escape, and Arrow-key navigation
   * to an overlay quality/audio menu.
   * @param {{ qualityWrap: HTMLElement, toggleBtn: HTMLButtonElement, menu: HTMLElement, openClass?: string }} params
   * @returns {{ close: (restoreFocus?: boolean) => void }}
   */
  function bindQualityMenu({ qualityWrap, toggleBtn, menu, openClass = 'mh-is-open' }) {
    ensureGlobalMenuDismissal();
    toggleBtn.setAttribute('aria-haspopup', 'menu');
    toggleBtn.setAttribute('aria-expanded', 'false');

    const entry = { qualityWrap, toggleBtn, menu, openClass };

    const getMenuItems = () => {
      if (typeof menu.querySelectorAll === 'function') {
        return Array.from(menu.querySelectorAll('[role="menuitem"]'));
      }
      return Array.isArray(menu.children) ? menu.children : [];
    };

    toggleBtn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const willOpen = !qualityWrap.classList.contains(openClass);
      closeAllMenus(entry, false);
      const isOpen = qualityWrap.classList.toggle(openClass);
      toggleBtn.setAttribute('aria-expanded', String(isOpen));
      if (isOpen && willOpen) {
        openMenus.add(entry);
      } else {
        openMenus.delete(entry);
      }
    });

    if (typeof menu.addEventListener === 'function') {
      menu.addEventListener('keydown', (event) => {
        if (!event) {
          return;
        }
        const items = getMenuItems();
        if (items.length === 0) {
          return;
        }
        const currentIdx = items.indexOf(document.activeElement);
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          const next = items[(currentIdx + 1) % items.length];
          if (next && typeof next.focus === 'function') next.focus();
        } else if (event.key === 'ArrowUp') {
          event.preventDefault();
          const prev = items[(currentIdx - 1 + items.length) % items.length];
          if (prev && typeof prev.focus === 'function') prev.focus();
        } else if (event.key === 'Home') {
          event.preventDefault();
          if (items[0] && typeof items[0].focus === 'function') items[0].focus();
        } else if (event.key === 'End') {
          event.preventDefault();
          const last = items[items.length - 1];
          if (last && typeof last.focus === 'function') last.focus();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          closeMenuEntry(entry, true);
        }
      });
    }

    return {
      close: (restoreFocus = false) => closeMenuEntry(entry, restoreFocus)
    };
  }

  /**
   * Checks whether a page hostname is listed in user_settings.disabledOverlayHosts.
   * Matches exact hostname or subdomains (e.g. "youtube.com" matches "www.youtube.com").
   * @param {string} hostname
   * @param {object | null | undefined} settings
   * @returns {boolean}
   */
  function isHostDisabledInSettings(hostname, settings) {
    const list = settings && Array.isArray(settings.disabledOverlayHosts) ? settings.disabledOverlayHosts : [];
    if (list.length === 0 || typeof hostname !== 'string' || !hostname) {
      return false;
    }
    const cleanHost = hostname.trim().toLowerCase().replace(/^www\./, '');
    for (const rawRule of list) {
      if (typeof rawRule !== 'string') {
        continue;
      }
      const rule = rawRule.trim().toLowerCase().replace(/^www\./, '');
      if (rule && (cleanHost === rule || cleanHost.endsWith(`.${rule}`))) {
        return true;
      }
    }
    return false;
  }

  globalThis.__mediaHarvestOverlayCommon = Object.freeze({
    msg,
    formatOverlayError,
    createDownloadIcon,
    createChevronIcon,
    bindQualityMenu,
    closeAllMenus,
    isHostDisabledInSettings
  });
})();
