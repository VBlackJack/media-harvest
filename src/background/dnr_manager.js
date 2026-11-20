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
import { isHttpUrl } from '../shared/media_classifier.js';

let dnrRuleCounter = 0;
let dnrCounterSeeded = false;
const downloadDnrRules = new Map();
const saverTabDnrRules = new Map();

function hasSessionStorage() {
  return (
    typeof chrome !== 'undefined' &&
    chrome.storage &&
    chrome.storage.session &&
    typeof chrome.storage.session.get === 'function' &&
    typeof chrome.storage.session.set === 'function'
  );
}

function dnrDownloadKey(downloadId) {
  return `${STORAGE_KEYS.DNR_DOWNLOAD_PREFIX}${downloadId}`;
}

function dnrSaverTabKey(tabId) {
  return `${STORAGE_KEYS.DNR_SAVER_TAB_PREFIX}${tabId}`;
}

/**
 * Seeds the in-memory rule ID counter above any active session rules surviving SW suspension.
 * @returns {Promise<void>}
 */
async function ensureDnrCounterSeeded() {
  if (dnrCounterSeeded) {
    return;
  }
  dnrCounterSeeded = true;
  if (
    typeof chrome === 'undefined' ||
    !chrome.declarativeNetRequest ||
    typeof chrome.declarativeNetRequest.getSessionRules !== 'function'
  ) {
    return;
  }
  try {
    const existing = await chrome.declarativeNetRequest.getSessionRules();
    if (!Array.isArray(existing)) {
      return;
    }
    let maxOffset = dnrRuleCounter;
    for (const rule of existing) {
      if (rule && typeof rule.id === 'number' && rule.id >= LIMITS.DNR_RULE_BASE_ID) {
        const offset = rule.id - LIMITS.DNR_RULE_BASE_ID;
        if (offset < LIMITS.DNR_MAX_RULE_OFFSET && offset > maxOffset) {
          maxOffset = offset;
        }
      }
    }
    dnrRuleCounter = maxOffset;
  } catch {
    // Ignore session rule lookup failures
  }
}

/**
 * Adds a temporary session declarativeNetRequest rule injecting Referer and Origin headers.
 * @param {string} targetUrl
 * @param {string} refererUrl
 * @param {object} [options={}]
 * @param {boolean} [options.extensionInitiatorOnly=false]
 * @param {number[]} [options.tabIds]
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
    await ensureDnrCounterSeeded();
    const targetOrigin = new URL(targetUrl).origin;
    const refererOrigin = new URL(refererUrl).origin;
    const extensionInitiatorOnly = Boolean(options && options.extensionInitiatorOnly);
    const runtimeId = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id ? chrome.runtime.id : '';
    const validTabIds = Array.isArray(options && options.tabIds)
      ? options.tabIds.filter((id) => typeof id === 'number' && id >= 0)
      : [];
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
    if (validTabIds.length > 0) {
      condition.tabIds = validTabIds;
    }
    dnrRuleCounter = (dnrRuleCounter + 1) % LIMITS.DNR_MAX_RULE_OFFSET;
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
 * Associates an active download ID with a temporary DNR rule ID across SW suspensions.
 * @param {number} downloadId
 * @param {number | null} ruleId
 */
