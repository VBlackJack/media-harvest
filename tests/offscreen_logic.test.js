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
import { MESSAGE_TYPES } from '../src/config/constants.js';
import { buildIsoBox, countTracksInInit } from '../src/shared/fmp4_muxer.js';

const prevChrome = globalThis.chrome;
const prevFetch = globalThis.fetch;
const prevCreateObjectUrl = URL.createObjectURL;
const prevRevokeObjectUrl = URL.revokeObjectURL;

const messageHandlers = [];
const revokedUrls = [];
const createdBlobs = new Map();
let blobCounter = 0;

globalThis.chrome = {
  runtime: {
    sendMessage: async () => ({ ok: true }),
    onMessage: {
      addListener: (fn) => messageHandlers.push(fn)
    }
  }
};

URL.createObjectURL = (blob) => {
  blobCounter += 1;
  const url = `blob:test-offscreen/${blobCounter}`;
  createdBlobs.set(url, blob);
  return url;
};

URL.revokeObjectURL = (url) => {
  revokedUrls.push(url);
};

await import('../src/offscreen/offscreen.js');

function dispatchOffscreenMessage(msg) {
  return new Promise((resolve) => {
    let settled = false;
    const sendResponse = (resp) => {
      if (!settled) {
        settled = true;
        resolve(resp);
      }
    };
    for (const fn of messageHandlers) {
      const isAsync = fn(msg, {}, sendResponse);
      if (!isAsync && settled) {
        return;
      }
    }
  });
}

beforeEach(() => {
  revokedUrls.length = 0;
  createdBlobs.clear();
  globalThis.fetch = prevFetch;
});

after(() => {
  globalThis.chrome = prevChrome;
  globalThis.fetch = prevFetch;
  URL.createObjectURL = prevCreateObjectUrl;
  URL.revokeObjectURL = prevRevokeObjectUrl;
});

test('offscreen coalesces HTTP 200 byte-range fallback into a single fetch per URL and revokes blobs cleanly', async () => {
  const fullData = new Uint8Array(60);
  fullData.fill(0x11, 0, 20);
  fullData.fill(0x22, 20, 40);
  fullData.fill(0x33, 40, 60);

  let binaryFetches = 0;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('.m3u8')) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => [
          '#EXTM3U',
          '#EXT-X-MAP:URI="combined.mp4",BYTERANGE="20@0"',
          '#EXTINF:2.0,',
          '#EXT-X-BYTERANGE:20@20',
          'combined.mp4',
          '#EXTINF:2.0,',
          '#EXT-X-BYTERANGE:20',
          'combined.mp4',
          '#EXT-X-ENDLIST'
        ].join('\n')
      };
    }
    binaryFetches += 1;
    return {
      ok: true,
      status: 200,
      headers: { get: () => String(fullData.byteLength) },
      arrayBuffer: async () => fullData.slice().buffer
    };
  };

  const buildResp = await dispatchOffscreenMessage({
    target: 'offscreen',
    type: MESSAGE_TYPES.OFFSCREEN_BUILD_HLS_BLOB,
    requestId: 'offscreen-200-test',
    playlistUrl: 'https://cdn.example.com/hls/playlist.m3u8',
    originalUrl: 'https://cdn.example.com/hls/playlist.m3u8',
    concurrency: 4
  });

  assert.equal(buildResp.ok, true);
  assert.equal(binaryFetches, 1);
  assert.equal(buildResp.byteLength, 60);

  const revokeResp = await dispatchOffscreenMessage({
    target: 'offscreen',
    type: MESSAGE_TYPES.OFFSCREEN_REVOKE_BLOB,
    blobUrl: buildResp.blobUrl
  });
  assert.equal(revokeResp.ok, true);
  assert.deepEqual(revokedUrls, [buildResp.blobUrl]);
});

test('offscreen enforces MAX_HLS_BUFFER_BYTES via Content-Length rejection (STREAM_TOO_LARGE)', async () => {
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('.m3u8')) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => ['#EXTM3U', '#EXTINF:2.0,', 'huge.ts', '#EXT-X-ENDLIST'].join('\n')
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => String(600 * 1024 * 1024) },
      arrayBuffer: async () => new ArrayBuffer(8)
    };
  };

  const resp = await dispatchOffscreenMessage({
    target: 'offscreen',
    type: MESSAGE_TYPES.OFFSCREEN_BUILD_HLS_BLOB,
    requestId: 'offscreen-too-large',
    playlistUrl: 'https://cdn.example.com/hls/huge.m3u8',
    originalUrl: 'https://cdn.example.com/hls/huge.m3u8',
    concurrency: 1
  });

  assert.equal(resp.ok, false);
  assert.equal(resp.error, 'STREAM_TOO_LARGE');
});

