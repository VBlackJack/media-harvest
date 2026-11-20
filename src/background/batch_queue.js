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

import { LIMITS, MESSAGE_TYPES } from '../config/constants.js';

/**
 * Creates a Service Worker-hosted resilient batch download queue that continues
 * executing even if the popup closes mid-batch.
 * @param {{
 *   executeItem: (item: object) => Promise<{ downloadId?: number, requestId?: string }>,
 *   cancelRequest?: (requestId: string) => Promise<void>,
 *   notifyProgress?: (snapshot: object) => void,
 *   delayMs?: number
 * }} deps
 */
export function createBackgroundBatchQueue(deps) {
  const executeItem = deps.executeItem;
  const cancelRequest = typeof deps.cancelRequest === 'function' ? deps.cancelRequest : async () => {};
  const notifyProgress = typeof deps.notifyProgress === 'function'
    ? deps.notifyProgress
    : (snapshot) => {
        if (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.sendMessage === 'function') {
          chrome.runtime.sendMessage({
            type: MESSAGE_TYPES.BATCH_QUEUE_PROGRESS,
            ...snapshot
          }).catch(() => {});
        }
      };
  const delayMs = typeof deps.delayMs === 'number' ? deps.delayMs : LIMITS.BATCH_DOWNLOAD_DELAY_MS;

  const state = {
    running: false,
    abortRequested: false,
    activeRequestId: '',
    total: 0,
    completed: 0,
    startedCount: 0,
    failedCount: 0,
    lastError: ''
  };

  function getSnapshot() {
    return {
      running: state.running,
      total: state.total,
      completed: state.completed,
      startedCount: state.startedCount,
      failedCount: state.failedCount,
      lastError: state.lastError,
      aborted: state.abortRequested
    };
  }

  async function cancel() {
    if (!state.running) {
      return getSnapshot();
    }
    state.abortRequested = true;
    if (state.activeRequestId) {
      await cancelRequest(state.activeRequestId).catch(() => {});
    }
    notifyProgress(getSnapshot());
    return getSnapshot();
  }

  async function start(items) {
    const queue = Array.isArray(items) ? items.filter(Boolean) : [];
    if (state.running) {
      return { ok: false, error: 'BATCH_ALREADY_RUNNING', ...getSnapshot() };
    }
    if (queue.length === 0) {
      return { ok: true, ...getSnapshot() };
    }

    state.running = true;
    state.abortRequested = false;
    state.activeRequestId = '';
    state.total = queue.length;
    state.completed = 0;
    state.startedCount = 0;
    state.failedCount = 0;
    state.lastError = '';
    notifyProgress(getSnapshot());

    try {
      for (let idx = 0; idx < queue.length; idx += 1) {
        if (state.abortRequested) {
          break;
        }
        const item = queue[idx];
        const reqId = item.requestId || `bgbatch_${Date.now()}_${idx}_${Math.random().toString(36).slice(2, 6)}`;
        state.activeRequestId = reqId;
        try {
          await executeItem({ ...item, requestId: reqId });
          state.startedCount += 1;
        } catch (err) {
          state.failedCount += 1;
          state.lastError = (err && err.message) || 'DOWNLOAD_FAILED';
        } finally {
          state.completed += 1;
          state.activeRequestId = '';
          notifyProgress(getSnapshot());
        }
        if (state.abortRequested) {
          break;
        }
        if (delayMs > 0 && idx + 1 < queue.length) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
    } finally {
      state.running = false;
      state.activeRequestId = '';
      notifyProgress(getSnapshot());
    }

    return { ok: true, ...getSnapshot() };
  }

  return {
    start,
    cancel,
    getSnapshot
  };
}