export async function attachDownloadDnrRule(downloadId, ruleId) {
  if (typeof ruleId !== 'number') {
    return;
  }
  if (typeof downloadId === 'number') {
    downloadDnrRules.set(downloadId, ruleId);
    if (hasSessionStorage()) {
      await chrome.storage.session.set({ [dnrDownloadKey(downloadId)]: ruleId }).catch(() => {});
    }
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
  let ruleId = downloadDnrRules.get(downloadId);
  downloadDnrRules.delete(downloadId);
  if (hasSessionStorage()) {
    const key = dnrDownloadKey(downloadId);
    if (typeof ruleId !== 'number') {
      const stored = await chrome.storage.session.get(key).catch(() => ({}));
      if (stored && typeof stored[key] === 'number') {
        ruleId = stored[key];
      }
    }
    if (typeof chrome.storage.session.remove === 'function') {
      await chrome.storage.session.remove(key).catch(() => {});
    }
  }
  if (typeof ruleId === 'number') {
    await removeTemporaryRefererRule(ruleId);
  }
}

/**
 * Persists a Stream Saver tab's DNR rule and job ID so top-level tab close cleans both up.
 * @param {number} tabId
 * @param {number | null} ruleId
 * @param {string} [jobId='']
 * @returns {Promise<void>}
 */
export async function attachSaverTabDnrRule(tabId, ruleId, jobId = '') {
  if (typeof tabId !== 'number' || tabId < 0) {
    if (typeof ruleId === 'number') {
      await removeTemporaryRefererRule(ruleId);
    }
    return;
  }
  const entry = {
    ruleId: typeof ruleId === 'number' ? ruleId : null,
    jobId: typeof jobId === 'string' ? jobId : ''
  };
  saverTabDnrRules.set(tabId, entry);
  if (hasSessionStorage()) {
    await chrome.storage.session.set({ [dnrSaverTabKey(tabId)]: entry }).catch(() => {});
  }
}

/**
 * Cleans up any DNR rule and session job record attached to a closed Stream Saver tab.
 * @param {number} tabId
 * @returns {Promise<void>}
 */
export async function detachSaverTabDnrRule(tabId) {
  let entry = saverTabDnrRules.get(tabId) || null;
  saverTabDnrRules.delete(tabId);
  if (hasSessionStorage()) {
    const key = dnrSaverTabKey(tabId);
    if (!entry) {
      const stored = await chrome.storage.session.get(key).catch(() => ({}));
      if (stored && stored[key] && typeof stored[key] === 'object') {
        entry = stored[key];
      }
    }
    const keysToRemove = [key];
    if (entry && entry.jobId) {
      keysToRemove.push(`${STORAGE_KEYS.STREAM_SAVER_JOB_PREFIX}${entry.jobId}`);
    }
    if (typeof chrome.storage.session.remove === 'function') {
      await chrome.storage.session.remove(keysToRemove).catch(() => {});
    }
  }
  if (entry && typeof entry.ruleId === 'number') {
    await removeTemporaryRefererRule(entry.ruleId);
  }
}

/**
 * Removes orphaned temporary session DNR rules left behind by prior SW crashes or suspensions.
 * @returns {Promise<void>}
 */
export async function pruneOrphanedSessionDnrRules() {
  if (
    typeof chrome === 'undefined' ||
    !chrome.declarativeNetRequest ||
    typeof chrome.declarativeNetRequest.getSessionRules !== 'function' ||
    typeof chrome.declarativeNetRequest.updateSessionRules !== 'function'
  ) {
    return;
  }
  try {
    const existing = await chrome.declarativeNetRequest.getSessionRules();
    if (!Array.isArray(existing) || existing.length === 0) {
      return;
    }
    const activeRuleIds = new Set([...downloadDnrRules.values()]);
    for (const entry of saverTabDnrRules.values()) {
      if (entry && typeof entry.ruleId === 'number') {
        activeRuleIds.add(entry.ruleId);
      }
    }
    if (hasSessionStorage()) {
      const allSession = await chrome.storage.session.get(null).catch(() => ({}));
      for (const [k, v] of Object.entries(allSession || {})) {
        if (k.startsWith(STORAGE_KEYS.DNR_DOWNLOAD_PREFIX) && typeof v === 'number') {
          activeRuleIds.add(v);
        } else if (k.startsWith(STORAGE_KEYS.DNR_SAVER_TAB_PREFIX) && v && typeof v.ruleId === 'number') {
          activeRuleIds.add(v.ruleId);
        }
      }
    }
    const staleIds = existing
      .filter((r) => r && typeof r.id === 'number' && r.id >= LIMITS.DNR_RULE_BASE_ID && !activeRuleIds.has(r.id))
      .map((r) => r.id);
    if (staleIds.length > 0) {
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: staleIds });
    }
  } catch {
    // Ignore cleanup errors
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
