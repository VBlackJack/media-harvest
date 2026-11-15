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

import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildStreamPreviewUrl,
  closeCardPreview,
  refreshOpenPreview,
  revokeCardPreviewBlob,
  toggleVideoPreview
} from '../src/popup/preview_player.js';

const prevDocument = globalThis.document;
const prevFetch = globalThis.fetch;
const prevCreateObjectUrl = URL.createObjectURL;
const prevRevokeObjectUrl = URL.revokeObjectURL;

const revokedUrls = [];
let blobSeq = 0;

function createMockNode(tagName) {
  const classes = new Set();
  const attrs = new Map();
  const children = [];
  const listeners = new Map();
  const node = {
    tagName: tagName.toUpperCase(),
    textContent: '',
    src: '',
    poster: '',
    controls: false,
    autoplay: false,
    muted: false,
    playsInline: false,
    disabled: false,
    isConnected: true,
    children,
    paused: false,
    pause: () => {
      node.paused = true;
    },
    load: () => {},
    classList: {
      add: (...list) => list.forEach((c) => classes.add(c)),
      remove: (...list) => list.forEach((c) => classes.delete(c)),
      contains: (c) => classes.has(c)
    },
    setAttribute: (k, v) => attrs.set(k, String(v)),
    getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
    removeAttribute: (k) => {
      if (k === 'src') {
        node.src = '';
      }
      attrs.delete(k);
    },
    addEventListener: (ev, fn) => listeners.set(ev, fn),
    appendChild: (c) => children.push(c),
    replaceChildren: (...nodes) => {
      children.length = 0;
      children.push(...nodes);
    },
    querySelector: (sel) => children.find((c) => c.tagName === sel.toUpperCase()) || null
  };
  Object.defineProperty(node, 'className', {
    get: () => Array.from(classes).join(' '),
    set: (val) => {
      classes.clear();
      for (const part of String(val).split(/\s+/).filter(Boolean)) {
        classes.add(part);
      }
    }
  });
  return node;
}

beforeEach(() => {
  revokedUrls.length = 0;
  blobSeq = 0;
  globalThis.document = {
    createElement: (tag) => createMockNode(tag)
  };
  URL.createObjectURL = () => {
    blobSeq += 1;
    return `blob:preview-test/${blobSeq}`;
  };
  URL.revokeObjectURL = (url) => revokedUrls.push(url);
});

after(() => {
  globalThis.document = prevDocument;
  globalThis.fetch = prevFetch;
  URL.createObjectURL = prevCreateObjectUrl;
  URL.revokeObjectURL = prevRevokeObjectUrl;
});

test('toggleVideoPreview opens DASH fMP4 preview clip, updates ARIA state, and revokes blob on close', async () => {
  globalThis.fetch = async (url) => {
    const key = String(url);
    if (key.endsWith('manifest.mpd')) {
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        text: async () => `
          <MPD type="static" mediaPresentationDuration="PT8S">
            <Period>
              <AdaptationSet mimeType="video/mp4">
                <SegmentTemplate timescale="1" duration="4" initialization="init.mp4" media="seg-$Number$.m4s" startNumber="1"/>
                <Representation id="sd" bandwidth="400000" width="640" height="360"/>
              </AdaptationSet>
            </Period>
          </MPD>`
      };
    }
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer
    };
  };

  const thumbBtn = createMockNode('button');
  thumbBtn.setAttribute('aria-expanded', 'false');
  const previewBtn = createMockNode('button');
  const previewBox = createMockNode('div');
  previewBox.classList.add('hidden');
  const qualitySelect = createMockNode('select');
  qualitySelect.classList.add('hidden');
  const card = createMockNode('article');

  const entry = {
    item: {
      url: 'https://cdn.example.com/vod/manifest.mpd',
      isStream: true,
      poster: 'https://cdn.example.com/vod/poster.jpg'
    },
    card,
    thumbEl: thumbBtn,
    previewBtn,
    previewBox,
    qualitySelect,
    previewBlobUrl: ''
  };

  await toggleVideoPreview(entry);
  assert.equal(previewBox.classList.contains('hidden'), false);
  assert.equal(entry.previewBlobUrl, 'blob:preview-test/1');
  assert.equal(thumbBtn.getAttribute('aria-expanded'), 'true');
  assert.equal(previewBtn.textContent, 'popup_action_hide_preview');
  const videoNode = previewBox.querySelector('video');
  assert.ok(videoNode);
  assert.equal(videoNode.src, 'blob:preview-test/1');

  await toggleVideoPreview(entry);
  assert.equal(previewBox.classList.contains('hidden'), true);
  assert.deepEqual(revokedUrls, ['blob:preview-test/1']);
  assert.equal(entry.previewBlobUrl, '');
  assert.equal(thumbBtn.getAttribute('aria-expanded'), 'false');
  assert.equal(previewBtn.textContent, 'popup_action_preview');
});

