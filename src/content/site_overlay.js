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
  const SITE_OVERLAY_CONFIG = Object.freeze({
    STORAGE_SETTINGS_KEY: 'user_settings',
    SOCIAL_SETTING_KEY: 'enableSocialOverlay',
    GENERIC_SETTING_KEY: 'enableGenericVideoOverlay',
    MESSAGE_TYPE: 'DOWNLOAD_SITE_VIDEO',
    CANCEL_MESSAGE_TYPE: 'CANCEL_DOWNLOAD',
    PROGRESS_MESSAGE_TYPE: 'DOWNLOAD_PROGRESS',
    HOST_CLASS: 'mh-site-overlay-host',
    BUTTON_CLASS: 'mh-site-download-btn',
    QUALITY_WRAP_CLASS: 'mh-site-quality-wrap',
    QUALITY_MENU_CLASS: 'mh-site-quality-menu',
    BUTTON_ATTR: 'data-mh-site-attached',
    ACTIVE_REQ_ATTR: 'data-mh-site-request-id',
    MIN_VIDEO_WIDTH_PX: 160,
    MIN_VIDEO_HEIGHT_PX: 90,
    GENERIC_MIN_VIDEO_WIDTH_PX: 220,
    GENERIC_MIN_VIDEO_HEIGHT_PX: 140,
    DEBOUNCE_MS: 300,
    RESET_DELAY_MS: 2500
  });

  const X_EXCLUDED_HOSTS = new Set(['x.com', 'twitter.com']);

  const GENERIC_ADAPTER = Object.freeze({
    id: 'generic',
    isGeneric: true,
    hosts: [],
    containerSelectors: ['video-js', '.plyr', '.jwplayer', '.shaka-video-container', 'figure'],
    titleSelectors: ['h1', 'h2']
  });

  const SITE_ADAPTERS = Object.freeze([
    {
      id: 'instagram',
      hosts: ['instagram.com'],
      containerSelectors: ['article', 'div[role="dialog"]', 'main section'],
      titleSelectors: ['h1', 'header a']
    },
    {
      id: 'tiktok',
      hosts: ['tiktok.com'],
      containerSelectors: ['div[data-e2e="feed-video"]', 'div[class*="DivVideoWrapper"]', 'article'],
      titleSelectors: ['[data-e2e="browse-video-desc"]', 'h1']
    },
    {
      id: 'reddit',
      hosts: ['reddit.com', 'old.reddit.com'],
      containerSelectors: ['shreddit-player', 'shreddit-post', 'div[data-testid="post-container"]', 'article'],
      titleSelectors: ['h1', 'a[slot="title"]', '[data-adclicklocation="title"]']
    },
    {
      id: 'youtube',
      hosts: ['youtube.com', 'youtu.be'],
      containerSelectors: ['#movie_player', 'ytd-player', 'ytd-reel-video-renderer'],
      titleSelectors: ['h1.ytd-watch-metadata', '#title h1', 'h2.title']
    },
    {
      id: 'facebook',
      hosts: ['facebook.com', 'fb.watch'],
      containerSelectors: ['div[role="article"]', 'div[data-pagelet="WatchPermalinkVideo"]'],
      titleSelectors: ['h2', 'strong span']
    },
    {
      id: 'bluesky',
      hosts: ['bsky.app'],
      containerSelectors: ['div[data-testid="postThreadItem"]', 'div[data-testid^="feedItem"]'],
      titleSelectors: ['div[data-testid="postText"]']
    },
    {
      id: 'vimeo',
      hosts: ['vimeo.com', 'player.vimeo.com'],
      containerSelectors: ['.player_area', '.vp-player-ui-container', '.player'],
      titleSelectors: ['h1']
    },
    {
      id: 'dailymotion',
      hosts: ['dailymotion.com', 'geo.dailymotion.com'],
      containerSelectors: ['#player-wrapper', '.player-container', 'main'],
      titleSelectors: ['h1']
    },
    {
      id: 'twitch',
      hosts: ['twitch.tv', 'clips.twitch.tv'],
      containerSelectors: ['.video-player__container', '[data-a-target="video-player"]'],
      titleSelectors: ['h2[data-a-target="stream-title"]', 'h1']
    },
    {
      id: 'linkedin',
      hosts: ['linkedin.com'],
      containerSelectors: ['.feed-shared-update-v2', '.media-player', 'article'],
      titleSelectors: ['.update-components-text', 'h1']
    }
  ]);

  const SITE_ERROR_KEY_MAP = Object.freeze({
    PLAY_FIRST: 'x_btn_play_first',
    DOWNLOAD_CANCELLED: 'x_btn_cancelled'
  });

  const msg = (key, substitutions) => chrome.i18n.getMessage(key, substitutions) || key;

  function findSiteAdapter(hostname) {
    const cleanHost = (hostname || '').toLowerCase();
    if (!cleanHost) {
      return null;
    }
    for (const xHost of X_EXCLUDED_HOSTS) {
      if (cleanHost === xHost || cleanHost.endsWith(`.${xHost}`)) {
        return null;
      }
    }
    return SITE_ADAPTERS.find((adapter) =>
      adapter.hosts.some((host) => cleanHost === host || cleanHost.endsWith(`.${host}`))
    ) || GENERIC_ADAPTER;
  }

  function isOverlayEnabledForSettings(settings, adapter) {
    if (!adapter) {
      return false;
    }
    const key = adapter.isGeneric
      ? SITE_OVERLAY_CONFIG.GENERIC_SETTING_KEY
      : SITE_OVERLAY_CONFIG.SOCIAL_SETTING_KEY;
    return !(settings && settings[key] === false);
  }

  const activeAdapter = typeof window !== 'undefined' && window.location
    ? findSiteAdapter(window.location.hostname)
    : null;
  if (!activeAdapter) {
    return;
  }

  const resetTimers = new WeakMap();
  const activeButtonsByRequestId = new Map();

  function createDownloadIcon() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2.2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');

    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4');
    const polyline = document.createElementNS(ns, 'polyline');
    polyline.setAttribute('points', '7 10 12 15 17 10');
    const line = document.createElementNS(ns, 'line');
    line.setAttribute('x1', '12');
    line.setAttribute('y1', '15');
    line.setAttribute('x2', '12');
    line.setAttribute('y2', '3');

    svg.append(path, polyline, line);
    return svg;
  }

  function createChevronIcon() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('width', '12');
    svg.setAttribute('height', '12');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2.5');
    svg.setAttribute('aria-hidden', 'true');
    const polyline = document.createElementNS(ns, 'polyline');
    polyline.setAttribute('points', '6 9 12 15 18 9');
    svg.appendChild(polyline);
    return svg;
  }

  function flashButtonState(btn, labelEl, text, isError = false, tooltip = '') {
    const existing = resetTimers.get(btn);
    if (existing) {
      clearTimeout(existing);
    }
    labelEl.textContent = text;
    btn.title = tooltip || '';
    btn.classList.remove('mh-is-cancelable');
    btn.classList.toggle('mh-is-error', isError);
    const timerId = setTimeout(() => {
      labelEl.textContent = msg('x_btn_download');
      btn.title = '';
      btn.classList.remove('mh-is-error');
      resetTimers.delete(btn);
    }, SITE_OVERLAY_CONFIG.RESET_DELAY_MS);
    resetTimers.set(btn, timerId);
  }

  function formatOverlayError(errorCode) {
    const key = SITE_ERROR_KEY_MAP[errorCode] || 'x_btn_error';
    const label = msg(key);
    const isError = errorCode !== 'DOWNLOAD_CANCELLED';
    const tooltip = key === 'x_btn_error' && errorCode ? `${label}: ${errorCode}` : label;
    return { label, isError, tooltip };
  }

  function isEligibleVideo(video) {
    if (!video) {
      return false;
    }
    const minWidth = activeAdapter && activeAdapter.isGeneric
      ? SITE_OVERLAY_CONFIG.GENERIC_MIN_VIDEO_WIDTH_PX
      : SITE_OVERLAY_CONFIG.MIN_VIDEO_WIDTH_PX;
    const minHeight = activeAdapter && activeAdapter.isGeneric
      ? SITE_OVERLAY_CONFIG.GENERIC_MIN_VIDEO_HEIGHT_PX
      : SITE_OVERLAY_CONFIG.MIN_VIDEO_HEIGHT_PX;
    if (typeof video.getBoundingClientRect === 'function') {
      const rect = video.getBoundingClientRect();
      if (rect && rect.width > 0 && rect.height > 0) {
        return rect.width >= minWidth && rect.height >= minHeight;
      }
    }
    if (video.videoWidth > 0 && video.videoHeight > 0) {
      return video.videoWidth >= minWidth && video.videoHeight >= minHeight;
    }
    return true;
  }

  function resolveOverlayHost(video) {
    if (typeof video.closest === 'function') {
      for (const selector of activeAdapter.containerSelectors) {
        try {
          const match = video.closest(selector);
          if (match) {
            return match;
          }
        } catch {
          // Ignore unsupported selector syntax
        }
      }
    }
    return video.parentElement || null;
  }

  function extractSiteTitle(host) {
    if (host && typeof host.querySelector === 'function') {
      for (const selector of activeAdapter.titleSelectors) {
        try {
          const el = host.querySelector(selector);
          const text = el && (el.textContent || '').trim();
          if (text) {
            return text;
          }
        } catch {
          // Ignore selector error
        }
      }
    }
    return (document.title || '').trim();
  }

  let isEnabled = true;

  function attachButtons() {
    if (!isEnabled) {
      return;
    }
    for (const video of document.querySelectorAll('video')) {
      if (!isEligibleVideo(video)) {
        continue;
      }
      const host = resolveOverlayHost(video);
      if (!host || host.hasAttribute(SITE_OVERLAY_CONFIG.BUTTON_ATTR)) {
        continue;
      }
      host.setAttribute(SITE_OVERLAY_CONFIG.BUTTON_ATTR, 'true');
      host.classList.add(SITE_OVERLAY_CONFIG.HOST_CLASS);

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = SITE_OVERLAY_CONFIG.BUTTON_CLASS;
      btn.setAttribute('aria-label', msg('site_btn_aria_download'));
      const labelEl = document.createElement('span');
      labelEl.textContent = msg('x_btn_download');
      btn.append(createDownloadIcon(), labelEl);

      const triggerDownload = async (options = {}) => {
        const activeReqId = btn.getAttribute(SITE_OVERLAY_CONFIG.ACTIVE_REQ_ATTR);
        if (activeReqId) {
          btn.disabled = true;
          chrome.runtime.sendMessage({
            type: SITE_OVERLAY_CONFIG.CANCEL_MESSAGE_TYPE,
            requestId: activeReqId
          }).catch(() => {});
          return;
        }

        const requestId = `site_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        btn.setAttribute(SITE_OVERLAY_CONFIG.ACTIVE_REQ_ATTR, requestId);
        activeButtonsByRequestId.set(requestId, { btn, labelEl });
        btn.disabled = true;
        btn.title = '';
        btn.classList.remove('mh-is-error', 'mh-is-cancelable');
        labelEl.textContent = msg('x_btn_downloading');

        try {
          const rawSrc = video.currentSrc || video.src || '';
          const payload = {
            requestId,
            siteId: activeAdapter.id,
            pageUrl: window.location.href,
            title: extractSiteTitle(host),
            directVideoUrl: rawSrc.startsWith('http') ? rawSrc : '',
            blobUrl: rawSrc.startsWith('blob:') ? rawSrc : '',
            poster: (typeof video.getAttribute === 'function' ? video.getAttribute('poster') : '') || ''
          };
          if (typeof options.qualityPreference === 'string' && options.qualityPreference) {
            payload.qualityPreference = options.qualityPreference;
          }
          if (options.audioOnly) {
            payload.audioOnly = true;
          }
          const response = await chrome.runtime.sendMessage({
            type: SITE_OVERLAY_CONFIG.MESSAGE_TYPE,
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
          btn.removeAttribute(SITE_OVERLAY_CONFIG.ACTIVE_REQ_ATTR);
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
      qualityWrap.className = SITE_OVERLAY_CONFIG.QUALITY_WRAP_CLASS;

      const toggleBtn = document.createElement('button');
      toggleBtn.type = 'button';
      toggleBtn.className = 'mh-site-quality-toggle';
      toggleBtn.setAttribute('aria-label', msg('overlay_quality_menu_aria'));
      toggleBtn.setAttribute('aria-expanded', 'false');
      toggleBtn.appendChild(createChevronIcon());

      const menu = document.createElement('div');
      menu.className = SITE_OVERLAY_CONFIG.QUALITY_MENU_CLASS;
      menu.setAttribute('role', 'menu');

      const presets = [
        { key: 'overlay_quality_best', qualityPreference: 'highest', audioOnly: false },
        { key: 'overlay_quality_lowest', qualityPreference: 'lowest', audioOnly: false },
        { key: 'overlay_quality_audio', qualityPreference: '', audioOnly: true }
      ];
      for (const preset of presets) {
        const optionBtn = document.createElement('button');
        optionBtn.type = 'button';
        optionBtn.className = 'mh-site-quality-option';
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

      toggleBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const isOpen = qualityWrap.classList.toggle('mh-is-open');
        toggleBtn.setAttribute('aria-expanded', String(isOpen));
      });

      qualityWrap.append(toggleBtn, menu);
      host.append(btn, qualityWrap);
    }
  }

  let debounceTimer = null;
  const observer = new MutationObserver(() => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(attachButtons, SITE_OVERLAY_CONFIG.DEBOUNCE_MS);
  });

  function enableOverlay() {
    isEnabled = true;
    if (document.body) {
      observer.observe(document.body, { childList: true, subtree: true });
      attachButtons();
    }
  }

  function disableOverlay() {
    isEnabled = false;
    clearTimeout(debounceTimer);
    observer.disconnect();
    for (const btn of document.querySelectorAll(`.${SITE_OVERLAY_CONFIG.BUTTON_CLASS}`)) {
      btn.remove();
    }
    for (const wrap of document.querySelectorAll(`.${SITE_OVERLAY_CONFIG.QUALITY_WRAP_CLASS}`)) {
      wrap.remove();
    }
    for (const host of document.querySelectorAll(`[${SITE_OVERLAY_CONFIG.BUTTON_ATTR}]`)) {
      host.removeAttribute(SITE_OVERLAY_CONFIG.BUTTON_ATTR);
      host.classList.remove(SITE_OVERLAY_CONFIG.HOST_CLASS);
    }
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (!message || message.type !== SITE_OVERLAY_CONFIG.PROGRESS_MESSAGE_TYPE || !message.requestId) {
      return;
    }
    const active = activeButtonsByRequestId.get(message.requestId);
    if (!active) {
      return;
    }
    active.btn.disabled = false;
    active.btn.classList.add('mh-is-cancelable');
    active.btn.title = msg('popup_action_cancel');
    if (message.total > 0 && message.done >= message.total) {
      active.labelEl.textContent = msg('x_btn_muxing');
    } else if (message.total > 0) {
      active.labelEl.textContent = msg('x_btn_progress', [String(message.done), String(message.total)]);
    } else {
      active.labelEl.textContent = msg('x_btn_downloading');
    }
  });

  if (chrome.storage && chrome.storage.sync) {
    chrome.storage.sync.get(SITE_OVERLAY_CONFIG.STORAGE_SETTINGS_KEY, (data) => {
      const settings = data && data[SITE_OVERLAY_CONFIG.STORAGE_SETTINGS_KEY];
      if (!isOverlayEnabledForSettings(settings, activeAdapter)) {
        disableOverlay();
      } else {
        enableOverlay();
      }
    });
  } else {
    enableOverlay();
  }

  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'sync' || !changes[SITE_OVERLAY_CONFIG.STORAGE_SETTINGS_KEY]) {
        return;
      }
      const next = changes[SITE_OVERLAY_CONFIG.STORAGE_SETTINGS_KEY].newValue;
      if (!isOverlayEnabledForSettings(next, activeAdapter)) {
        disableOverlay();
      } else {
        enableOverlay();
      }
    });
  }
})();
