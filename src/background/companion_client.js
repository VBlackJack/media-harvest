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

import { MESSAGE_TYPES, NATIVE_HOST } from '../config/constants.js';
import { isHttpUrl } from '../shared/media_classifier.js';
import { loadSettings } from '../shared/settings.js';

const activeCompanionPorts = new Map();

/**
 * Probes the local Native Messaging companion host and reports yt-dlp/ffmpeg availability.
 * @returns {Promise<{ available: boolean, ytDlpVersion: string, ffmpegAvailable: boolean, error: string }>}
 */
export async function checkCompanionStatus() {
  if (!chrome.runtime || typeof chrome.runtime.sendNativeMessage !== 'function') {
    return { available: false, ytDlpVersion: '', ffmpegAvailable: false, error: 'UNAVAILABLE' };
  }
  try {
    const res = await chrome.runtime.sendNativeMessage(NATIVE_HOST.NAME, {
      action: NATIVE_HOST.ACTION_PING
    });
    return {
      available: Boolean(res && res.ok),
      ytDlpVersion: (res && res.ytDlpVersion) || '',
      ffmpegAvailable: Boolean(res && res.ffmpegAvailable),
      error: (res && res.error) || ''
    };
  } catch (err) {
    return {
      available: false,
      ytDlpVersion: '',
      ffmpegAvailable: false,
      error: (err && err.message) || 'COMPANION_UNAVAILABLE'
    };
  }
}

/**
 * Requests cancellation of an active Native Messaging companion download by URL.
 * @param {string} targetUrl
 */
export function cancelCompanionDownload(targetUrl) {
  const port = typeof targetUrl === 'string' && targetUrl ? activeCompanionPorts.get(targetUrl) : null;
  if (port && typeof port.postMessage === 'function') {
    try {
      port.postMessage({ action: NATIVE_HOST.ACTION_CANCEL });
    } catch {
      // Port may already be closed
    }
  }
}

/**
 * Delegates a URL or page URL download to the local yt-dlp/ffmpeg Native Messaging companion.
 * Uses connectNative for live progress streaming when available, with sendNativeMessage fallback.
 * @param {{ url: string, referer?: string, filename?: string, quality?: string, audioOnly?: boolean, audioFormat?: string }} payload
 * @returns {Promise<object>}
 */
export async function downloadWithCompanion(payload) {
  if (!payload || !isHttpUrl(payload.url)) {
    throw new Error('INVALID_URL');
  }
  const hasConnect = Boolean(chrome.runtime && typeof chrome.runtime.connectNative === 'function');
  const hasSend = Boolean(chrome.runtime && typeof chrome.runtime.sendNativeMessage === 'function');
  if (!hasConnect && !hasSend) {
    throw new Error('COMPANION_UNAVAILABLE');
  }
  const settings = await loadSettings().catch(() => ({}));
  const detectedCookieBrowser = typeof navigator !== 'undefined' && /Edg\//i.test(navigator.userAgent || '')
    ? 'edge'
    : 'chrome';
  const requestPayload = {
    action: NATIVE_HOST.ACTION_DOWNLOAD,
    url: payload.url,
    referer: typeof payload.referer === 'string' ? payload.referer : '',
    filename: typeof payload.filename === 'string' ? payload.filename : '',
    quality: typeof payload.quality === 'string' ? payload.quality : 'best',
    audioOnly: Boolean(payload.audioOnly),
    audioFormat: typeof payload.audioFormat === 'string' ? payload.audioFormat : 'mp3',
    cookiesBrowser: settings && settings.enableCompanionCookies ? detectedCookieBrowser : ''
  };

  if (hasConnect) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let port = null;
      const companionKey = payload.url;
      try {
        port = chrome.runtime.connectNative(NATIVE_HOST.NAME);
      } catch (err) {
        settled = true;
        reject(new Error((err && err.message) || 'COMPANION_FAILED'));
        return;
      }
      activeCompanionPorts.set(companionKey, port);

      const cleanup = () => {
        if (activeCompanionPorts.get(companionKey) === port) {
          activeCompanionPorts.delete(companionKey);
        }
        if (port && typeof port.disconnect === 'function') {
          try {
            port.disconnect();
          } catch {
            // Ignore disconnect error
          }
        }
      };

      port.onMessage.addListener((message) => {
        if (!message || typeof message !== 'object') {
          return;
        }
        if (message.event === NATIVE_HOST.EVENT_PROGRESS) {
          chrome.runtime.sendMessage({
            type: MESSAGE_TYPES.COMPANION_PROGRESS,
            url: payload.url,
            percent: Number.isFinite(message.percent) ? message.percent : 0
          }).catch(() => {
            // Popup may be closed
          });
          return;
        }
        if (message.event === NATIVE_HOST.EVENT_DONE || typeof message.ok === 'boolean') {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          if (message.ok) {
            resolve(message);
          } else {
            reject(new Error(message.error || 'COMPANION_FAILED'));
          }
        }
      });

      port.onDisconnect.addListener(() => {
        if (activeCompanionPorts.get(companionKey) === port) {
          activeCompanionPorts.delete(companionKey);
        }
        if (settled) {
          return;
        }
        settled = true;
        const runtimeErr = chrome.runtime && chrome.runtime.lastError && chrome.runtime.lastError.message;
        reject(new Error(runtimeErr || 'COMPANION_FAILED'));
      });

      port.postMessage({ ...requestPayload, streamProgress: true });
    });
  }

  const res = await chrome.runtime.sendNativeMessage(NATIVE_HOST.NAME, requestPayload);
  if (!res || !res.ok) {
    throw new Error((res && res.error) || 'COMPANION_FAILED');
  }
  return res;
}
