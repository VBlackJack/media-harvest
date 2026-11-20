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

import { LIMITS, STORAGE_KEYS } from '../config/constants.js';

let historyWriteChain = Promise.resolve();

/**
 * Reads recorded recent download history from chrome.storage.local.
 * @returns {Promise<Array<object>>}
 */
export async function getDownloadHistory() {
  if (!chrome.storage || !chrome.storage.local || typeof chrome.storage.local.get !== 'function') {
    return [];
  }
  const stored = await chrome.storage.local.get(STORAGE_KEYS.DOWNLOAD_HISTORY);
  const list = stored && stored[STORAGE_KEYS.DOWNLOAD_HISTORY];
  return Array.isArray(list) ? list : [];
}

/**
 * Clears all entries in recent download history storage.
 * @returns {Promise<void>}
 */
export async function clearDownloadHistory() {
  if (!chrome.storage || !chrome.storage.local || typeof chrome.storage.local.remove !== 'function') {
    return;
  }
  await chrome.storage.local.remove(STORAGE_KEYS.DOWNLOAD_HISTORY);
}

/**
 * Appends a completed or failed download record to recent history capped to LIMITS.MAX_DOWNLOAD_HISTORY.
 * @param {object} entry
 * @returns {Promise<void>}
 */
export function recordDownloadHistory(entry) {
  if (!chrome.storage || !chrome.storage.local || typeof chrome.storage.local.set !== 'function') {
    return Promise.resolve();
  }
  const item = {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    url: typeof entry.url === 'string' ? entry.url : '',
    playlistUrl: typeof entry.playlistUrl === 'string' ? entry.playlistUrl : '',
    audioUrl: typeof entry.audioUrl === 'string' ? entry.audioUrl : '',
    referer: typeof entry.referer === 'string' ? entry.referer : '',
    filename: typeof entry.filename === 'string' ? entry.filename : '',
    isStream: Boolean(entry.isStream),
    isMse: Boolean(entry.isMse),
    audioOnly: Boolean(entry.audioOnly),
    qualityPreference: typeof entry.qualityPreference === 'string' ? entry.qualityPreference : '',
    ok: Boolean(entry.ok),
    error: typeof entry.error === 'string' ? entry.error : '',
    timestamp: Date.now()
  };
  historyWriteChain = historyWriteChain
    .then(async () => {
      const prev = await getDownloadHistory();
      const deduped = prev.filter((p) => !(p.url === item.url && p.filename === item.filename && Boolean(p.audioOnly) === item.audioOnly));
      const next = [item, ...deduped].slice(0, LIMITS.MAX_DOWNLOAD_HISTORY);
      await chrome.storage.local.set({ [STORAGE_KEYS.DOWNLOAD_HISTORY]: next });
    })
    .catch(() => {});
  return historyWriteChain;
}
