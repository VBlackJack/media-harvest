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
  detachDownloadDnrRule,
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