function makeFullBoxPayload(version, bodySize) {
  const buf = new Uint8Array(4 + bodySize);
  buf[0] = version;
  return buf;
}

function makeFmp4Init(trackId) {
  const ftyp = buildIsoBox('ftyp', [new Uint8Array([0x69, 0x73, 0x6f, 0x6d])]);
  const mvhdPayload = makeFullBoxPayload(0, 96);
  new DataView(mvhdPayload.buffer).setUint32(96, trackId + 1, false);
  const tkhdPayload = makeFullBoxPayload(0, 80);
  new DataView(tkhdPayload.buffer).setUint32(12, trackId, false);
  const trexPayload = makeFullBoxPayload(0, 20);
  new DataView(trexPayload.buffer).setUint32(4, trackId, false);
  const moov = buildIsoBox('moov', [
    buildIsoBox('mvhd', [mvhdPayload]),
    buildIsoBox('trak', [buildIsoBox('tkhd', [tkhdPayload])]),
    buildIsoBox('mvex', [buildIsoBox('trex', [trexPayload])])
  ]);
  const out = new Uint8Array(ftyp.byteLength + moov.byteLength);
  out.set(ftyp, 0);
  out.set(moov, ftyp.byteLength);
  return out;
}

function makeMediaChunk(trackId, markerByte) {
  const tfhdPayload = makeFullBoxPayload(0, 8);
  new DataView(tfhdPayload.buffer).setUint32(4, trackId, false);
  const moof = buildIsoBox('moof', [buildIsoBox('traf', [buildIsoBox('tfhd', [tfhdPayload])])]);
  const mdat = buildIsoBox('mdat', [new Uint8Array([markerByte, markerByte])]);
  const out = new Uint8Array(moof.byteLength + mdat.byteLength);
  out.set(moof, 0);
  out.set(mdat, moof.byteLength);
  return out;
}

test('offscreen muxes separate DASH fMP4 video and audio tracks and rejects dynamic manifests', async () => {
  const vInit = makeFmp4Init(1);
  const vSeg = makeMediaChunk(1, 0xaa);
  const aInit = makeFmp4Init(1);
  const aSeg = makeMediaChunk(1, 0xbb);

  const mpdXml = `
    <MPD type="static" mediaPresentationDuration="PT4S">
      <Period>
        <AdaptationSet mimeType="video/mp4">
          <SegmentTemplate timescale="1" duration="4" initialization="v-init.mp4" media="v-$Number$.m4s" startNumber="1"/>
          <Representation id="v720" bandwidth="1500000" width="1280" height="720"/>
        </AdaptationSet>
        <AdaptationSet mimeType="audio/mp4" lang="en">
          <SegmentTemplate timescale="1" duration="4" initialization="a-en-init.mp4" media="a-en-$Number$.m4s" startNumber="1"/>
          <Representation id="a128_en" bandwidth="128000"/>
        </AdaptationSet>
        <AdaptationSet mimeType="audio/mp4" lang="fr">
          <SegmentTemplate timescale="1" duration="4" initialization="a-fr-init.mp4" media="a-fr-$Number$.m4s" startNumber="1"/>
          <Representation id="a128_fr" bandwidth="128000"/>
        </AdaptationSet>
      </Period>
    </MPD>`;

  const fetchedKeys = [];
  const fixtures = new Map([
    ['https://cdn.example.com/dash/v-init.mp4', vInit],
    ['https://cdn.example.com/dash/v-1.m4s', vSeg],
    ['https://cdn.example.com/dash/a-en-init.mp4', aInit],
    ['https://cdn.example.com/dash/a-en-1.m4s', aSeg],
    ['https://cdn.example.com/dash/a-fr-init.mp4', aInit],
    ['https://cdn.example.com/dash/a-fr-1.m4s', aSeg]
  ]);

  globalThis.fetch = async (url) => {
    const key = String(url);
    fetchedKeys.push(key);
    if (key.endsWith('vod.mpd')) {
      return { ok: true, status: 200, headers: new Headers(), text: async () => mpdXml };
    }
    if (key.endsWith('live.mpd')) {
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        text: async () => '<MPD type="dynamic"><Period/></MPD>'
      };
    }
    const bytes = fixtures.get(key);
    assert.ok(bytes, `Unexpected URL fetched: ${key}`);
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-length': String(bytes.byteLength) }),
      arrayBuffer: async () => bytes.slice().buffer
    };
  };

  const dashResp = await dispatchOffscreenMessage({
    target: 'offscreen',
    type: MESSAGE_TYPES.OFFSCREEN_BUILD_HLS_BLOB,
    requestId: 'dash-mux-test',
    playlistUrl: 'https://cdn.example.com/dash/vod.mpd#dash-video-v720',
    originalUrl: 'https://cdn.example.com/dash/vod.mpd',
    audioUrl: 'https://cdn.example.com/dash/vod.mpd#dash-audio-a128_fr',
    concurrency: 2
  });

  assert.equal(dashResp.ok, true);
  assert.equal(dashResp.outputExtension, 'mp4');
  assert.ok(fetchedKeys.includes('https://cdn.example.com/dash/a-fr-1.m4s'));
  assert.equal(fetchedKeys.includes('https://cdn.example.com/dash/a-en-1.m4s'), false);
  const blob = createdBlobs.get(dashResp.blobUrl);
  assert.ok(blob);
  const muxedBytes = await blob.arrayBuffer();
  assert.equal(countTracksInInit(muxedBytes), 2);

  const liveResp = await dispatchOffscreenMessage({
    target: 'offscreen',
    type: MESSAGE_TYPES.OFFSCREEN_BUILD_HLS_BLOB,
    requestId: 'dash-live-test',
    playlistUrl: 'https://cdn.example.com/dash/live.mpd',
    originalUrl: 'https://cdn.example.com/dash/live.mpd'
  });
  assert.equal(liveResp.ok, false);
  assert.equal(liveResp.error, 'LIVE_STREAM');
});

