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
import { localizeError } from './popup_helpers.js';

/**
 * Runs a sequential batch of media downloads with status feedback and cancellation support.
 * @param {object} options
 * @param {Array<object>} options.batchItems
 * @param {object} options.state
 * @param {object} options.chromeApi
 * @param {Function} options.translateFn
 * @param {Function} options.setStatusBanner
 * @param {Function} options.hideBatchConfirm
 * @param {Function} options.renderList
 * @param {Function} options.isFolderFilenameTemplate
 * @param {number} [options.batchDelayMs=0]
 * @returns {Promise<{ startedCount: number, failedCount: number, lastError: string, aborted: boolean }>}
 */
export async function runBatchDownloads({
  batchItems,
  state,
  chromeApi,
  translateFn,
  setStatusBanner,
  hideBatchConfirm,
  renderList,
  isFolderFilenameTemplate,
  batchDelayMs = 0
}) {
  if (state.batchRunning || !batchItems || batchItems.length === 0) {
    return { startedCount: 0, failedCount: 0, lastError: '', aborted: false };
  }

  state.batchRunning = true;
  state.batchAbortRequested = false;
  if (typeof hideBatchConfirm === 'function') {
    hideBatchConfirm();
  }
  if (typeof renderList === 'function') {
    renderList();
  }

  const allowFolders = typeof isFolderFilenameTemplate === 'function'
    ? isFolderFilenameTemplate(state.settings.filenameTemplate)
    : false;
  let startedCount = 0;
  let failedCount = 0;
  let lastError = '';

  try {
    for (let i = 0; i < batchItems.length; i += 1) {
      const item = batchItems[i];
      if (state.batchAbortRequested) {
        break;
      }
      if (typeof setStatusBanner === 'function') {
        setStatusBanner(
          translateFn('popup_status_batch_progress', [String(i + 1), String(batchItems.length)])
        );
      }
      const cardEntry = state.cardsByUrl ? state.cardsByUrl.get(item.url) : null;
      const selectedPlaylistUrl = cardEntry && cardEntry.qualitySelect && !cardEntry.qualitySelect.classList.contains('hidden')
        ? cardEntry.qualitySelect.value
        : item.url;
      const selectedAudioUrl = cardEntry && cardEntry.audioSelect && !cardEntry.audioSelect.classList.contains('hidden')
        ? cardEntry.audioSelect.value
        : '';
      const requestId = (item.isStream || item.isMse)
        ? `batch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
        : '';
      if (requestId) {
        state.activeBatchRequestId = requestId;
        if (state.localPendingRequestIds) {
          state.localPendingRequestIds.add(requestId);
        }
      }
      try {
        const response = await chromeApi.runtime.sendMessage({
          type: MESSAGE_TYPES.DOWNLOAD_MEDIA,
          payload: {
            url: item.url,
            playlistUrl: selectedPlaylistUrl,
            audioUrl: selectedAudioUrl,
            isStream: Boolean(item.isStream),
            isMse: Boolean(item.isMse),
            mseId: item.mseId || '',
            frameId: typeof item.frameId === 'number' ? item.frameId : undefined,
            ext: item.ext || '',
            referer: item.referer || state.activeTabUrl || '',
            tabId: typeof state.activeTabId === 'number' ? state.activeTabId : -1,
            filename: item.suggestedFilename,
            allowFolders,
            saveAs: false,
            requestId
          }
        });
        if (!response || !response.ok) {
          failedCount += 1;
          lastError = (response && response.error) || 'DOWNLOAD_FAILED';
        } else {
          startedCount += 1;
        }
      } catch (err) {
        failedCount += 1;
        lastError = (err && err.message) || 'DOWNLOAD_FAILED';
      } finally {
        if (requestId && state.localPendingRequestIds) {
          state.localPendingRequestIds.delete(requestId);
          if (state.activeBatchRequestId === requestId) {
            state.activeBatchRequestId = '';
          }
        }
      }
      if (state.batchAbortRequested) {
        break;
      }
      if (batchDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, batchDelayMs));
      }
    }

    if (typeof setStatusBanner === 'function') {
      if (state.batchAbortRequested) {
        setStatusBanner(translateFn('popup_status_download_cancelled'));
      } else if (failedCount > 0 && startedCount > 0) {
        setStatusBanner(
          translateFn('popup_status_batch_partial', [
            String(startedCount),
            String(failedCount),
            localizeError(lastError, translateFn)
          ]),
          true
        );
      } else if (failedCount > 0) {
        setStatusBanner(localizeError(lastError, translateFn), true);
      } else {
        setStatusBanner(translateFn('popup_status_download_started'));
      }
    }
  } finally {
    const wasAborted = Boolean(state.batchAbortRequested);
    state.activeBatchRequestId = '';
    state.batchRunning = false;
    state.batchAbortRequested = false;
    if (typeof renderList === 'function') {
      renderList();
    }
    return {
      startedCount,
      failedCount,
      lastError,
      aborted: wasAborted
    };
  }
}
