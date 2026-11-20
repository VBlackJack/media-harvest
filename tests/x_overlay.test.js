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
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(import.meta.dirname, '..');
const OVERLAY_COMMON_CODE = fs.readFileSync(path.join(ROOT, 'src/content/overlay_common.js'), 'utf8');
const OVERLAY_CODE = fs.readFileSync(path.join(ROOT, 'src/content/x_overlay.js'), 'utf8');

function createDomHarness({ initialEnableXOverlay = true } = {}) {
  class FakeElement {
    constructor(tagName) {
      this.tagName = tagName.toUpperCase();
      this.children = [];
      this.parentNode = null;
      this.attributes = new Map();
      this.listeners = new Map();
      this.textContent = '';
      this.className = '';
      this.disabled = false;
      this.href = '';
      this.src = '';
      this.classList = {
        add: (...names) => {
          const set = new Set(this.className.split(/\s+/).filter(Boolean));
          names.forEach((n) => set.add(n));
          this.className = Array.from(set).join(' ');
        },
        remove: (...names) => {
          const rm = new Set(names);
          this.className = this.className.split(/\s+/).filter((n) => n && !rm.has(n)).join(' ');
        },
        toggle: (name, force) => {
          const has = this.classList.contains(name);
          const next = typeof force === 'boolean' ? force : !has;
          if (next) {
            this.classList.add(name);
          } else {
            this.classList.remove(name);
          }
          return next;
        },
        contains: (name) => this.className.split(/\s+/).includes(name)
      };
    }

    setAttribute(key, value) {
      this.attributes.set(key, String(value));
    }

    getAttribute(key) {
      return this.attributes.has(key) ? this.attributes.get(key) : null;
    }

    hasAttribute(key) {
      return this.attributes.has(key);
    }

    removeAttribute(key) {
      this.attributes.delete(key);
    }

    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    }

    append(...nodes) {
      nodes.forEach((node) => this.appendChild(node));
    }

    remove() {
      if (!this.parentNode) {
        return;
      }
      this.parentNode.children = this.parentNode.children.filter((c) => c !== this);
      this.parentNode = null;
    }

    addEventListener(type, fn) {
      if (!this.listeners.has(type)) {
        this.listeners.set(type, []);
      }
      this.listeners.get(type).push(fn);
    }

    async trigger(type) {
      const event = { preventDefault() {}, stopPropagation() {} };
      for (const fn of this.listeners.get(type) || []) {
        await fn(event);
      }
    }

    closest(selector) {
      let cur = this;
      while (cur) {
        if (matchesSimpleSelector(cur, selector)) {
          return cur;
        }
        cur = cur.parentNode;
      }
      return null;
    }

    querySelectorAll(selector) {
      const out = [];
      const visit = (node) => {
        for (const child of node.children) {
          if (matchesSimpleSelector(child, selector)) {
            out.push(child);
          }
          visit(child);
        }
      };
      visit(this);
      return out;
    }
  }

  function matchesSimpleSelector(el, selector) {
    if (selector === 'article[data-testid="tweet"]') {
      return el.tagName === 'ARTICLE' && el.getAttribute('data-testid') === 'tweet';
    }
    if (selector === 'video') {
      return el.tagName === 'VIDEO';
    }
    if (selector === '[role="group"]') {
      return el.getAttribute('role') === 'group';
    }
    if (selector === 'a[href*="/status/"]') {
      return el.tagName === 'A' && (el.getAttribute('href') || '').includes('/status/');
    }
    if (selector === '.mh-x-download-btn') {
      return el.classList.contains('mh-x-download-btn');
    }
    if (selector === '.mh-x-quality-wrap') {
      return el.classList.contains('mh-x-quality-wrap');
    }
    if (selector === '.mh-x-quality-toggle') {
      return el.classList.contains('mh-x-quality-toggle');
    }
    if (selector === '.mh-x-quality-option') {
      return el.classList.contains('mh-x-quality-option');
    }
    if (selector === '[data-media-harvest-attached]') {
      return el.hasAttribute('data-media-harvest-attached');
    }
    return false;
  }

  const body = new FakeElement('body');
  const article = new FakeElement('article');
  article.setAttribute('data-testid', 'tweet');

  const statusLink = new FakeElement('a');
  statusLink.setAttribute('href', 'https://x.com/PunchingCat/status/2121651904099078267');
  const video = new FakeElement('video');
  video.setAttribute('poster', 'https://pbs.twimg.com/ext_tw_video_thumb/2121651904099078267/pu/img/a.jpg');
  video.src = 'https://video.twimg.com/clip.mp4';
  const actionBar = new FakeElement('div');
  actionBar.setAttribute('role', 'group');

  article.append(statusLink, video, actionBar);
  body.appendChild(article);

  const storageListeners = [];
  const runtimeMessageListeners = [];
  const sentMessages = [];
  const observerState = { observeCalls: 0, disconnectCalls: 0 };
  let sendMessageResponder = async (msg) => {
    sentMessages.push(msg);
    return { ok: true, downloadId: 1 };
  };

  class FakeMutationObserver {
    observe() {
      observerState.observeCalls += 1;
    }
    disconnect() {
      observerState.disconnectCalls += 1;
    }
  }

  const context = {
    document: {
      body,
      createElement: (tag) => new FakeElement(tag),
      createElementNS: (_ns, tag) => new FakeElement(tag),
      querySelectorAll: (sel) => body.querySelectorAll(sel)
    },
    MutationObserver: FakeMutationObserver,
    setTimeout,
    clearTimeout,
    chrome: {
      i18n: {
        getMessage: (key, subs) => (Array.isArray(subs) && subs.length ? `${key}:${subs.join(',')}` : key)
      },
      runtime: {
        onMessage: {
          addListener: (fn) => runtimeMessageListeners.push(fn)
        },
        sendMessage: async (msg) => sendMessageResponder(msg)
      },
      storage: {
        sync: {
          get: async () => ({
            user_settings: { enableXOverlay: initialEnableXOverlay }
          })
        },
        onChanged: {
          addListener: (fn) => storageListeners.push(fn)
        }
      }
    }
  };

  vm.runInNewContext(OVERLAY_COMMON_CODE, context, { filename: 'overlay_common.js' });
  vm.runInNewContext(OVERLAY_CODE, context, { filename: 'x_overlay.js' });
  return {
    body,
    actionBar,
    sentMessages,
    storageListeners,
    runtimeMessageListeners,
    observerState,
    setResponder: (fn) => {
      sendMessageResponder = fn;
    }
  };
}