test('offscreen muxes MPEG-TS video with separate audio via muxjs and cancels active builds', async () => {
  const prevMux = globalThis.muxjs;
  const vInit = makeFmp4Init(1);
  const vChunk = makeMediaChunk(1, 0x11);
  const aInit = makeFmp4Init(1);
  const aChunk = makeMediaChunk(1, 0x22);

  class FakeTsTransmuxer {
    constructor() {
      this.handlers = {};
      this.pushed = [];
    }
    on(event, fn) {
      this.handlers[event] = fn;
    }
    push(chunk) {
      this.pushed.push(chunk[0]);
    }
    flush() {
      const isAudio = this.pushed[0] === 0xa1;
      this.handlers.data({
        initSegment: isAudio ? aInit : vInit,
        data: isAudio ? aChunk : vChunk
      });
    }
  }

  globalThis.muxjs = { Transmuxer: FakeTsTransmuxer };
  try {
    globalThis.fetch = async (url) => {
      const key = String(url);
      if (key.endsWith('master.m3u8')) {
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          text: async () => [
            '#EXTM3U',
            '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",URI="audio.m3u8"',
            '#EXT-X-STREAM-INF:BANDWIDTH=1200000,AUDIO="aud"',
            'video.m3u8'
          ].join('\n')
        };
      }
      if (key.endsWith('video.m3u8')) {
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          text: async () => ['#EXTM3U', '#EXTINF:2.0,', 'v1.ts', '#EXT-X-ENDLIST'].join('\n')
        };
      }
      if (key.endsWith('audio.m3u8')) {
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          text: async () => ['#EXTM3U', '#EXTINF:2.0,', 'a1.ts', '#EXT-X-ENDLIST'].join('\n')
        };
      }
      const marker = key.endsWith('a1.ts') ? 0xa1 : 0x47;
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-length': '4' }),
        arrayBuffer: async () => new Uint8Array([marker, 0, 0, 0]).buffer
      };
    };

    const tsResp = await dispatchOffscreenMessage({
      target: 'offscreen',
      type: MESSAGE_TYPES.OFFSCREEN_BUILD_HLS_BLOB,
      requestId: 'ts-audio-mux-test',
      playlistUrl: 'https://cdn.example.com/hls/master.m3u8',
      originalUrl: 'https://cdn.example.com/hls/master.m3u8',
      concurrency: 2
    });
    assert.equal(tsResp.ok, true);
    const tsBlob = createdBlobs.get(tsResp.blobUrl);
    assert.equal(countTracksInInit(await tsBlob.arrayBuffer()), 2);

    globalThis.fetch = (url, { signal }) => {
      if (String(url).endsWith('slow.m3u8')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers(),
          text: async () => ['#EXTM3U', '#EXTINF:2.0,', 'seg1.ts', '#EXT-X-ENDLIST'].join('\n')
        });
      }
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    };

    const pendingBuild = dispatchOffscreenMessage({
      target: 'offscreen',
      type: MESSAGE_TYPES.OFFSCREEN_BUILD_HLS_BLOB,
      requestId: 'cancel-active-build',
      playlistUrl: 'https://cdn.example.com/hls/slow.m3u8',
      originalUrl: 'https://cdn.example.com/hls/slow.m3u8'
    });
    await new Promise((resolve) => setTimeout(resolve, 15));
    const cancelAck = await dispatchOffscreenMessage({
      target: 'offscreen',
      type: MESSAGE_TYPES.OFFSCREEN_CANCEL_BUILD,
      requestId: 'cancel-active-build'
    });
    assert.equal(cancelAck.ok, true);
    const cancelledBuild = await pendingBuild;
    assert.equal(cancelledBuild.ok, false);
    assert.equal(cancelledBuild.error, 'DOWNLOAD_CANCELLED');
  } finally {
    globalThis.muxjs = prevMux;
  }
});

