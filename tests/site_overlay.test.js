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
const SITE_OVERLAY_CODE = fs.readFileSync(path.join(ROOT, 'src/content/site_overlay.js'), 'utf8');

function createSiteHarness({
  hostname = 'www.youtube.com',
  enableSocialOverlay = true,
  enableGenericVideoOverlay = true,
  rectWidth = 640,
  rectHeight = 360,
  videoSrc = 'https://cdn.example.com/video.mp4'
} = {}) {
  class FakeElement {
    constructor(tagName) {
      this.tagName = tagName.toUpperCase();
      this.children = [];
      this.parentElement = null;
      this.parentNode = null;
      this.attributes = new Map();
      this.listeners = new Map();
      this.textContent = '';
      this.className = '';
      this.disabled = false;
      this.currentSrc = '';
      this.src = '';
      this.videoWidth = 1280;
      this.videoHeight = 720;
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
          const has = this.className.split(/\s+/).includes(name);
          if (force === undefined ? !has : force) {
            this.classList.add(name);
          } else {
            this.classList.remove(name);
          }
        },
        contains: (name) => this.className.split(/\s+/).includes(name)
      };
    }

    append(...nodes) {
      for (const node of nodes) {
        this.appendChild(node);
      }
    }

    appendChild(node) {
      node.parentElement = this;
      node.parentNode = this;
      this.children.push(node);
      return node;
    }

    remove() {
      if (this.parentNode) {
        this.parentNode.children = this.parentNode.children.filter((c) => c !== this);
        this.parentNode = null;
        this.parentElement = null;
      }
    }

    setAttribute(k, v) {
      this.attributes.set(k, String(v));
    }

    getAttribute(k) {
      return this.attributes.get(k) ?? null;
    }

    hasAttribute(k) {
      return this.attributes.has(k);
    }

    removeAttribute(k) {
      this.attributes.delete(k);
    }

    addEventListener(ev, fn) {
      this.listeners.set(ev, fn);
    }

    dispatchEvent(ev) {
      const fn = this.listeners.get(ev.type);
      if (fn) {
        return fn(ev);
      }
      return undefined;
    }

    getBoundingClientRect() {
      return { width: rectWidth, height: rectHeight };
    }

    closest() {
      return this.parentElement;
    }

    querySelector(sel) {
      if (sel === 'h1' || sel === 'h1.ytd-watch-metadata') {
        return this.titleNode || null;
      }
      return null;
    }
  }

  const playerHost = new FakeElement('div');
  playerHost.titleNode = Object.assign(new FakeElement('h1'), { textContent: 'Demo Social Video' });
  const video = new FakeElement('video');
  video.currentSrc = videoSrc;
  playerHost.appendChild(video);

  const storageListeners = [];
  const runtimeListeners = [];
  const sentMessages = [];
  let responder = async () => ({ ok: true, downloadId: 1 });

  const doc = {
    title: 'YouTube Watch Page',
    body: new FakeElement('body'),
    createElement: (tag) => new FakeElement(tag),
    createElementNS: (_ns, tag) => new FakeElement(tag),
    querySelectorAll: (sel) => {
      if (sel === 'video') {
        return [video];
      }
      if (sel === '.mh-site-download-btn') {
        return playerHost.children.filter((c) => c.classList.contains('mh-site-download-btn'));
      }
      if (sel === '.mh-site-quality-wrap') {
        return playerHost.children.filter((c) => c.classList.contains('mh-site-quality-wrap'));
      }
      if (sel === '[data-mh-site-attached]') {
        return playerHost.hasAttribute('data-mh-site-attached') ? [playerHost] : [];
      }
      return [];
    }
  };
  doc.body.appendChild(playerHost);

  class FakeMutationObserver {
    observe() {}
    disconnect() {}
  }

  const sandbox = {
    window: {
      location: {
        hostname,
        href: `https://${hostname}/watch?v=abc`
      }
    },
    document: doc,
    MutationObserver: FakeMutationObserver,
    chrome: {
      i18n: {
        getMessage: (key) => key
      },
      storage: {
        sync: {
          get: (_key, cb) => cb({ user_settings: { enableSocialOverlay, enableGenericVideoOverlay } })
        },
        onChanged: {
          addListener: (fn) => storageListeners.push(fn)
        }
      },
      runtime: {
        sendMessage: async (msg) => {
          sentMessages.push(msg);
          return responder(msg);
        },
        onMessage: {
          addListener: (fn) => runtimeListeners.push(fn)
        }
      }
    },
    setTimeout,
    clearTimeout,
    WeakMap,
    Map,
    Math,
    Date
  };

  vm.runInNewContext(SITE_OVERLAY_CODE, sandbox, { filename: 'site_overlay.js' });

  return {
    playerHost,
    sentMessages,
    storageListeners,
    runtimeListeners,
    setResponder: (fn) => {
      responder = fn;
    }
  };
}

