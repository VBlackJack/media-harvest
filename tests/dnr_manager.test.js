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

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addTemporaryRefererRule,
  attachDownloadDnrRule,
  attachSaverTabDnrRule,
  detachDownloadDnrRule,
  detachSaverTabDnrRule,
  pruneOrphanedSessionDnrRules,
  removeTemporaryRefererRule,
  withTemporaryRefererRule
} from '../src/background/dnr_manager.js';

test('addTemporaryRefererRule rejects invalid schemes and handles missing chrome.declarativeNetRequest', async () => {
  const originalChrome = globalThis.chrome;
  try {
    delete globalThis.chrome;
    const noChrome = await addTemporaryRefererRule('https://example.com/v.mp4', 'https://example.com/watch');
    assert.equal(noChrome, null);

    globalThis.chrome = {
      declarativeNetRequest: {
        updateSessionRules: async () => {}
      }
    };
    const invalidTarget = await addTemporaryRefererRule('blob:https://example.com/abc', 'https://example.com/watch');
    assert.equal(invalidTarget, null);

    const invalidReferer = await addTemporaryRefererRule('https://example.com/v.mp4', 'javascript:alert(1)');
    assert.equal(invalidReferer, null);
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test('addTemporaryRefererRule, attach/detach, and withTemporaryRefererRule manage session rules cleanly', async () => {
  const originalChrome = globalThis.chrome;
  const addedRules = [];
  const removedRuleIds = [];

  globalThis.chrome = {
    runtime: { id: 'test_extension_id' },
    declarativeNetRequest: {
      updateSessionRules: async ({ addRules = [], removeRuleIds = [] }) => {
        addedRules.push(...addRules);
        removedRuleIds.push(...removeRuleIds);
      }
    }
  };

  try {
    const ruleId = await addTemporaryRefererRule(
      'https://cdn.example.com/video.mp4',
      'https://example.com/watch?v=1',
      { extensionInitiatorOnly: true }
    );
    assert.ok(typeof ruleId === 'number');
    assert.equal(addedRules.length, 1);
    assert.equal(addedRules[0].id, ruleId);
    assert.deepEqual(addedRules[0].condition.initiatorDomains, ['test_extension_id']);

    await attachDownloadDnrRule(1234, ruleId);
    await detachDownloadDnrRule(1234);
    assert.ok(removedRuleIds.includes(ruleId));

    // withTemporaryRefererRule executes task and removes rule
    let executed = false;
    await withTemporaryRefererRule(
      'https://cdn.example.com/part.mp4',
      'https://example.com/watch?v=2',
      async () => {
        executed = true;
      }
    );
    assert.equal(executed, true);
    assert.equal(addedRules.length, 2);
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test('dnr_manager persists saver tab rules and prunes orphaned session rules', async () => {
  const originalChrome = globalThis.chrome;
  const sessionStore = new Map();
  let activeSessionRules = [{ id: 9055, priority: 1 }, { id: 9056, priority: 1 }];

  globalThis.chrome = {
    runtime: { id: 'test_extension_id' },
    storage: {
      session: {
        get: async (key) => {
          if (key === null) {
            return Object.fromEntries(sessionStore.entries());
          }
          return { [key]: sessionStore.get(key) };
        },
        set: async (obj) => {
          for (const [k, v] of Object.entries(obj)) {
            sessionStore.set(k, v);
          }
        },
        remove: async (keys) => {
          for (const k of Array.isArray(keys) ? keys : [keys]) {
            sessionStore.delete(k);
          }
        }
      }
    },
    declarativeNetRequest: {
      getSessionRules: async () => [...activeSessionRules],
      updateSessionRules: async ({ addRules = [], removeRuleIds = [] }) => {
        activeSessionRules = activeSessionRules.filter((r) => !removeRuleIds.includes(r.id));
        activeSessionRules.push(...addRules);
      }
    }
  };

  try {
    sessionStore.set('stream_saver_job_job1', { jobId: 'job1' });
    await attachSaverTabDnrRule(42, 9055, 'job1');
    await pruneOrphanedSessionDnrRules();
    // 9055 is tracked by saver tab 42; 9056 is orphaned and pruned
    assert.deepEqual(activeSessionRules.map((r) => r.id), [9055]);

    await detachSaverTabDnrRule(42);
    assert.deepEqual(activeSessionRules, []);
    assert.equal(sessionStore.has('stream_saver_job_job1'), false);
  } finally {
    globalThis.chrome = originalChrome;
  }
});