test('offscreen rejects HLS live playlists and merges HLS WebVTT subtitle tracks', async () => {
  globalThis.fetch = async (url) => {
    const key = String(url);
    if (key.endsWith('live.m3u8')) {
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        text: async () => ['#EXTM3U', '#EXT-X-PLAYLIST-TYPE:EVENT', '#EXTINF:2.0,', 'seg1.ts'].join('\n')
      };
    }
    if (key.endsWith('sub_master.m3u8')) {
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        text: async () => ['#EXTM3U', '#EXTINF:4.0,', 'sub1.vtt', '#EXTINF:4.0,', 'sub2.vtt', '#EXT-X-ENDLIST'].join('\n')
      };
    }
    if (key.endsWith('sub1.vtt')) {
      const text = 'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nHello\n';
      const bytes = new TextEncoder().encode(text);
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-length': String(bytes.byteLength) }),
        arrayBuffer: async () => bytes.buffer
      };
    }
    if (key.endsWith('sub2.vtt')) {
      const text = 'WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000\n\n00:00:02.000 --> 00:00:04.000\nWorld\n';
      const bytes = new TextEncoder().encode(text);
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-length': String(bytes.byteLength) }),
        arrayBuffer: async () => bytes.buffer
      };
    }
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => '1\n00:00:00,000 --> 00:00:01,500\nDirect SRT\n'
    };
  };

  const liveResp = await dispatchOffscreenMessage({
    target: 'offscreen',
    type: MESSAGE_TYPES.OFFSCREEN_BUILD_HLS_BLOB,
    requestId: 'hls-live-test',
    playlistUrl: 'https://cdn.example.com/hls/live.m3u8',
    originalUrl: 'https://cdn.example.com/hls/live.m3u8'
  });
  assert.equal(liveResp.ok, false);
  assert.equal(liveResp.error, 'LIVE_STREAM');

  const subResp = await dispatchOffscreenMessage({
    target: 'offscreen',
    type: MESSAGE_TYPES.OFFSCREEN_BUILD_SUBTITLE_BLOB,
    requestId: 'hls-sub-test',
    subtitleUrl: 'https://cdn.example.com/hls/sub_master.m3u8'
  });
  assert.equal(subResp.ok, true);
  assert.equal(subResp.outputExtension, 'vtt');
  const mergedVttText = await createdBlobs.get(subResp.blobUrl).text();
  assert.equal(mergedVttText.match(/^WEBVTT/gm).length, 1);
  assert.ok(mergedVttText.includes('Hello'));
  assert.ok(mergedVttText.includes('World'));

  const directSrtResp = await dispatchOffscreenMessage({
    target: 'offscreen',
    type: MESSAGE_TYPES.OFFSCREEN_BUILD_SUBTITLE_BLOB,
    requestId: 'direct-srt-test',
    subtitleUrl: 'https://cdn.example.com/subs/movie.srt'
  });
  assert.equal(directSrtResp.ok, true);
  assert.equal(directSrtResp.outputExtension, 'srt');
});

