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
  const BRIDGE_CONFIG = Object.freeze({
    WINDOW_SOURCE: 'media-harvest-mse',
    STORAGE_SETTINGS_KEY: 'user_settings',
    DEFAULT_BUFFER_CAP_BYTES: 150 * 1024 * 1024,
    DEFAULT_SLICE_BYTES: 2 * 1024 * 1024,
    EXPORT_TIMEOUT_MS: 30000,
    EVENTS: Object.freeze({
      CONFIG: 'MSE_CONFIG',
      STREAM_UPDATED: 'MSE_STREAM_UPDATED',
      EXPORT_REQUEST: 'MSE_EXPORT_REQUEST',
      EXPORT_CHUNK: 'MSE_EXPORT_CHUNK',
      EXPORT_DONE: 'MSE_EXPORT_DONE'
    }),
    RUNTIME_MESSAGES: Object.freeze({
      MSE_STREAM_UPDATED: 'MSE_STREAM_UPDATED',
      EXPORT_MSE_STREAM: 'EXPORT_MSE_STREAM',
      OFFSCREEN_BUILD_MSE_BLOB: 'OFFSCREEN_BUILD_MSE_BLOB'
    })
  });

  if (typeof window === 'undefined' || window.__mediaHarvestMseBridgeInstalled) {
    return;
  }
  window.__mediaHarvestMseBridgeInstalled = true;

  let captureEnabled = true;
  const knownStreams = new Map();
  const pendingExports = new Map();

  function postToHook(kind, payload) {
    window.postMessage({
      source: BRIDGE_CONFIG.WINDOW_SOURCE,
      kind,
      payload
    }, '*');
  }

  function applySettings(rawSettings) {
    const nextEnabled = !(rawSettings && rawSettings.enableMseCapture === false);
    captureEnabled = nextEnabled;
    if (!captureEnabled) {
      knownStreams.clear();
    }
    postToHook(BRIDGE_CONFIG.EVENTS.CONFIG, {
      enabled: captureEnabled,
      bufferCapBytes: BRIDGE_CONFIG.DEFAULT_BUFFER_CAP_BYTES
    });
  }

  /**
   * Wraps chrome.runtime.sendMessage so invalidated contexts never emit uncaught sync or promise errors.
   * @param {object} msg
   * @param {{ propagateError?: boolean }} [options]
   * @returns {Promise<any>}
   */
  function sendRuntimeMessageSafe(msg, { propagateError = false } = {}) {
    if (typeof chrome === 'undefined' || !chrome.runtime || typeof chrome.runtime.sendMessage !== 'function') {
      return propagateError ? Promise.reject(new Error('MSE_EXPORT_FAILED')) : Promise.resolve(undefined);
    }
    try {
      const pending = chrome.runtime.sendMessage(msg);
      if (pending && typeof pending.then === 'function') {
        return propagateError ? pending : pending.catch(() => undefined);
      }
      return Promise.resolve(pending);
    } catch (err) {
      return propagateError ? Promise.reject(err) : Promise.resolve(undefined);
    }
  }

  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
    try {
      chrome.storage.sync.get(BRIDGE_CONFIG.STORAGE_SETTINGS_KEY, (data) => {
        if (chrome.runtime && chrome.runtime.lastError) {
          return;
        }
        applySettings(data && data[BRIDGE_CONFIG.STORAGE_SETTINGS_KEY]);
      });
    } catch {
      // Ignore storage failures when extension context is invalidated
    }
    if (chrome.storage.onChanged) {
      try {
        chrome.storage.onChanged.addListener((changes, areaName) => {
          if (areaName === 'sync' && changes[BRIDGE_CONFIG.STORAGE_SETTINGS_KEY]) {
            applySettings(changes[BRIDGE_CONFIG.STORAGE_SETTINGS_KEY].newValue);
          }
        });
      } catch {
        // Ignore listener errors after context invalidation
      }
    }
  }

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000;
    const parts = [];
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const slice = bytes.subarray(i, i + chunkSize);
      parts.push(String.fromCharCode.apply(null, slice));
    }
    return btoa(parts.join(''));
  }

  function cleanupPendingExport(requestId) {
    const pending = pendingExports.get(requestId);
    if (pending) {
      pending.settled = true;
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
    }
    pendingExports.delete(requestId);
  }

  window.addEventListener('message', (event) => {
    if (!event || event.source !== window || !event.data) {
      return;
    }
    const { source, kind, payload } = event.data;
    if (source !== BRIDGE_CONFIG.WINDOW_SOURCE || !payload) {
      return;
    }

    if (kind === BRIDGE_CONFIG.EVENTS.STREAM_UPDATED) {
      if (!captureEnabled || !payload.mseId) {
        return;
      }
      knownStreams.set(payload.mseId, payload);
      sendRuntimeMessageSafe({
        type: BRIDGE_CONFIG.RUNTIME_MESSAGES.MSE_STREAM_UPDATED,
        stream: payload
      });
      return;
    }

    if (kind === BRIDGE_CONFIG.EVENTS.EXPORT_CHUNK) {
      const pending = pendingExports.get(payload.requestId);
      if (!pending || pending.settled || pending.queueError || !(payload.buffer instanceof ArrayBuffer)) {
        return;
      }
      pending.queue = pending.queue
        .then(() => {
          if (pending.settled || pending.queueError) {
            return undefined;
          }
          return sendRuntimeMessageSafe({
            target: 'offscreen',
            type: BRIDGE_CONFIG.RUNTIME_MESSAGES.OFFSCREEN_BUILD_MSE_BLOB,
            action: 'append',
            requestId: payload.requestId,
            track: payload.track,
            chunkBase64: arrayBufferToBase64(payload.buffer)
          }, { propagateError: true });
        })
        .catch((err) => {
          pending.queueError = err || new Error('MSE_EXPORT_FAILED');
        });
      return;
    }

    if (kind === BRIDGE_CONFIG.EVENTS.EXPORT_DONE) {
      const pending = pendingExports.get(payload.requestId);
      if (!pending || pending.settled) {
        return;
      }
      pending.queue
        .then(async () => {
          if (pending.settled) {
            return;
          }
          if (!payload.ok || pending.queueError) {
            await sendRuntimeMessageSafe({
              target: 'offscreen',
              type: BRIDGE_CONFIG.RUNTIME_MESSAGES.OFFSCREEN_BUILD_MSE_BLOB,
              action: 'abort',
              requestId: payload.requestId
            });
            const errMsg = pending.queueError
              ? (pending.queueError.message || 'MSE_EXPORT_FAILED')
              : (payload.error || 'MSE_NOT_FOUND');
            pending.resolve({ ok: false, error: errMsg });
            return;
          }
          const result = await sendRuntimeMessageSafe({
            target: 'offscreen',
            type: BRIDGE_CONFIG.RUNTIME_MESSAGES.OFFSCREEN_BUILD_MSE_BLOB,
            action: 'finalize',
            requestId: payload.requestId,
            audioOnly: Boolean(pending.audioOnly),
            audioFormat: pending.audioFormat || 'm4a',
            videoMime: payload.videoMime || '',
            audioMime: payload.audioMime || ''
          }, { propagateError: true });
          pending.resolve(result || { ok: false, error: 'MSE_EXPORT_FAILED' });
        })
        .catch((err) => {
          pending.resolve({ ok: false, error: (err && err.message) || 'MSE_EXPORT_FAILED' });
        })
        .finally(() => {
          cleanupPendingExport(payload.requestId);
        });
    }
  });

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!message || message.type !== BRIDGE_CONFIG.RUNTIME_MESSAGES.EXPORT_MSE_STREAM) {
        return false;
      }
      if (!knownStreams.has(message.mseId)) {
        return false;
      }
      const requestId = message.requestId || `mse_exp_${Date.now()}`;
      new Promise((resolve) => {
        const timer = setTimeout(() => {
          cleanupPendingExport(requestId);
          resolve({ ok: false, error: 'MSE_TIMEOUT' });
        }, BRIDGE_CONFIG.EXPORT_TIMEOUT_MS);
        pendingExports.set(requestId, {
          resolve,
          timer,
          settled: false,
          queueError: null,
          audioOnly: Boolean(message.audioOnly),
          audioFormat: typeof message.audioFormat === 'string' ? message.audioFormat : 'm4a',
          queue: Promise.resolve()
        });
        postToHook(BRIDGE_CONFIG.EVENTS.EXPORT_REQUEST, {
          requestId,
          mseId: message.mseId,
          sliceBytes: BRIDGE_CONFIG.DEFAULT_SLICE_BYTES
        });
      }).then((result) => {
        try {
          sendResponse(result);
        } catch {
          // Ignore sendResponse errors if channel closed or context invalidated
        }
      });
      return true;
    });
  }
})();