test('x_overlay attaches inline button on tweet video and toggles live via storage.onChanged', async () => {
  const harness = createDomHarness({ initialEnableXOverlay: true });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const buttons = harness.body.querySelectorAll('.mh-x-download-btn');
  assert.equal(buttons.length, 1);
  assert.equal(harness.observerState.observeCalls, 1);

  await buttons[0].trigger('click');
  assert.equal(harness.sentMessages.length, 1);
  assert.equal(harness.sentMessages[0].type, 'DOWNLOAD_TWEET_VIDEO');
  assert.equal(harness.sentMessages[0].payload.mediaId, '2121651904099078267');
  assert.equal(harness.sentMessages[0].payload.authorHandle, 'PunchingCat');

  // Toggle off live
  harness.storageListeners[0](
    { user_settings: { newValue: { enableXOverlay: false } } },
    'sync'
  );
  assert.equal(harness.body.querySelectorAll('.mh-x-download-btn').length, 0);
  assert.equal(harness.actionBar.hasAttribute('data-media-harvest-attached'), false);
  assert.equal(harness.observerState.disconnectCalls, 1);

  // Toggle back on live
  harness.storageListeners[0](
    { user_settings: { newValue: { enableXOverlay: true } } },
    'sync'
  );
  assert.equal(harness.body.querySelectorAll('.mh-x-download-btn').length, 1);
});

test('x_overlay stays inactive when enableXOverlay is false on initialization', async () => {
  const harness = createDomHarness({ initialEnableXOverlay: false });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(harness.body.querySelectorAll('.mh-x-download-btn').length, 0);
  assert.equal(harness.observerState.observeCalls, 0);
});

test('x_overlay displays specific error labels and supports stream progress cancellation', async () => {
  const harness = createDomHarness({ initialEnableXOverlay: true });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const btn = harness.body.querySelectorAll('.mh-x-download-btn')[0];
  harness.setResponder(async () => ({ ok: false, error: 'ENCRYPTED_STREAM' }));
  await btn.trigger('click');
  assert.equal(btn.children[1].textContent, 'x_btn_encrypted');
  assert.equal(btn.classList.contains('mh-is-error'), true);

  let finishDownload;
  let capturedReqId = '';
  harness.setResponder((msg) => {
    harness.sentMessages.push(msg);
    if (msg.type === 'DOWNLOAD_TWEET_VIDEO') {
      capturedReqId = msg.payload.requestId;
      return new Promise((resolve) => {
        finishDownload = resolve;
      });
    }
    if (msg.type === 'CANCEL_DOWNLOAD') {
      finishDownload({ ok: false, error: 'DOWNLOAD_CANCELLED' });
    }
    return Promise.resolve({ ok: true });
  });

  const pendingClick = btn.trigger('click');
  await new Promise((resolve) => setTimeout(resolve, 10));
  for (const listener of harness.runtimeMessageListeners) {
    listener({ type: 'DOWNLOAD_PROGRESS', requestId: capturedReqId, done: 3, total: 10 });
  }
  assert.equal(btn.children[1].textContent, 'x_btn_progress:3,10');
  assert.equal(btn.disabled, false);

  await btn.trigger('click');
  await pendingClick;
  assert.ok(harness.sentMessages.some((m) => m.type === 'CANCEL_DOWNLOAD' && m.requestId === capturedReqId));
  assert.equal(btn.children[1].textContent, 'x_btn_cancelled');
  assert.equal(btn.classList.contains('mh-is-error'), false);
});

test('x_overlay quick quality/audio menu forwards qualityPreference and audioOnly options', async () => {
  const harness = createDomHarness({ initialEnableXOverlay: true });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const wrap = harness.body.querySelectorAll('.mh-x-quality-wrap')[0];
  const toggle = harness.body.querySelectorAll('.mh-x-quality-toggle')[0];
  const options = harness.body.querySelectorAll('.mh-x-quality-option');
  assert.ok(wrap && toggle);
  assert.equal(options.length, 3);

  await toggle.trigger('click');
  assert.equal(wrap.classList.contains('mh-is-open'), true);

  await options[1].trigger('click');
  assert.equal(wrap.classList.contains('mh-is-open'), false);
  assert.equal(harness.sentMessages.at(-1).payload.qualityPreference, 'lowest');
  assert.equal(harness.sentMessages.at(-1).payload.audioOnly, undefined);

  await options[2].trigger('click');
  assert.equal(harness.sentMessages.at(-1).payload.audioOnly, true);

  harness.storageListeners[0](
    { user_settings: { newValue: { enableXOverlay: false } } },
    'sync'
  );
  assert.equal(harness.body.querySelectorAll('.mh-x-quality-wrap').length, 0);
});