test('offscreen assembles chunked MSE WebM and muxes dual-track fMP4 streams', async () => {
  const toB64 = (bytes) => Buffer.from(bytes).toString('base64');

  await dispatchOffscreenMessage({
    target: 'offscreen',
    type: MESSAGE_TYPES.OFFSCREEN_BUILD_MSE_BLOB,
    action: 'append',
    requestId: 'mse-webm-1',
    track: 'video',
    chunkBase64: toB64(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]))
  });
  const webmResp = await dispatchOffscreenMessage({
    target: 'offscreen',
    type: MESSAGE_TYPES.OFFSCREEN_BUILD_MSE_BLOB,
    action: 'finalize',
    requestId: 'mse-webm-1',
    videoMime: 'video/webm; codecs="vp9"',
    audioMime: ''
  });
  assert.equal(webmResp.ok, true);
  assert.equal(webmResp.outputExtension, 'webm');
  assert.equal(webmResp.byteLength, 4);

  const vInit = makeFmp4Init(1);
  const vFrag = makeMediaChunk(1, 0x11);
  const aInit = makeFmp4Init(1);
  const aFrag = makeMediaChunk(1, 0x22);
  const videoTrack = new Uint8Array(vInit.byteLength + vFrag.byteLength);
  videoTrack.set(vInit, 0);
  videoTrack.set(vFrag, vInit.byteLength);
  const audioTrack = new Uint8Array(aInit.byteLength + aFrag.byteLength);
  audioTrack.set(aInit, 0);
  audioTrack.set(aFrag, aInit.byteLength);
  await dispatchOffscreenMessage({
    target: 'offscreen',
    type: MESSAGE_TYPES.OFFSCREEN_BUILD_MSE_BLOB,
    action: 'append',
    requestId: 'mse-mp4-2',
    track: 'video',
    chunkBase64: toB64(videoTrack)
  });
  await dispatchOffscreenMessage({
    target: 'offscreen',
    type: MESSAGE_TYPES.OFFSCREEN_BUILD_MSE_BLOB,
    action: 'append',
    requestId: 'mse-mp4-2',
    track: 'audio',
    chunkBase64: toB64(audioTrack)
  });
  const mp4Resp = await dispatchOffscreenMessage({
    target: 'offscreen',
    type: MESSAGE_TYPES.OFFSCREEN_BUILD_MSE_BLOB,
    action: 'finalize',
    requestId: 'mse-mp4-2',
    videoMime: 'video/mp4; codecs="avc1.42E01E"',
    audioMime: 'audio/mp4; codecs="mp4a.40.2"'
  });
  assert.equal(mp4Resp.ok, true);
  assert.equal(mp4Resp.outputExtension, 'mp4');
  const muxedBuf = await createdBlobs.get(mp4Resp.blobUrl).arrayBuffer();
  assert.equal(countTracksInInit(muxedBuf), 2);
});

test('offscreen decrypts AES-128 HLS segments and extracts audio-only tracks', async () => {
  const rawKey = new Uint8Array(16).fill(0x3c);
  const seqIv = new Uint8Array(16);
  seqIv[15] = 10;
  const vInit = makeFmp4Init(1);
  const vPlain = makeMediaChunk(1, 0x44);
  const aInit = makeFmp4Init(1);
  const aPlain = makeMediaChunk(1, 0x55);

  const encKey = await globalThis.crypto.subtle.importKey(
    'raw',
    rawKey,
    { name: 'AES-CBC' },
    false,
    ['encrypt']
  );
  const vCipher = await globalThis.crypto.subtle.encrypt({ name: 'AES-CBC', iv: seqIv }, encKey, vPlain);

  let keyFetchCount = 0;
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.endsWith('master.m3u8')) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => [
          '#EXTM3U',
          '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Main",LANGUAGE="en",URI="audio.m3u8"',
          '#EXT-X-STREAM-INF:BANDWIDTH=1200000,RESOLUTION=1280x720,AUDIO="aud"',
          'video.m3u8'
        ].join('\n')
      };
    }
    if (target.endsWith('video.m3u8')) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => [
          '#EXTM3U',
          '#EXT-X-MEDIA-SEQUENCE:10',
          '#EXT-X-MAP:URI="v_init.mp4"',
          '#EXT-X-KEY:METHOD=AES-128,URI="https://cdn.example.com/hls/key.bin"',
          '#EXTINF:2.0,',
          'v_seg1.m4s',
          '#EXT-X-ENDLIST'
        ].join('\n')
      };
    }
    if (target.endsWith('audio.m3u8')) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => [
          '#EXTM3U',
          '#EXT-X-MAP:URI="a_init.mp4"',
          '#EXTINF:2.0,',
          'a_seg1.m4s',
          '#EXT-X-ENDLIST'
        ].join('\n')
      };
    }
    if (target.endsWith('key.bin')) {
      keyFetchCount += 1;
      return {
        ok: true,
        status: 200,
        headers: { get: () => String(rawKey.byteLength) },
        arrayBuffer: async () => rawKey.slice().buffer
      };
    }
    if (target.endsWith('v_init.mp4')) {
      return { ok: true, status: 200, headers: { get: () => String(vInit.byteLength) }, arrayBuffer: async () => vInit.slice().buffer };
    }
    if (target.endsWith('v_seg1.m4s')) {
      return { ok: true, status: 200, headers: { get: () => String(vCipher.byteLength) }, arrayBuffer: async () => vCipher.slice(0) };
    }
    if (target.endsWith('a_init.mp4')) {
      return { ok: true, status: 200, headers: { get: () => String(aInit.byteLength) }, arrayBuffer: async () => aInit.slice().buffer };
    }
    return { ok: true, status: 200, headers: { get: () => String(aPlain.byteLength) }, arrayBuffer: async () => aPlain.slice().buffer };
  };

  const decryptedResp = await dispatchOffscreenMessage({
    target: 'offscreen',
    type: MESSAGE_TYPES.OFFSCREEN_BUILD_HLS_BLOB,
    requestId: 'hls-aes128-test',
    playlistUrl: 'https://cdn.example.com/hls/master.m3u8',
    originalUrl: 'https://cdn.example.com/hls/master.m3u8',
    concurrency: 2
  });
  assert.equal(decryptedResp.ok, true);
  assert.equal(keyFetchCount, 1);
  assert.equal(decryptedResp.outputExtension, 'mp4');
  const muxedAesBuf = await createdBlobs.get(decryptedResp.blobUrl).arrayBuffer();
  assert.equal(countTracksInInit(muxedAesBuf), 2);

  const audioOnlyResp = await dispatchOffscreenMessage({
    target: 'offscreen',
    type: MESSAGE_TYPES.OFFSCREEN_BUILD_HLS_BLOB,
    requestId: 'hls-audio-only-test',
    playlistUrl: 'https://cdn.example.com/hls/master.m3u8',
    originalUrl: 'https://cdn.example.com/hls/master.m3u8',
    audioOnly: true,
    concurrency: 2
  });
  assert.equal(audioOnlyResp.ok, true);
  assert.equal(audioOnlyResp.outputExtension, 'm4a');
  assert.equal(audioOnlyResp.byteLength, aInit.byteLength + aPlain.byteLength);
});

