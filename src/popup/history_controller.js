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

import { MESSAGE_TYPES } from '../config/constants.js';

/**
 * Extracts compact display basename from a saved download filename path.
 * @param {string} filename
 * @param {string} url
 * @returns {string}
 */
function formatHistoryLabel(filename, url) {
  if (typeof filename === 'string' && filename.trim()) {
    const clean = filename.replace(/\\/g, '/');
    const parts = clean.split('/').filter(Boolean);
    if (parts.length > 0) {
      return parts[parts.length - 1];
    }
  }
  if (typeof url === 'string' && url) {
    try {
      const parsed = new URL(url);
      const tail = parsed.pathname.split('/').filter(Boolean).pop();
      return tail || parsed.hostname;
    } catch {
      return url.slice(0, 48);
    }
  }
  return '';
}

/**
 * Creates the popup recent download history drawer controller.
 * @param {{
 *   doc: Document,
 *   els: object,
 *   sendMessage: (msg: object) => Promise<any>,
 *   translateFn: (key: string, subs?: string[]) => string,
 *   setStatusBanner: (msg: string, isError?: boolean) => void
 * }} deps
 * @returns {object}
 */
export function createHistoryController({ doc, els, sendMessage, translateFn, setStatusBanner }) {
  /**
   * Renders the given history entries inside the drawer list.
   * @param {Array<object>} entries
   */
  function renderHistoryEntries(entries) {
    if (!els.historyList || !els.historyEmpty) {
      return;
    }
    if (typeof els.historyList.replaceChildren === 'function') {
      els.historyList.replaceChildren();
    } else {
      while (els.historyList.firstChild) {
        els.historyList.removeChild(els.historyList.firstChild);
      }
    }
    const list = Array.isArray(entries) ? entries : [];
    els.historyEmpty.classList.toggle('hidden', list.length > 0);
    if (els.historyClearBtn) {
      els.historyClearBtn.disabled = list.length === 0;
    }

    for (const entry of list) {
      const li = doc.createElement('li');
      li.className = 'history-item';

      const info = doc.createElement('div');
      info.className = 'history-item-info';

      const nameEl = doc.createElement('span');
      nameEl.className = 'history-item-name';
      nameEl.textContent = formatHistoryLabel(entry.filename, entry.url);
      nameEl.title = entry.filename || entry.url || '';

      const statusEl = doc.createElement('span');
      statusEl.className = `history-item-status ${entry.ok ? 'is-done' : 'is-error'}`;
      statusEl.textContent = entry.ok
        ? translateFn('popup_history_status_done')
        : `${translateFn('popup_history_status_error')}${entry.error ? `: ${entry.error}` : ''}`;

      info.appendChild(nameEl);
      info.appendChild(statusEl);
      li.appendChild(info);

      if (entry.url && !entry.isMse) {
        const retryBtn = doc.createElement('button');
        retryBtn.type = 'button';
        retryBtn.className = 'btn btn-secondary btn-compact history-retry-btn';
        retryBtn.textContent = translateFn('popup_history_retry');
        retryBtn.addEventListener('click', async () => {
          retryBtn.disabled = true;
          try {
            const response = await sendMessage({
              type: MESSAGE_TYPES.DOWNLOAD_MEDIA,
              payload: {
                url: entry.url,
                playlistUrl: entry.playlistUrl || entry.url,
                audioUrl: entry.audioUrl || '',
                referer: entry.referer || '',
                filename: entry.filename || '',
                isStream: Boolean(entry.isStream),
                audioOnly: Boolean(entry.audioOnly),
                qualityPreference: entry.qualityPreference || ''
              }
            });
            if (!response || !response.ok) {
              setStatusBanner((response && response.error) || translateFn('popup_error_download_failed'), true);
            } else {
              setStatusBanner(translateFn('popup_status_download_started'));
            }
          } catch (err) {
            setStatusBanner((err && err.message) || translateFn('popup_error_download_failed'), true);
          } finally {
            await refreshHistory();
            retryBtn.disabled = false;
          }
        });
        li.appendChild(retryBtn);
      }

      els.historyList.appendChild(li);
    }
  }

  /**
   * Fetches and renders recorded recent downloads from the service worker.
   * @returns {Promise<void>}
   */
  async function refreshHistory() {
    if (!els.historyDrawer) {
      return;
    }
    try {
      const response = await sendMessage({ type: MESSAGE_TYPES.GET_DOWNLOAD_HISTORY });
      renderHistoryEntries(response && response.ok ? response.history : []);
    } catch {
      renderHistoryEntries([]);
    }
  }

  /**
   * Binds drawer toggle and clear button events.
   */
  function bindHistoryEvents() {
    if (els.historyToggleBtn && els.historyDrawer) {
      els.historyToggleBtn.addEventListener('click', async () => {
        const isHidden = els.historyDrawer.classList.toggle('hidden');
        els.historyToggleBtn.setAttribute('aria-expanded', String(!isHidden));
        if (!isHidden) {
          await refreshHistory();
        }
      });
    }
    if (els.historyClearBtn) {
      els.historyClearBtn.addEventListener('click', async () => {
        try {
          await sendMessage({ type: MESSAGE_TYPES.CLEAR_DOWNLOAD_HISTORY });
        } catch {
          // Ignore clear failure
        }
        renderHistoryEntries([]);
      });
    }
  }

  return {
    renderHistoryEntries,
    refreshHistory,
    bindHistoryEvents
  };
}
