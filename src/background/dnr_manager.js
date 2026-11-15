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

import { LIMITS } from '../config/constants.js';
import { isHttpUrl } from '../shared/media_classifier.js';

let dnrRuleCounter = 0;
const downloadDnrRules = new Map();

/**
 * Adds a temporary session declarativeNetRequest rule injecting Referer and Origin headers.
 * @param {string} targetUrl
 * @param {string} refererUrl
 * @param {object} [options={}]
 * @param {boolean} [options.extensionInitiatorOnly=false]
 * @returns {Promise<number | null>}
 */
export async function addTemporaryRefererRule(targetUrl, refererUrl, options = {}) {
  if (
    !refererUrl ||
    !isHttpUrl(targetUrl) ||
    !isHttpUrl(refererUrl) ||
    typeof chrome === 'undefined' ||
    !chrome.declarativeNetRequest ||
    typeof chrome.declarativeNetRequest.updateSessionRules !== 'function'
  ) {
    return null;
  }
  try {
    const targetOrigin = new URL(targetUrl).origin;
    const refererOrigin = new URL(refererUrl).origin;
    const extensionInitiatorOnly = Boolean(options && options.extensionInitiatorOnly);
    const runtimeId = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id ? chrome.runtime.id : '';
    const condition = extensionInitiatorOnly && runtimeId
      ? {
          urlFilter: '*://*/*',
          initiatorDomains: [runtimeId],
          resourceTypes: ['xmlhttprequest', 'media', 'other']
        }
      : {
          urlFilter: `${targetOrigin}/*`,
          resourceTypes: ['xmlhttprequest', 'media', 'image', 'other']
        };
    dnrRuleCounter = (dnrRuleCounter + 1) % 100000;
    const ruleId = LIMITS.DNR_RULE_BASE_ID + dnrRuleCounter;
    await chrome.declarativeNetRequest.updateSessionRules({
      addRules: [{
        id: ruleId,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'Referer', operation: 'set', value: refererUrl },
            { header: 'Origin', operation: 'set', value: refererOrigin }
          ]
        },
        condition
      }],
      removeRuleIds: [ruleId]
    });
    return ruleId;
  } catch {
    return null;
  }
}

/**
 * Removes a temporary declarativeNetRequest session rule by ID.
 * @param {number | null} ruleId
 * @returns {Promise<void>}
 */
export async function removeTemporaryRefererRule(ruleId) {
  if (
    typeof ruleId !== 'number' ||
    typeof chrome === 'undefined' ||
    !chrome.declarativeNetRequest ||
    typeof chrome.declarativeNetRequest.updateSessionRules !== 'function'
  ) {
    return;
  }
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [ruleId]
  }).catch(() => {});
}

/**
 * Associates an active download ID with a temporary DNR rule ID.
 * @param {number} downloadId
 * @param {number | null} ruleId
 */
export async function attachDownloadDnrRule(downloadId, ruleId) {
  if (typeof ruleId !== 'number') {
    return;
  }
  if (typeof downloadId === 'number') {
    downloadDnrRules.set(downloadId, ruleId);
  } else {
    await removeTemporaryRefererRule(ruleId);
  }
}

/**
 * Cleans up and removes any DNR rule attached to a completed or interrupted download.
 * @param {number} downloadId
 * @returns {Promise<void>}
 */
export async function detachDownloadDnrRule(downloadId) {
  const ruleId = downloadDnrRules.get(downloadId);
  if (typeof ruleId === 'number') {
    downloadDnrRules.delete(downloadId);
    await removeTemporaryRefererRule(ruleId);
  }
}

/**
 * Executes an async task under a temporary Referer/Origin DNR session rule when needed.
 * @template T
 * @param {string} targetUrl
 * @param {string} refererUrl
 * @param {() => Promise<T>} task
 * @param {object} [options={ extensionInitiatorOnly: true }]
 * @returns {Promise<T>}
 */
export async function withTemporaryRefererRule(targetUrl, refererUrl, task, options = { extensionInitiatorOnly: true }) {
  const ruleId = await addTemporaryRefererRule(targetUrl, refererUrl, options);
  try {
    return await task();
  } finally {
    await removeTemporaryRefererRule(ruleId);
  }
}
