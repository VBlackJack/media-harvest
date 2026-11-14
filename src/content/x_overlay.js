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
    MEDIA_ID_PATTERN: /(?:ext_tw_video|amplify_video|tweet_video)(?:_thumb)?\/(\d+)\//i,
    STATUS_PATH_PATTERN: /\/([A-Za-z0-9_]+)\/status\/(\d+)/,
    MESSAGE_TYPE: 'DOWNLOAD_TWEET_VIDEO',
    DEBOUNCE_MS: 300,
    RESET_DELAY_MS: 3000
  });

  const msg = (key) => chrome.i18n.getMessage(key) || key;

  /**
   * Creates the inline SVG download icon element.
   * @returns {SVGSVGElement}
   */
  function createDownloadIcon() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
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
   * Extracts tweet author, status ID, and video media ID from a tweet article element.
   * @param {Element} article
   * @param {HTMLVideoElement} video
   * @returns {{ mediaId: string, posterUrl: string, directSrc: string, authorHandle: string, tweetId: string }}
   */
  function extractTweetMetadata(article, video) {
    const posterUrl = video.getAttribute('poster') || '';
    const directSrc = video.currentSrc || video.getAttribute('src') || '';
    const mediaMatch = posterUrl.match(OVERLAY_CONFIG.MEDIA_ID_PATTERN)
      || directSrc.match(OVERLAY_CONFIG.MEDIA_ID_PATTERN);

    let authorHandle = '';
    let tweetId = '';
    for (const anchor of article.querySelectorAll(OVERLAY_CONFIG.STATUS_LINK_SELECTOR)) {
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

  /**
   * Updates the button text and schedules automatic restoration to idle state.
   * @param {HTMLButtonElement} btn
   * @param {HTMLSpanElement} labelEl
   * @param {string} labelText
   * @param {boolean} isError
   */
  function flashButtonState(btn, labelEl, labelText, isError) {
    labelEl.textContent = labelText;
    btn.classList.toggle('mh-is-error', isError);
    setTimeout(() => {
      labelEl.textContent = msg('x_btn_download');
      btn.classList.remove('mh-is-error');
    }, OVERLAY_CONFIG.RESET_DELAY_MS);
  }

  /**
   * Injects a download pill button into any tweet article containing a video.
   */
  function attachButtons() {
    for (const article of document.querySelectorAll(OVERLAY_CONFIG.TWEET_SELECTOR)) {
      const video = article.querySelector(OVERLAY_CONFIG.VIDEO_SELECTOR);
      if (!video) {
        continue;
      }
      const actionBar = article.querySelector(OVERLAY_CONFIG.ACTION_GROUP_SELECTOR);
      if (!actionBar || actionBar.hasAttribute(OVERLAY_CONFIG.BUTTON_ATTR)) {
        continue;
      }
      actionBar.setAttribute(OVERLAY_CONFIG.BUTTON_ATTR, 'true');

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'mh-x-download-btn';
      const labelEl = document.createElement('span');
      labelEl.textContent = msg('x_btn_download');
      btn.append(createDownloadIcon(), labelEl);

      btn.addEventListener('click', async (event) => {
        event.preventDefault();
        event.stopPropagation();

        btn.disabled = true;
        btn.classList.remove('mh-is-error');
        labelEl.textContent = msg('x_btn_downloading');

        try {
          const payload = extractTweetMetadata(article, video);
          const response = await chrome.runtime.sendMessage({
            type: OVERLAY_CONFIG.MESSAGE_TYPE,
            payload
          });

          if (!response || !response.ok) {
            const errorKey = response && response.error === 'PLAY_FIRST'
              ? 'x_btn_play_first'
              : 'x_btn_error';
            flashButtonState(btn, labelEl, msg(errorKey), true);
            return;
          }
          flashButtonState(btn, labelEl, msg('x_btn_done'), false);
        } catch {
          flashButtonState(btn, labelEl, msg('x_btn_error'), true);
        } finally {
          btn.disabled = false;
        }
      });

      actionBar.appendChild(btn);
    }
  }

  let debounceTimer = null;
  const observer = new MutationObserver(() => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(attachButtons, OVERLAY_CONFIG.DEBOUNCE_MS);
  });

  observer.observe(document.body, { childList: true, subtree: true });
  attachButtons();
})();
