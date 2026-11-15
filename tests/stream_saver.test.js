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
import { STORAGE_KEYS } from '../src/config/constants.js';
import {
  createStreamSaverController,
  streamPlaylistToWritable,
  streamProgressiveResponseToWritable
} from '../src/saver/stream_saver.js';

function createMemoryWritable() {
  const chunks = [];
  let closed = false;
  let aborted = false;
  return {
    chunks,
    get closed() { return closed; },
    get aborted() { return aborted; },
    async write(chunk) {
      chunks.push(new Uint8Array(chunk));
    },
    async close() {
      closed = true;
    },
    async abort() {
      aborted = true;
    }
  };
}

test('streamProgressiveResponseToWritable streams readable body chunks directly to writable', async () => {
  const writable = createMemoryWritable();
  const encoder = new TextEncoder();
  const bodyChunks = [encoder.encode('HELLO_'), encoder.encode('STREAM')];
  let idx = 0;
  const mockFetch = async () => ({
    ok: true,
    status: 200,
    body: {
      getReader() {
        return {
          async read() {
            if (idx < bodyChunks.length) {
              const value = bodyChunks[idx];
              idx += 1;
              return { value, done: false };
            }
            return { value: undefined, done: true };
          },
          async cancel() {}
        };
      }
    }
  });

  const written = await streamProgressiveResponseToWritable('https://cdn.example.com/huge.mp4', writable, {
    fetchFn: mockFetch
  });

  assert.equal(written, 12);
  const merged = Buffer.concat(writable.chunks.map((c) => Buffer.from(c))).toString('utf8');
  assert.equal(merged, 'HELLO_STREAM');
});

test('streamPlaylistToWritable resolves master HLS, streams segments in order, and rejects DRM', async () => {
  const writable = createMemoryWritable();
  const progressEvents = [];
  const masterM3u8 = [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=800000',
    'low.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=3200000',
    'high.m3u8'
  ].join('\n');
  const mediaM3u8 = [
    '#EXTM3U',
    '#EXT-X-MAP:URI="init.mp4"',
    '#EXTINF:4.0,',
    'seg1.m4s',
    '#EXTINF:4.0,',
    'seg2.m4s',
    '#EXT-X-ENDLIST'
  ].join('\n');

  const responses = new Map([
    ['https://cdn.example.com/master.m3u8', { text: masterM3u8 }],
    ['https://cdn.example.com/high.m3u8', { text: mediaM3u8 }],
    ['https://cdn.example.com/init.mp4', { buf: new Uint8Array([1, 2, 3]).buffer }],
    ['https://cdn.example.com/seg1.m4s', { buf: new Uint8Array([4, 5]).buffer }],
    ['https://cdn.example.com/seg2.m4s', { buf: new Uint8Array([6, 7, 8, 9]).buffer }]
  ]);

  const mockFetch = async (url) => {
    const entry = responses.get(url);
    if (!entry) {
      return { ok: false, status: 404 };
    }
    return {
      ok: true,
      status: 200,
      async text() { return entry.text; },
      async arrayBuffer() { return entry.buf; }
    };
  };

  const totalBytes = await streamPlaylistToWritable({
    url: 'https://cdn.example.com/master.m3u8',
    playlistUrl: 'https://cdn.example.com/master.m3u8',
    isStream: true,
    qualityPreference: 'best',
    concurrency: 2
  }, writable, {
    fetchFn: mockFetch,
    onProgress: (done, total, bytes) => progressEvents.push({ done, total, bytes })
  });

  assert.equal(totalBytes, 9);
  assert.deepEqual(Array.from(Buffer.concat(writable.chunks.map((c) => Buffer.from(c)))), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(progressEvents.length, 3);
  assert.deepEqual(progressEvents[2], { done: 3, total: 3, bytes: 9 });

  const drmWritable = createMemoryWritable();
  await assert.rejects(
    () => streamPlaylistToWritable({
      url: 'https://cdn.example.com/drm.m3u8',
      playlistUrl: 'https://cdn.example.com/drm.m3u8',
      isStream: true
    }, drmWritable, {
      fetchFn: async () => ({
        ok: true,
        status: 200,
        async text() {
          return '#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="https://keys.example.com/k"\n#EXTINF:4,\nseg.ts';
        }
      })
    }),
    /DRM_PROTECTED/
  );
});

function createFakeSaverEl() {
  const classes = new Set();
  const listeners = new Map();
  return {
    textContent: '',
    disabled: false,
    style: { width: '0%' },
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      toggle: (c, force) => (force ? classes.add(c) : classes.delete(c)),
      contains: (c) => classes.has(c)
    },
    addEventListener: (type, fn) => listeners.set(type, fn),
    dispatchEvent: async (ev) => {
      const fn = listeners.get(ev.type);
      if (fn) {
        await fn(ev);
      }
    }
  };
}

test('createStreamSaverController handles missing job, unsupported picker, and full File System Access save', async () => {
  const makeDoc = () => {
    const map = new Map([
      ['sourceUrl', createFakeSaverEl()],
      ['startBtn', createFakeSaverEl()],
      ['cancelBtn', createFakeSaverEl()],
      ['progressBar', createFakeSaverEl()],
      ['statusText', createFakeSaverEl()]
    ]);
    return {
      documentElement: { lang: '' },
      getElementById: (id) => map.get(id)
    };
  };

  // Missing job disables start button cleanly
  const missingDoc = makeDoc();
  const missingCtrl = createStreamSaverController({
    documentRef: missingDoc,
    windowRef: { location: { search: '' }, showSaveFilePicker: async () => ({}) },
    chromeApi: { storage: { session: { get: async () => ({}) } } },
    translateFn: (k) => k,
    getUiLanguageFn: () => 'en',
    applyTranslationsFn: () => {}
  });
  await missingCtrl.init();
  assert.equal(missingCtrl.els.startBtn.disabled, true);
  assert.equal(missingCtrl.els.statusText.textContent, 'saver_error_missing_job');

  // Full progressive stream save workflow
  const writable = createMemoryWritable();
  const okDoc = makeDoc();
  let pickedOptions = null;
  const jobId = 'saver_test_1';
  const okCtrl = createStreamSaverController({
    documentRef: okDoc,
    windowRef: {
      location: { search: `?jobId=${jobId}` },
      showSaveFilePicker: async (opts) => {
        pickedOptions = opts;
        return { createWritable: async () => writable };
      }
    },
    chromeApi: {
      storage: {
        session: {
          get: async (k) => ({
            [k]: {
              url: 'https://cdn.example.com/big.mp4',
              playlistUrl: 'https://cdn.example.com/big.mp4',
              isStream: false,
              suggestedFilename: 'big_movie.mp4'
            }
          })
        }
      }
    },
    fetchFn: async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => new Uint8Array([10, 20, 30, 40]).buffer
    }),
    translateFn: (k, args = []) => (args.length ? `${k}:${args.join(',')}` : k),
    getUiLanguageFn: () => 'en',
    applyTranslationsFn: () => {}
  });

  await okCtrl.init();
  assert.equal(okCtrl.els.sourceUrl.textContent, 'https://cdn.example.com/big.mp4');
  assert.equal(okCtrl.els.statusText.textContent, 'saver_status_ready');

  await okCtrl.handleStartClick();
  assert.deepEqual(pickedOptions, { suggestedName: 'big_movie.mp4' });
  assert.equal(writable.closed, true);
  assert.deepEqual(Array.from(writable.chunks[0]), [10, 20, 30, 40]);
  assert.equal(okCtrl.els.statusText.classList.contains('is-done'), true);
});
