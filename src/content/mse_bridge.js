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
    BASE64_SLICE_BYTES: 0x8000,
    MAX_KNOWN_STREAMS: 32,
    MAX_MSE_ID_LENGTH: 128,
    EXPORT_TIMEOUT_MS: 30000,
    EVENTS: Object.freeze({
      HANDSHAKE_INIT: 'MSE_HANDSHAKE_INIT',
      HANDSHAKE_READY: 'MSE_HANDSHAKE_READY',
      HANDSHAKE_ACK: 'MSE_HANDSHAKE_ACK',
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
  let hookPort = null;
  let handshakeAcked = false;
  const candidatePorts = new Set();
  const pendingToHook = [];
  const knownStreams = new Map();
  const pendingExports = new Map();

  function postToHook(kind, payload) {
    const message = {
      source: BRIDGE_CONFIG.WINDOW_SOURCE,
      kind,
      payload
    };
    if (hookPort && handshakeAcked) {
      try {
        hookPort.postMessage(message);
      } catch {
        // Ignore failures on closed ports
      }
      return;
    }
    pendingToHook.push(message);
  }

  function flushPendingToHook() {
    if (!hookPort || !handshakeAcked) {
      return;
    }
    while (pendingToHook.length > 0) {
      const msg = pendingToHook.shift();
      try {
        hookPort.postMessage(msg);
      } catch {
        break;
      }
    }
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

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    const chunkSize = BRIDGE_CONFIG.BASE64_SLICE_BYTES;
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

  function isValidStreamUpdatePayload(payload) {
    if (!payload || typeof payload !== 'object') {
      return false;
    }
    if (
      typeof payload.mseId !== 'string' ||
      !payload.mseId ||
      payload.mseId.length > BRIDGE_CONFIG.MAX_MSE_ID_LENGTH
    ) {
      return false;
    }
    if (!Number.isFinite(payload.totalBytes) || payload.totalBytes <= 0 || payload.totalBytes > BRIDGE_CONFIG.DEFAULT_BUFFER_CAP_BYTES * 2) {
      return false;
    }
    return true;
  }

  function rememberStreamLru(mseId, streamPayload) {
    if (knownStreams.has(mseId)) {
      knownStreams.delete(mseId);
    }
    knownStreams.set(mseId, streamPayload);
    while (knownStreams.size > BRIDGE_CONFIG.MAX_KNOWN_STREAMS) {
      const oldestKey = knownStreams.keys().next().value;
      knownStreams.delete(oldestKey);
    }
  }

  function handleHookMessage(data, sourcePort) {
    if (!data || data.source !== BRIDGE_CONFIG.WINDOW_SOURCE || !data.payload) {
      return;
    }
    const { kind, payload } = data;

    if (kind === BRIDGE_CONFIG.EVENTS.HANDSHAKE_ACK) {
      if (!handshakeAcked) {
        handshakeAcked = true;
        hookPort = sourcePort || hookPort;
        for (const port of candidatePorts) {
          if (port !== hookPort && typeof port.close === 'function') {
            try {
              port.close();
            } catch {
              // Ignore port close error
            }
          }
        }
        candidatePorts.clear();
        if (typeof window.removeEventListener === 'function') {
          window.removeEventListener('message', onWindowHandshakeReady, true);
        }
        flushPendingToHook();
      }
      return;
    }

    if (kind === BRIDGE_CONFIG.EVENTS.STREAM_UPDATED) {
      if (!captureEnabled || !isValidStreamUpdatePayload(payload)) {
        return;
      }
      rememberStreamLru(payload.mseId, payload);
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
      if (payload.track !== 'video' && payload.track !== 'audio') {
        pending.queueError = new Error('MSE_INVALID_TRACK');
        return;
      }
      if (pending.receivedBytes + payload.buffer.byteLength > BRIDGE_CONFIG.DEFAULT_BUFFER_CAP_BYTES) {
        pending.queueError = new Error('MSE_BUFFER_LIMIT');
        return;
      }
      pending.receivedBytes += payload.buffer.byteLength;
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
            videoMime: typeof payload.videoMime === 'string' ? payload.videoMime : '',
            audioMime: typeof payload.audioMime === 'string' ? payload.audioMime : ''
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
  }

  function initiateHandshake() {
    if (handshakeAcked || typeof MessageChannel !== 'function') {
      return;
    }
    const channel = new MessageChannel();
    const port1 = channel.port1;
    candidatePorts.add(port1);
    port1.onmessage = (portEvent) => {
      handleHookMessage(portEvent && portEvent.data, port1);
    };
    if (typeof port1.start === 'function') {
      port1.start();
    }
    try {
      window.postMessage({
        source: BRIDGE_CONFIG.WINDOW_SOURCE,
        kind: BRIDGE_CONFIG.EVENTS.HANDSHAKE_INIT,
        payload: {}
      }, '*', [channel.port2]);
    } catch {
      // Ignore postMessage failures on restricted contexts
    }
  }

  function onWindowHandshakeReady(event) {
    if (handshakeAcked || !event || event.source !== window || !event.data) {
      return;
    }
    if (
      event.data.source === BRIDGE_CONFIG.WINDOW_SOURCE &&
      event.data.kind === BRIDGE_CONFIG.EVENTS.HANDSHAKE_READY
    ) {
      initiateHandshake();
    }
  }

  window.addEventListener('message', onWindowHandshakeReady, true);
  initiateHandshake();

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
          receivedBytes: 0,
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
