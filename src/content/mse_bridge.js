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

  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
    chrome.storage.sync.get(BRIDGE_CONFIG.STORAGE_SETTINGS_KEY, (data) => {
      applySettings(data && data[BRIDGE_CONFIG.STORAGE_SETTINGS_KEY]);
    });
    if (chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName === 'sync' && changes[BRIDGE_CONFIG.STORAGE_SETTINGS_KEY]) {
          applySettings(changes[BRIDGE_CONFIG.STORAGE_SETTINGS_KEY].newValue);
        }
      });
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
    if (pending && pending.timer) {
      clearTimeout(pending.timer);
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
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({
          type: BRIDGE_CONFIG.RUNTIME_MESSAGES.MSE_STREAM_UPDATED,
          stream: payload
        }).catch(() => {});
      }
      return;
    }

    if (kind === BRIDGE_CONFIG.EVENTS.EXPORT_CHUNK) {
      const pending = pendingExports.get(payload.requestId);
      if (!pending || !(payload.buffer instanceof ArrayBuffer)) {
        return;
      }
      pending.queue = pending.queue.then(() => chrome.runtime.sendMessage({
        target: 'offscreen',
        type: BRIDGE_CONFIG.RUNTIME_MESSAGES.OFFSCREEN_BUILD_MSE_BLOB,
        action: 'append',
        requestId: payload.requestId,
        track: payload.track,
        chunkBase64: arrayBufferToBase64(payload.buffer)
      }));
      return;
    }

    if (kind === BRIDGE_CONFIG.EVENTS.EXPORT_DONE) {
      const pending = pendingExports.get(payload.requestId);
      if (!pending) {
        return;
      }
      pending.queue
        .then(async () => {
          if (!payload.ok) {
            await chrome.runtime.sendMessage({
              target: 'offscreen',
              type: BRIDGE_CONFIG.RUNTIME_MESSAGES.OFFSCREEN_BUILD_MSE_BLOB,
              action: 'abort',
              requestId: payload.requestId
            }).catch(() => {});
            pending.resolve({ ok: false, error: payload.error || 'MSE_NOT_FOUND' });
            return;
          }
          const result = await chrome.runtime.sendMessage({
            target: 'offscreen',
            type: BRIDGE_CONFIG.RUNTIME_MESSAGES.OFFSCREEN_BUILD_MSE_BLOB,
            action: 'finalize',
            requestId: payload.requestId,
            videoMime: payload.videoMime || '',
            audioMime: payload.audioMime || ''
          });
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
          queue: Promise.resolve()
        });
        postToHook(BRIDGE_CONFIG.EVENTS.EXPORT_REQUEST, {
          requestId,
          mseId: message.mseId,
          sliceBytes: BRIDGE_CONFIG.DEFAULT_SLICE_BYTES
        });
      }).then((result) => sendResponse(result));
      return true;
    });
  }
})();
