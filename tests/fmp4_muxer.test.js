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
  buildIsoBox,
  countTracksInInit,
  mergeFmp4VideoAndAudio,
  mergeFmp4VideoAndAudioParts,
  parseIsoBoxes,
  readTrackIdFromTrak,
  splitFmp4InitAndFragments
} from '../src/shared/fmp4_muxer.js';

function makeFullBoxPayload(version, bodySize) {
  const buf = new Uint8Array(4 + bodySize);
  buf[0] = version;
  return buf;
}

function makeMvhd(nextTrackId) {
  const payload = makeFullBoxPayload(0, 96);
  new DataView(payload.buffer).setUint32(96, nextTrackId, false);
  return buildIsoBox('mvhd', [payload]);
}

function makeTrak(trackId) {
  const tkhdPayload = makeFullBoxPayload(0, 80);
  new DataView(tkhdPayload.buffer).setUint32(12, trackId, false);
  const tkhd = buildIsoBox('tkhd', [tkhdPayload]);
  return buildIsoBox('trak', [tkhd]);
}

function makeTrex(trackId) {
  const payload = makeFullBoxPayload(0, 20);
  new DataView(payload.buffer).setUint32(4, trackId, false);
  return buildIsoBox('trex', [payload]);
}

function makeFmp4Init(trackId) {
  const ftyp = buildIsoBox('ftyp', [new Uint8Array([0x69, 0x73, 0x6f, 0x6d])]);
  const moov = buildIsoBox('moov', [
    makeMvhd(trackId + 1),
    makeTrak(trackId),
    buildIsoBox('mvex', [makeTrex(trackId)])
  ]);
  const out = new Uint8Array(ftyp.byteLength + moov.byteLength);
  out.set(ftyp, 0);
  out.set(moov, ftyp.byteLength);
  return out;
}

function makeMediaChunk(trackId, markerByte) {
  const tfhdPayload = makeFullBoxPayload(0, 8);
  new DataView(tfhdPayload.buffer).setUint32(4, trackId, false);
  const tfhd = buildIsoBox('tfhd', [tfhdPayload]);
  const traf = buildIsoBox('traf', [tfhd]);
  const moof = buildIsoBox('moof', [traf]);
  const mdat = buildIsoBox('mdat', [new Uint8Array([markerByte, markerByte])]);

  const chunk = new Uint8Array(moof.byteLength + mdat.byteLength);
  chunk.set(moof, 0);
  chunk.set(mdat, moof.byteLength);
  return chunk;
}

test('mergeFmp4VideoAndAudio combines two track_ID=1 streams into dual-track MP4', () => {
  const videoInit = makeFmp4Init(1);
  const audioInit = makeFmp4Init(1);
  const videoChunk = makeMediaChunk(1, 0xaa);
  const audioChunk = makeMediaChunk(1, 0xbb);

  const merged = mergeFmp4VideoAndAudio(videoInit, [videoChunk], audioInit, [audioChunk]);
  const topBoxes = parseIsoBoxes(merged);

  assert.deepEqual(
    topBoxes.map((b) => b.type),
    ['ftyp', 'moov', 'moof', 'mdat', 'moof', 'mdat']
  );

  const moov = topBoxes[1];
  const moovChildren = parseIsoBoxes(merged, moov.start + 8, moov.end);
  const traks = moovChildren.filter((b) => b.type === 'trak');
  assert.equal(traks.length, 2);
  assert.equal(readTrackIdFromTrak(traks[0].data), 1);
  assert.equal(readTrackIdFromTrak(traks[1].data), 2);

  const mvex = moovChildren.find((b) => b.type === 'mvex');
  const trexs = parseIsoBoxes(merged, mvex.start + 8, mvex.end).filter((b) => b.type === 'trex');
  assert.equal(trexs.length, 2);
  assert.equal(new DataView(trexs[0].data.buffer, trexs[0].data.byteOffset).getUint32(12, false), 1);
  assert.equal(new DataView(trexs[1].data.buffer, trexs[1].data.byteOffset).getUint32(12, false), 2);

  const audioMoof = topBoxes[4];
  const audioTraf = parseIsoBoxes(merged, audioMoof.start + 8, audioMoof.end)[0];
  const audioTfhd = parseIsoBoxes(merged, audioTraf.start + 8, audioTraf.end)[0];
  assert.equal(new DataView(audioTfhd.data.buffer, audioTfhd.data.byteOffset).getUint32(12, false), 2);
});

test('mergeFmp4VideoAndAudio supports unequal chunk counts and rejects malformed init segments', () => {
  const videoInit = makeFmp4Init(1);
  const audioInit = makeFmp4Init(1);
  const merged = mergeFmp4VideoAndAudio(
    videoInit,
    [makeMediaChunk(1, 0x01), makeMediaChunk(1, 0x02)],
    audioInit,
    [makeMediaChunk(1, 0x03)]
  );
  const topBoxes = parseIsoBoxes(merged);
  assert.deepEqual(
    topBoxes.map((b) => b.type),
    ['ftyp', 'moov', 'moof', 'mdat', 'moof', 'mdat', 'moof', 'mdat']
  );

  assert.throws(
    () => mergeFmp4VideoAndAudio(new Uint8Array([0, 0, 0, 8]), [], audioInit, []),
    /INVALID_FMP4_INIT/
  );

  const emptyMoovInit = buildIsoBox('moov', [makeMvhd(2)]);
  assert.throws(
    () => mergeFmp4VideoAndAudio(videoInit, [], emptyMoovInit, []),
    /MISSING_AUDIO_TRACK/
  );
});

test('parseIsoBoxes stops cleanly on truncated or invalid box sizes', () => {
  const truncated = new Uint8Array([0x00, 0x00, 0x00, 0x40, 0x6d, 0x6f, 0x6f, 0x76]);
  assert.deepEqual(parseIsoBoxes(truncated), []);
  const zeroSize = new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x6d, 0x6f, 0x6f, 0x76]);
  assert.deepEqual(parseIsoBoxes(zeroSize), []);
});

test('countTracksInInit, splitFmp4InitAndFragments, and mergeFmp4VideoAndAudioParts avoid contiguous copies', () => {
  const videoInit = makeFmp4Init(1);
  const audioInit = makeFmp4Init(1);
  const vChunk1 = makeMediaChunk(1, 0xaa);
  const vChunk2 = makeMediaChunk(1, 0xbb);
  const aChunk1 = makeMediaChunk(1, 0xcc);

  assert.equal(countTracksInInit(videoInit), 1);

  const parts = mergeFmp4VideoAndAudioParts(videoInit, [vChunk1, vChunk2], audioInit, [aChunk1]);
  assert.equal(parts.length, 5);

  const combinedLen = parts.reduce((sum, p) => sum + p.byteLength, 0);
  const combined = new Uint8Array(combinedLen);
  let cursor = 0;
  for (const p of parts) {
    combined.set(p, cursor);
    cursor += p.byteLength;
  }

  assert.equal(countTracksInInit(parts[1]), 2);
  const split = splitFmp4InitAndFragments(combined);
  assert.equal(countTracksInInit(split.initSegment), 2);
  assert.equal(split.fragments.length, 3);
});