test('site_overlay attaches button on supported host, sends DOWNLOAD_SITE_VIDEO, and toggles live', async () => {
  const harness = createSiteHarness({ hostname: 'www.youtube.com', enableSocialOverlay: true });
  const btns = harness.playerHost.children.filter((c) => c.classList.contains('mh-site-download-btn'));
  assert.equal(btns.length, 1);

  await btns[0].dispatchEvent({
    type: 'click',
    preventDefault: () => {},
    stopPropagation: () => {}
  });
  assert.equal(harness.sentMessages.length, 1);
  assert.equal(harness.sentMessages[0].type, 'DOWNLOAD_SITE_VIDEO');
  assert.equal(harness.sentMessages[0].payload.siteId, 'youtube');
  assert.equal(harness.sentMessages[0].payload.title, 'Demo Social Video');

  for (const fn of harness.storageListeners) {
    fn({ user_settings: { newValue: { enableSocialOverlay: false } } }, 'sync');
  }
  assert.equal(harness.playerHost.children.some((c) => c.classList.contains('mh-site-download-btn')), false);
});

test('site_overlay excludes x.com, supports generic HTML5 players with size threshold, and respects toggles', async () => {
  const xExcluded = createSiteHarness({ hostname: 'x.com', enableSocialOverlay: true, enableGenericVideoOverlay: true });
  assert.equal(xExcluded.playerHost.children.some((c) => c.classList.contains('mh-site-download-btn')), false);

  const tinyGeneric = createSiteHarness({
    hostname: 'example.com',
    rectWidth: 180,
    rectHeight: 100,
    enableGenericVideoOverlay: true
  });
  assert.equal(tinyGeneric.playerHost.children.some((c) => c.classList.contains('mh-site-download-btn')), false);

  const genericDisabled = createSiteHarness({ hostname: 'example.com', enableGenericVideoOverlay: false });
  assert.equal(genericDisabled.playerHost.children.some((c) => c.classList.contains('mh-site-download-btn')), false);

  const genericActive = createSiteHarness({
    hostname: 'example.com',
    enableGenericVideoOverlay: true,
    videoSrc: 'blob:https://example.com/stream-99'
  });
  const btns = genericActive.playerHost.children.filter((c) => c.classList.contains('mh-site-download-btn'));
  assert.equal(btns.length, 1);
  await btns[0].dispatchEvent({
    type: 'click',
    preventDefault: () => {},
    stopPropagation: () => {}
  });
  assert.equal(genericActive.sentMessages[0].payload.siteId, 'generic');
  assert.equal(genericActive.sentMessages[0].payload.blobUrl, 'blob:https://example.com/stream-99');

  const disabled = createSiteHarness({ hostname: 'www.reddit.com', enableSocialOverlay: false });
  assert.equal(disabled.playerHost.children.some((c) => c.classList.contains('mh-site-download-btn')), false);
});

test('site_overlay quick quality/audio menu sends lowest quality or audioOnly and cleans up when toggled off', async () => {
  const harness = createSiteHarness({ hostname: 'www.youtube.com', enableSocialOverlay: true });
  const wrap = harness.playerHost.children.find((c) => c.classList.contains('mh-site-quality-wrap'));
  assert.ok(wrap);
  const [toggle, menu] = wrap.children;
  assert.equal(menu.children.length, 3);

  await toggle.dispatchEvent({ type: 'click', preventDefault: () => {}, stopPropagation: () => {} });
  assert.equal(wrap.classList.contains('mh-is-open'), true);

  await menu.children[1].dispatchEvent({ type: 'click', preventDefault: () => {}, stopPropagation: () => {} });
  assert.equal(wrap.classList.contains('mh-is-open'), false);
  assert.equal(harness.sentMessages.at(-1).payload.qualityPreference, 'lowest');

  await menu.children[2].dispatchEvent({ type: 'click', preventDefault: () => {}, stopPropagation: () => {} });
  assert.equal(harness.sentMessages.at(-1).payload.audioOnly, true);

  for (const fn of harness.storageListeners) {
    fn({ user_settings: { newValue: { enableSocialOverlay: false } } }, 'sync');
  }
  assert.equal(harness.playerHost.children.some((c) => c.classList.contains('mh-site-quality-wrap')), false);
});
