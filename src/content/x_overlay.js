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
  const OVERLAY_CONFIG = Object.freeze({
    TWEET_SELECTOR: 'article[data-testid="tweet"]',
    VIDEO_SELECTOR: 'video',
    ACTION_GROUP_SELECTOR: '[role="group"]',
    STATUS_LINK_SELECTOR: 'a[href*="/status/"]',
    BUTTON_ATTR: 'data-media-harvest-attached',
    ACTIVE_REQ_ATTR: 'data-mh-request-id',
    BUTTON_CLASS: 'mh-x-download-btn',
    QUALITY_WRAP_CLASS: 'mh-x-quality-wrap',
    QUALITY_MENU_CLASS: 'mh-x-quality-menu',
    SETTINGS_KEY: 'user_settings',
    MEDIA_ID_PATTERN: /(?:ext_tw_video|amplify_video|tweet_video)(?:_thumb)?\/(\d+)\//i,
    STATUS_PATH_PATTERN: /\/([A-Za-z0-9_]+)\/status\/(\d+)/,
    MESSAGE_TYPE: 'DOWNLOAD_TWEET_VIDEO',
    CANCEL_MESSAGE_TYPE: 'CANCEL_DOWNLOAD',
    PROGRESS_MESSAGE_TYPE: 'DOWNLOAD_PROGRESS',
    DEBOUNCE_MS: 300,
    RESET_DELAY_MS: 3000
  });

  const X_ERROR_KEY_MAP = Object.freeze({
    PLAY_FIRST: 'x_btn_play_first',
    ENCRYPTED_STREAM: 'x_btn_encrypted',
    STREAM_TOO_LARGE: 'x_btn_too_large',
    FETCH_TIMEOUT: 'x_btn_timeout',
    DOWNLOAD_CANCELLED: 'x_btn_cancelled'
  });

  const OVERLAY_COMMON = typeof globalThis !== 'undefined' && globalThis.__mediaHarvestOverlayCommon
    ? globalThis.__mediaHarvestOverlayCommon
    : null;
  const msg = OVERLAY_COMMON ? OVERLAY_COMMON.msg : ((key, substitutions) => chrome.i18n.getMessage(key, substitutions) || key);

  /**
   * Creates the inline SVG download icon element.
   * @returns {SVGSVGElement}
   */
  function createDownloadIcon() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '13');
    svg.setAttribute('height', '13');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2.2');

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4');
    const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    poly.setAttribute('points', '7 10 12 15 17 10');
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', '12');
    line.setAttribute('y1', '15');
    line.setAttribute('x2', '12');
    line.setAttribute('y2', '3');

    svg.append(path, poly, line);
    return svg;
  }

  /**
   * Creates a compact downward chevron SVG icon for the quality menu toggle.
   * @returns {SVGSVGElement}
   */
  function createChevronIcon() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '11');
    svg.setAttribute('height', '11');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2.5');
    const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    poly.setAttribute('points', '6 9 12 15 18 9');
    svg.appendChild(poly);
    return svg;
  }

  /**
   * Finds the first element matching selector whose nearest tweet article is the given article,
   * avoiding elements nested inside quoted tweets.
   * @param {Element} article
   * @param {string} selector
   * @returns {Element | null}
   */
  function findDirectTweetElement(article, selector) {
    for (const candidate of article.querySelectorAll(selector)) {
      if (candidate.closest(OVERLAY_CONFIG.TWEET_SELECTOR) === article) {
        return candidate;
      }
    }
    return null;
  }

  /**
   * Extracts tweet author, status ID, and video media ID from a tweet article element.
   * @param {Element} article
   * @param {HTMLVideoElement | null} video
   * @returns {{ mediaId: string, posterUrl: string, directSrc: string, authorHandle: string, tweetId: string }}
   */
  function extractTweetMetadata(article, video) {
    const posterUrl = video ? (video.getAttribute('poster') || '') : '';
    const directSrc = video ? (video.currentSrc || video.getAttribute('src') || '') : '';
    const mediaMatch = posterUrl.match(OVERLAY_CONFIG.MEDIA_ID_PATTERN)
      || directSrc.match(OVERLAY_CONFIG.MEDIA_ID_PATTERN);

    let authorHandle = '';
    let tweetId = '';
    for (const anchor of article.querySelectorAll(OVERLAY_CONFIG.STATUS_LINK_SELECTOR)) {
      if (anchor.closest(OVERLAY_CONFIG.TWEET_SELECTOR) !== article) {
        continue;
      }
      const href = anchor.getAttribute('href') || '';
      const match = href.match(OVERLAY_CONFIG.STATUS_PATH_PATTERN);
      if (match) {
        authorHandle = match[1];
        tweetId = match[2];
        break;
      }
    }

    return {
      mediaId: mediaMatch ? mediaMatch[1] : '',
      posterUrl,
      directSrc: directSrc.startsWith('http') ? directSrc : '',
      authorHandle,
      tweetId
    };
  }

  const resetTimers = new WeakMap();
  const activeButtonsByRequestId = new Map();

  /**
   * Updates the button text and schedules automatic restoration to idle state.
   * @param {HTMLButtonElement} btn
   * @param {HTMLSpanElement} labelEl
   * @param {string} labelText
   * @param {boolean} isError
   * @param {string} [tooltipText='']
   */
  function flashButtonState(btn, labelEl, labelText, isError, tooltipText = '') {
    const existingTimer = resetTimers.get(btn);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }
    labelEl.textContent = labelText;
    btn.title = tooltipText;
    btn.classList.toggle('mh-is-error', isError);
    const timerId = setTimeout(() => {
      resetTimers.delete(btn);
      labelEl.textContent = msg('x_btn_download');
      btn.title = '';
      btn.classList.remove('mh-is-error');
    }, OVERLAY_CONFIG.RESET_DELAY_MS);
    resetTimers.set(btn, timerId);
  }

  /**
   * Formats an inline error label and tooltip from a service worker error code.
   * @param {string} errorCode
   * @returns {{ label: string, isError: boolean, tooltip: string }}
   */
  function formatOverlayError(errorCode) {
    const key = X_ERROR_KEY_MAP[errorCode] || 'x_btn_error';
    const label = msg(key);
    const isError = errorCode !== 'DOWNLOAD_CANCELLED';
    const tooltip = key === 'x_btn_error' && errorCode ? `${label}: ${errorCode}` : label;
    return { label, isError, tooltip };
  }

  let isEnabled = true;

  /**
   * Injects a download pill button into any tweet article containing a direct video.
   */
  function attachButtons() {
    if (!isEnabled) {
      return;
    }
    for (const article of document.querySelectorAll(OVERLAY_CONFIG.TWEET_SELECTOR)) {
      const video = findDirectTweetElement(article, OVERLAY_CONFIG.VIDEO_SELECTOR);
      if (!video) {
        continue;
      }
      const actionBar = findDirectTweetElement(article, OVERLAY_CONFIG.ACTION_GROUP_SELECTOR);
      if (!actionBar || actionBar.hasAttribute(OVERLAY_CONFIG.BUTTON_ATTR)) {
        continue;
      }
      actionBar.setAttribute(OVERLAY_CONFIG.BUTTON_ATTR, 'true');

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = OVERLAY_CONFIG.BUTTON_CLASS;
      const labelEl = document.createElement('span');
      labelEl.textContent = msg('x_btn_download');
      btn.append(createDownloadIcon(), labelEl);

      const triggerDownload = async (options = {}) => {
        const activeReqId = btn.getAttribute(OVERLAY_CONFIG.ACTIVE_REQ_ATTR);
        if (activeReqId) {
          btn.disabled = true;
          try {
            const cancelReq = chrome.runtime.sendMessage({
              type: OVERLAY_CONFIG.CANCEL_MESSAGE_TYPE,
              requestId: activeReqId
            });
            if (cancelReq && typeof cancelReq.catch === 'function') {
              cancelReq.catch(() => {});
            }
          } catch {
            // Ignore invalidated extension context
          }
          return;
        }

        const requestId = `x_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        btn.setAttribute(OVERLAY_CONFIG.ACTIVE_REQ_ATTR, requestId);
        activeButtonsByRequestId.set(requestId, { btn, labelEl });
        btn.disabled = true;
        btn.title = '';
        btn.classList.remove('mh-is-error', 'mh-is-cancelable');
        labelEl.textContent = msg('x_btn_downloading');

        try {
          const currentVideo = findDirectTweetElement(article, OVERLAY_CONFIG.VIDEO_SELECTOR);
          const payload = extractTweetMetadata(article, currentVideo);
          payload.requestId = requestId;
          if (typeof options.qualityPreference === 'string' && options.qualityPreference) {
            payload.qualityPreference = options.qualityPreference;
          }
          if (options.audioOnly) {
            payload.audioOnly = true;
          }
          const response = await chrome.runtime.sendMessage({
            type: OVERLAY_CONFIG.MESSAGE_TYPE,
            payload
          });

          if (!response || !response.ok) {
            const errInfo = formatOverlayError(response && response.error ? response.error : '');
            flashButtonState(btn, labelEl, errInfo.label, errInfo.isError, errInfo.tooltip);
            return;
          }
          flashButtonState(btn, labelEl, msg('x_btn_done'), false);
        } catch (err) {
          const errInfo = formatOverlayError(err && err.message ? err.message : '');
          flashButtonState(btn, labelEl, errInfo.label, errInfo.isError, errInfo.tooltip);
        } finally {
          activeButtonsByRequestId.delete(requestId);
          btn.removeAttribute(OVERLAY_CONFIG.ACTIVE_REQ_ATTR);
          btn.classList.remove('mh-is-cancelable');
          btn.disabled = false;
        }
      };

      btn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        return triggerDownload();
      });

      const qualityWrap = document.createElement('div');
      qualityWrap.className = OVERLAY_CONFIG.QUALITY_WRAP_CLASS;

      const toggleBtn = document.createElement('button');
      toggleBtn.type = 'button';
      toggleBtn.className = 'mh-x-quality-toggle';
      toggleBtn.setAttribute('aria-label', msg('overlay_quality_menu_aria'));
      toggleBtn.setAttribute('aria-expanded', 'false');
      toggleBtn.appendChild(createChevronIcon());

      const menu = document.createElement('div');
      menu.className = OVERLAY_CONFIG.QUALITY_MENU_CLASS;
      menu.setAttribute('role', 'menu');

      const presets = [
        { key: 'overlay_quality_best', qualityPreference: 'highest', audioOnly: false },
        { key: 'overlay_quality_lowest', qualityPreference: 'lowest', audioOnly: false },
        { key: 'overlay_quality_audio', qualityPreference: '', audioOnly: true }
      ];
      for (const preset of presets) {
        const optionBtn = document.createElement('button');
        optionBtn.type = 'button';
        optionBtn.className = 'mh-x-quality-option';
        optionBtn.setAttribute('role', 'menuitem');
        optionBtn.setAttribute('data-quality', preset.qualityPreference);
        optionBtn.setAttribute('data-audio-only', String(preset.audioOnly));
        optionBtn.textContent = msg(preset.key);
        optionBtn.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          qualityWrap.classList.remove('mh-is-open');
          toggleBtn.setAttribute('aria-expanded', 'false');
          return triggerDownload({
            qualityPreference: preset.qualityPreference,
            audioOnly: preset.audioOnly
          });
        });
        menu.appendChild(optionBtn);
      }

      if (OVERLAY_COMMON && typeof OVERLAY_COMMON.bindQualityMenu === 'function') {
        OVERLAY_COMMON.bindQualityMenu({
          qualityWrap,
          toggleBtn,
          menu,
          openClass: 'mh-is-open'
        });
      } else {
        toggleBtn.setAttribute('aria-haspopup', 'menu');
        toggleBtn.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          const isOpen = qualityWrap.classList.toggle('mh-is-open');
          toggleBtn.setAttribute('aria-expanded', String(isOpen));
        });
      }

      qualityWrap.append(toggleBtn, menu);
      actionBar.append(btn, qualityWrap);
    }
  }

  let debounceTimer = null;
  const observer = new MutationObserver(() => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(attachButtons, OVERLAY_CONFIG.DEBOUNCE_MS);
  });

  /**
   * Starts DOM observation and attaches inline download buttons.
   */
  function enableOverlay() {
    isEnabled = true;
    if (document.body) {
      observer.observe(document.body, { childList: true, subtree: true });
      attachButtons();
    }
  }

  /**
   * Stops DOM observation and cleans up all injected download buttons.
   */
  function disableOverlay() {
    isEnabled = false;
    clearTimeout(debounceTimer);
    debounceTimer = null;
    observer.disconnect();
    for (const btn of document.querySelectorAll(`.${OVERLAY_CONFIG.BUTTON_CLASS}`)) {
      btn.remove();
    }
    for (const wrap of document.querySelectorAll(`.${OVERLAY_CONFIG.QUALITY_WRAP_CLASS}`)) {
      wrap.remove();
    }
    for (const host of document.querySelectorAll(`[${OVERLAY_CONFIG.BUTTON_ATTR}]`)) {
      host.removeAttribute(OVERLAY_CONFIG.BUTTON_ATTR);
    }
  }

  let settingsResolvedFromChange = false;

  /**
   * Reads user settings and activates the overlay if enabled.
   */
  async function initOverlay() {
    try {
      if (chrome && chrome.storage && chrome.storage.sync) {
        const stored = await chrome.storage.sync.get(OVERLAY_CONFIG.SETTINGS_KEY);
        if (settingsResolvedFromChange) {
          return;
        }
        const settings = stored && stored[OVERLAY_CONFIG.SETTINGS_KEY];
        const currentHost = typeof window !== 'undefined' && window.location ? window.location.hostname : '';
        const hostExcluded = Boolean(
          OVERLAY_COMMON &&
          typeof OVERLAY_COMMON.isHostDisabledInSettings === 'function' &&
          OVERLAY_COMMON.isHostDisabledInSettings(currentHost, settings)
        );
        if ((settings && settings.enableXOverlay === false) || hostExcluded) {
          disableOverlay();
          return;
        }
      }
    } catch {
      // Fall back to enabled default when storage is unavailable
    }
    if (!settingsResolvedFromChange) {
      enableOverlay();
    }
  }

  if (chrome && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'sync' || !changes[OVERLAY_CONFIG.SETTINGS_KEY]) {
        return;
      }
      settingsResolvedFromChange = true;
      const nextSettings = changes[OVERLAY_CONFIG.SETTINGS_KEY].newValue;
      if (nextSettings && nextSettings.enableXOverlay === false) {
        disableOverlay();
      } else {
        enableOverlay();
      }
    });
  }

  if (chrome && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((message) => {
      if (!message || message.type !== OVERLAY_CONFIG.PROGRESS_MESSAGE_TYPE || !message.requestId) {
        return false;
      }
      const target = activeButtonsByRequestId.get(message.requestId);
      if (!target) {
        return false;
      }
      const { btn, labelEl } = target;
      btn.disabled = false;
      btn.classList.add('mh-is-cancelable');
      if (message.total > 0 && message.done >= message.total) {
        labelEl.textContent = msg('x_btn_muxing');
      } else if (message.total > 0) {
        labelEl.textContent = msg('x_btn_progress', [String(message.done), String(message.total)]);
      } else {
        labelEl.textContent = msg('x_btn_downloading');
      }
      return false;
    });
  }

  initOverlay();
})();