test('offscreen converts HTTP images to JPG and upscales SVGs to PNG via canvas', async () => {
  const prevImage = globalThis.Image;
  const prevDocument = globalThis.document;

  const drawCalls = [];
  const fillCalls = [];
  let loadedNaturalW = 320;
  let loadedNaturalH = 180;

  class FakeImage {
    set src(_val) {
      this.naturalWidth = loadedNaturalW;
      this.naturalHeight = loadedNaturalH;
      queueMicrotask(() => {
        if (typeof this.onload === 'function') {
          this.onload();
        }
      });
    }
  }

  globalThis.Image = FakeImage;
  globalThis.document = {
    createElement: (tag) => {
      if (tag !== 'canvas') {
        return {};
      }
      const ctx = {
        fillStyle: '',
        fillRect: (x, y, w, h) => fillCalls.push({ x, y, w, h, fillStyle: ctx.fillStyle }),
        drawImage: (_img, x, y, w, h) => drawCalls.push({ x, y, w, h })
      };
      return {
        width: 0,
        height: 0,
        getContext: () => ctx,
        toBlob: (cb, mime, quality) => {
          cb(new Blob([new Uint8Array([1, 2, 3, 4])], { type: mime }));
        }
      };
    }
  };

  globalThis.fetch = async (url) => {
    if (String(url).endsWith('.webp')) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => '4' },
        arrayBuffer: async () => new Uint8Array([82, 73, 70, 70]).buffer
      };
    }
    throw new Error('Unexpected fetch URL');
  };

  try {
    const jpgResp = await dispatchOffscreenMessage({
      target: 'offscreen',
      type: MESSAGE_TYPES.OFFSCREEN_CONVERT_IMAGE,
      requestId: 'conv-jpg-1',
      targetUrl: 'https://cdn.example.com/photo.webp',
      targetFormat: 'jpg'
    });
    assert.equal(jpgResp.ok, true);
    assert.equal(jpgResp.outputExtension, 'jpg');
    assert.equal(jpgResp.byteLength, 4);
    assert.equal(fillCalls.length, 1);
    assert.equal(fillCalls[0].fillStyle, '#ffffff');
    assert.deepEqual(drawCalls[0], { x: 0, y: 0, w: 320, h: 180 });

    loadedNaturalW = 24;
    loadedNaturalH = 24;
    const svgPngResp = await dispatchOffscreenMessage({
      target: 'offscreen',
      type: MESSAGE_TYPES.OFFSCREEN_CONVERT_IMAGE,
      requestId: 'conv-svg-png-1',
      targetUrl: 'data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Ccircle%20r%3D%2210%22%2F%3E%3C%2Fsvg%3E',
      targetFormat: 'png',
      width: 24,
      height: 24
    });
    assert.equal(svgPngResp.ok, true);
    assert.equal(svgPngResp.outputExtension, 'png');
    assert.deepEqual(drawCalls[1], { x: 0, y: 0, w: 512, h: 512 });
  } finally {
    globalThis.Image = prevImage;
    globalThis.document = prevDocument;
  }
});

