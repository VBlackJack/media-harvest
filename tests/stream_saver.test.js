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
  buildIsoBox,
  countTracksInInit,
  parseIsoBoxes,
  splitFmp4InitAndFragments
} from '../src/shared/fmp4_muxer.js';
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

test('streamPlaylistToWritable transmuxes MPEG-TS HLS segments incrementally into MP4 when Transmuxer is provided', async () => {
  const tsPlaylist = [
    '#EXTM3U',
    '#EXT-X-TARGETDURATION:4',
    '#EXTINF:4.0,',
    'https://cdn.example.com/seg0.ts',
    '#EXTINF:4.0,',
    'https://cdn.example.com/seg1.ts',
    '#EXT-X-ENDLIST'
  ].join('\n');

  const writable = createMemoryWritable();
  const progressEvents = [];
  class FakeTransmuxer {
    constructor() {
      this._handlers = [];
    }
    on(event, fn) {
      if (event === 'data') {
        this._handlers.push(fn);
      }
    }
    push(chunk) {
      this._pending = chunk;
    }
    flush() {
      if (this._pending) {
        const segment = {
          initSegment: new Uint8Array([0, 0, 0, 8, 0x66, 0x74, 0x79, 0x70]),
          data: new Uint8Array([0x6d, 0x64, this._pending[0]])
        };
        for (const fn of this._handlers) {
          fn(segment);
        }
        this._pending = null;
      }
    }
    dispose() {}
  }

  const res = await streamPlaylistToWritable(
    {
      url: 'https://cdn.example.com/index.m3u8',
      playlistUrl: 'https://cdn.example.com/index.m3u8',
      isStream: true,
      concurrency: 1
    },
    writable,
    {
      TransmuxerCtor: FakeTransmuxer,
      fetchFn: async (url) => {
        if (url.endsWith('.m3u8')) {
          return { ok: true, status: 200, text: async () => tsPlaylist };
        }
        const byteVal = url.endsWith('seg0.ts') ? 0xaa : 0xbb;
        return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([byteVal]).buffer };
      },
      onProgress: (done, total, bytes, isTransmuxed) => {
        progressEvents.push({ done, total, bytes, isTransmuxed });
      }
    }
  );

  assert.ok(res > 0);
  assert.equal(progressEvents.length, 2);
  assert.equal(progressEvents.every((p) => p.isTransmuxed === true), true);
  // initSegment emitted once (on seg0), plus both mdat-prefixed data segments
  assert.equal(writable.chunks.length, 3);
  assert.deepEqual(Array.from(writable.chunks[0]), [0, 0, 0, 8, 0x66, 0x74, 0x79, 0x70]);
  assert.deepEqual(Array.from(writable.chunks[1]), [0x6d, 0x64, 0xaa]);
  assert.deepEqual(Array.from(writable.chunks[2]), [0x6d, 0x64, 0xbb]);
});

function makeSaverFmp4Init(trackId) {
  const ftyp = buildIsoBox('ftyp', [new Uint8Array([0x69, 0x73, 0x6f, 0x6d])]);
  const mvhd = new Uint8Array(100);
  new DataView(mvhd.buffer).setUint32(96, trackId + 1, false);
  const tkhd = new Uint8Array(84);
  new DataView(tkhd.buffer).setUint32(12, trackId, false);
  const trex = new Uint8Array(24);
  new DataView(trex.buffer).setUint32(4, trackId, false);
  const moov = buildIsoBox('moov', [
    buildIsoBox('mvhd', [mvhd]),
    buildIsoBox('trak', [buildIsoBox('tkhd', [tkhd])]),
    buildIsoBox('mvex', [buildIsoBox('trex', [trex])])
  ]);
  const out = new Uint8Array(ftyp.byteLength + moov.byteLength);
  out.set(ftyp, 0);
  out.set(moov, ftyp.byteLength);
  return out;
}

function makeSaverFmp4Frag(trackId, fillByte) {
  const tfhd = new Uint8Array(12);
  new DataView(tfhd.buffer).setUint32(4, trackId, false);
  const moof = buildIsoBox('moof', [buildIsoBox('traf', [buildIsoBox('tfhd', [tfhd])])]);
  const mdat = buildIsoBox('mdat', [new Uint8Array([fillByte, fillByte])]);
  const out = new Uint8Array(moof.byteLength + mdat.byteLength);
  out.set(moof, 0);
  out.set(mdat, moof.byteLength);
  return out;
}

test('streamPlaylistToWritable streams dual-track fMP4 HLS master with separate audio into valid merged MP4', async () => {
  const writable = createMemoryWritable();
  const masterM3u8 = [
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Main",DEFAULT=YES,URI="audio.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1920x1080,AUDIO="aud"',
    'video.m3u8'
  ].join('\n');
  const videoM3u8 = ['#EXTM3U', '#EXT-X-MAP:URI="v_init.mp4"', '#EXTINF:2.0,', 'v1.m4s', '#EXT-X-ENDLIST'].join('\n');
  const audioM3u8 = ['#EXTM3U', '#EXT-X-MAP:URI="a_init.mp4"', '#EXTINF:2.0,', 'a1.m4s', '#EXT-X-ENDLIST'].join('\n');

  const vInit = makeSaverFmp4Init(1);
  const aInit = makeSaverFmp4Init(1);
  const vFrag = makeSaverFmp4Frag(1, 0xaa);
  const aFrag = makeSaverFmp4Frag(1, 0xbb);

  const mockResponses = new Map([
    ['https://cdn.example.com/dual/master.m3u8', { text: masterM3u8 }],
    ['https://cdn.example.com/dual/video.m3u8', { text: videoM3u8 }],
    ['https://cdn.example.com/dual/audio.m3u8', { text: audioM3u8 }],
    ['https://cdn.example.com/dual/v_init.mp4', { buf: vInit.buffer }],
    ['https://cdn.example.com/dual/a_init.mp4', { buf: aInit.buffer }],
    ['https://cdn.example.com/dual/v1.m4s', { buf: vFrag.buffer }],
    ['https://cdn.example.com/dual/a1.m4s', { buf: aFrag.buffer }]
  ]);

  const written = await streamPlaylistToWritable(
    {
      url: 'https://cdn.example.com/dual/master.m3u8',
      playlistUrl: 'https://cdn.example.com/dual/video.m3u8',
      isStream: true,
      concurrency: 2
    },
    writable,
    {
      fetchFn: async (url) => {
        const entry = mockResponses.get(url);
        return entry
          ? { ok: true, status: 200, text: async () => entry.text, arrayBuffer: async () => entry.buf }
          : { ok: false, status: 404 };
      }
    }
  );

  assert.ok(written > 0);
  const merged = Buffer.concat(writable.chunks.map((c) => Buffer.from(c)));
  const split = splitFmp4InitAndFragments(merged);
  assert.equal(countTracksInInit(split.initSegment), 2);
  assert.equal(split.fragments.length, 2);

  // Audio fragment must be rewritten to track_ID = 2
  const audioFragBoxes = parseIsoBoxes(split.fragments[1]);
  const aTraf = parseIsoBoxes(split.fragments[1], audioFragBoxes[0].start + 8, audioFragBoxes[0].end)[0];
  const aTfhd = parseIsoBoxes(split.fragments[1], aTraf.start + 8, aTraf.end)[0];
  assert.equal(
    new DataView(aTfhd.data.buffer, aTfhd.data.byteOffset, aTfhd.data.byteLength).getUint32(12, false),
    2
  );
});