test('buildStreamPreviewUrl rejects dynamic live DASH streams and encrypted HLS cleanly', async () => {
  globalThis.fetch = async (url) => {
    if (String(url).includes('live')) {
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        text: async () => '<MPD type="dynamic"><Period/></MPD>'
      };
    }
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => '#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://example.com/key"\n#EXTINF:2.0,\nseg.ts'
    };
  };

  await assert.rejects(
    buildStreamPreviewUrl('https://cdn.example.com/live/manifest.mpd', 'https://cdn.example.com/live/manifest.mpd'),
    /LIVE_STREAM/
  );
  await assert.rejects(
    buildStreamPreviewUrl('https://cdn.example.com/hls/secret.m3u8', 'https://cdn.example.com/hls/secret.m3u8'),
    /ENCRYPTED_STREAM/
  );

  const orphanEntry = { previewBox: createMockNode('div'), previewBlobUrl: 'blob:preview-test/9' };
  closeCardPreview(orphanEntry);
  assert.deepEqual(revokedUrls, ['blob:preview-test/9']);
  revokeCardPreviewBlob(orphanEntry);
});

test('toggleVideoPreview plays audio cards inline, rejects live HLS, and refreshOpenPreview reloads open players', async () => {
  const audioEntry = {
    item: {
      url: 'https://cdn.example.com/podcast.mp3',
      type: 'audio',
      isStream: false
    },
    card: createMockNode('article'),
    thumbEl: createMockNode('button'),
    previewBtn: createMockNode('button'),
    previewBox: createMockNode('div'),
    qualitySelect: createMockNode('select'),
    previewBlobUrl: ''
  };
  audioEntry.previewBox.classList.add('hidden');
  audioEntry.qualitySelect.classList.add('hidden');

  await toggleVideoPreview(audioEntry);
  const audioNode = audioEntry.previewBox.querySelector('audio');
  assert.ok(audioNode);
  assert.equal(audioNode.src, 'https://cdn.example.com/podcast.mp3');
  assert.equal(audioEntry.previewBtn.textContent, 'popup_action_hide_preview');

  await toggleVideoPreview(audioEntry);
  assert.equal(audioNode.paused, true);
  assert.equal(audioEntry.previewBox.classList.contains('hidden'), true);

  // Live HLS media playlist without #EXT-X-ENDLIST is rejected cleanly
  globalThis.fetch = async (url) => {
    const key = String(url);
    if (key.includes('live.m3u8')) {
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        text: async () => '#EXTM3U\n#EXTINF:2.0,\nseg_live.ts'
      };
    }
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => ''
    };
  };
  await assert.rejects(
    buildStreamPreviewUrl('https://cdn.example.com/hls/live.m3u8', 'https://cdn.example.com/hls/live.m3u8'),
    /LIVE_STREAM/
  );

  // refreshOpenPreview reopens already-visible preview player with updated direct video URL
  const videoEntry = {
    item: {
      url: 'https://cdn.example.com/video.mp4',
      type: 'video',
      isStream: false
    },
    card: createMockNode('article'),
    thumbEl: createMockNode('button'),
    previewBtn: createMockNode('button'),
    previewBox: createMockNode('div'),
    qualitySelect: createMockNode('select'),
    previewBlobUrl: ''
  };
  videoEntry.previewBox.classList.add('hidden');
  videoEntry.qualitySelect.classList.add('hidden');
  await toggleVideoPreview(videoEntry);
  videoEntry.item.url = 'https://cdn.example.com/video_hd.mp4';
  await refreshOpenPreview(videoEntry);
  assert.equal(videoEntry.previewBox.querySelector('video').src, 'https://cdn.example.com/video_hd.mp4');
});