test('offscreen records live HLS sliding windows without duplicates and finalizes on stop', async () => {
  const vInit = makeFmp4Init(1);
  const seg1 = makeMediaChunk(1, 0x11);
  const seg2 = makeMediaChunk(1, 0x22);
  const seg3 = makeMediaChunk(1, 0x33);

  let playlistPolls = 0;
  let seg2Fetches = 0;
  const progressEvents = [];
  const prevSendMessage = globalThis.chrome.runtime.sendMessage;
  globalThis.chrome.runtime.sendMessage = async (msg) => {
    progressEvents.push(msg);
    if (msg && msg.type === MESSAGE_TYPES.DOWNLOAD_PROGRESS && msg.isLiveRecord && msg.done >= 3 && msg.total === 0) {
      queueMicrotask(() => {
        dispatchOffscreenMessage({
          target: 'offscreen',
          type: MESSAGE_TYPES.OFFSCREEN_STOP_LIVE_RECORD,
          requestId: 'live-rec-1'
        });
      });
    }
    return { ok: true };
  };

  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.endsWith('live.m3u8')) {
      playlistPolls += 1;
      const body = playlistPolls === 1
        ? [
            '#EXTM3U',
            '#EXT-X-TARGETDURATION:2',
            '#EXT-X-MEDIA-SEQUENCE:10',
            '#EXT-X-MAP:URI="live_init.mp4"',
            '#EXTINF:2.0,',
            'live_seg1.m4s',
            '#EXTINF:2.0,',
            'live_seg2.m4s'
          ].join('\n')
        : [
            '#EXTM3U',
            '#EXT-X-TARGETDURATION:2',
            '#EXT-X-MEDIA-SEQUENCE:11',
            '#EXT-X-MAP:URI="live_init.mp4"',
            '#EXTINF:2.0,',
            'live_seg2.m4s',
            '#EXTINF:2.0,',
            'live_seg3.m4s'
          ].join('\n');
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => body
      };
    }
    if (target.endsWith('live_init.mp4')) {
      return { ok: true, status: 200, headers: { get: () => String(vInit.byteLength) }, arrayBuffer: async () => vInit.slice().buffer };
    }
    if (target.endsWith('live_seg1.m4s')) {
      return { ok: true, status: 200, headers: { get: () => String(seg1.byteLength) }, arrayBuffer: async () => seg1.slice().buffer };
    }
    if (target.endsWith('live_seg2.m4s')) {
      seg2Fetches += 1;
      return { ok: true, status: 200, headers: { get: () => String(seg2.byteLength) }, arrayBuffer: async () => seg2.slice().buffer };
    }
    return { ok: true, status: 200, headers: { get: () => String(seg3.byteLength) }, arrayBuffer: async () => seg3.slice().buffer };
  };

  try {
    const liveResp = await dispatchOffscreenMessage({
      target: 'offscreen',
      type: MESSAGE_TYPES.OFFSCREEN_RECORD_HLS_LIVE,
      requestId: 'live-rec-1',
      playlistUrl: 'https://cdn.example.com/live/live.m3u8',
      originalUrl: 'https://cdn.example.com/live/live.m3u8',
      pollIntervalMs: 10
    });
    assert.equal(liveResp.ok, true);
    assert.equal(liveResp.outputExtension, 'mp4');
    assert.equal(playlistPolls, 2);
    assert.equal(seg2Fetches, 1);
    assert.equal(
      liveResp.byteLength,
      vInit.byteLength + seg1.byteLength + seg2.byteLength + seg3.byteLength
    );
    assert.ok(progressEvents.some((e) => e.isLiveRecord && e.done === 3));
  } finally {
    globalThis.chrome.runtime.sendMessage = prevSendMessage;
  }
});

test('offscreen records dynamic live DASH manifests cleanly and respects custom SVG rasterSizePx', async () => {
  const ftyp = buildIsoBox('ftyp', [new Uint8Array([0x69, 0x73, 0x6f, 0x35])]);
  const moov = buildIsoBox('moov', [new Uint8Array(12)]);
  const vInit = new Uint8Array(ftyp.byteLength + moov.byteLength);
  vInit.set(ftyp, 0);
  vInit.set(moov, ftyp.byteLength);
  const seg1 = buildIsoBox('mdat', [new Uint8Array([1, 2, 3])]);
  const seg2 = buildIsoBox('mdat', [new Uint8Array([4, 5, 6])]);

  let dashPolls = 0;
  let seg1Fetches = 0;
  const prevSendMessage = globalThis.chrome.runtime.sendMessage;
  globalThis.chrome.runtime.sendMessage = async (msg) => {
    if (msg && msg.type === MESSAGE_TYPES.DOWNLOAD_PROGRESS && msg.done >= 1) {
      queueMicrotask(() => {
        dispatchOffscreenMessage({
          target: 'offscreen',
          type: MESSAGE_TYPES.OFFSCREEN_STOP_LIVE_RECORD,
          requestId: 'live-dash-1'
        });
      });
    }
  };

  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.endsWith('live.mpd')) {
      dashPolls += 1;
      const body = dashPolls === 1
        ? `
          <MPD type="dynamic">
            <Period>
              <AdaptationSet mimeType="video/mp4">
                <Representation id="v720" bandwidth="1500000" width="1280" height="720">
                  <SegmentList>
                    <Initialization sourceURL="init.mp4"/>
                    <SegmentURL media="dash_1.m4s"/>
                  </SegmentList>
                </Representation>
              </AdaptationSet>
            </Period>
          </MPD>`
        : `
          <MPD type="dynamic">
            <Period>
              <AdaptationSet mimeType="video/mp4">
                <Representation id="v720" bandwidth="1500000" width="1280" height="720">
                  <SegmentList>
                    <Initialization sourceURL="init.mp4"/>
                    <SegmentURL media="dash_1.m4s"/>
                    <SegmentURL media="dash_2.m4s"/>
                  </SegmentList>
                </Representation>
              </AdaptationSet>
            </Period>
          </MPD>`;
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => body };
    }
    if (target.endsWith('init.mp4')) {
      return { ok: true, status: 200, headers: { get: () => String(vInit.byteLength) }, arrayBuffer: async () => vInit.slice().buffer };
    }
    if (target.endsWith('dash_1.m4s')) {
      seg1Fetches += 1;
      return { ok: true, status: 200, headers: { get: () => String(seg1.byteLength) }, arrayBuffer: async () => seg1.slice().buffer };
    }
    return { ok: true, status: 200, headers: { get: () => String(seg2.byteLength) }, arrayBuffer: async () => seg2.slice().buffer };
  };

  try {
    const dashLiveResp = await dispatchOffscreenMessage({
      target: 'offscreen',
      type: MESSAGE_TYPES.OFFSCREEN_RECORD_HLS_LIVE,
      requestId: 'live-dash-1',
      playlistUrl: 'https://cdn.example.com/dash/live.mpd',
      originalUrl: 'https://cdn.example.com/dash/live.mpd',
      pollIntervalMs: 10
    });
    assert.equal(dashLiveResp.ok, true);
    assert.equal(dashLiveResp.outputExtension, 'mp4');
    assert.ok(seg1Fetches === 1);
  } finally {
    globalThis.chrome.runtime.sendMessage = prevSendMessage;
  }

  // Test OFFSCREEN_BUILD_ZIP_BLOB with mixed HTTP image and converted SVG at custom rasterSizePx
  const prevImage = globalThis.Image;
  const prevDocument = globalThis.document;
  const drawWidths = [];
  class FakeZipImage {
    set src(_v) {
      this.naturalWidth = 24;
      this.naturalHeight = 24;
      queueMicrotask(() => {
        if (typeof this.onload === 'function') this.onload();
      });
    }
  }
  globalThis.Image = FakeZipImage;
  globalThis.document = {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({
        fillStyle: '',
        fillRect: () => {},
        drawImage: (_i, _x, _y, w) => drawWidths.push(w)
      }),
      toBlob: (cb, mime) => cb(new Blob([new Uint8Array([9, 8, 7])], { type: mime }))
    })
  };
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => '4' },
    arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer
  });

  try {
    const zipResp = await dispatchOffscreenMessage({
      target: 'offscreen',
      type: MESSAGE_TYPES.OFFSCREEN_BUILD_ZIP_BLOB,
      requestId: 'zip-build-1',
      items: [
        { url: 'https://cdn.example.com/photo.jpg', filename: 'photo.jpg', ext: 'jpg' },
        {
          url: 'data:image/svg+xml;charset=utf-8,%3Csvg%3E%3C%2Fsvg%3E',
          filename: 'logo.svg',
          ext: 'svg',
          convertTo: 'png',
          rasterSizePx: 1024
        }
      ]
    });
    assert.equal(zipResp.ok, true);
    assert.equal(zipResp.outputExtension, 'zip');
    assert.equal(zipResp.entryCount, 2);
    assert.equal(drawWidths[0], 1024);
  } finally {
    globalThis.Image = prevImage;
    globalThis.document = prevDocument;
  }
});
