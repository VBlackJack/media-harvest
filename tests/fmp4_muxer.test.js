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
  alignFmp4MseFragments,
  buildIsoBox,
  countTracksInInit,
  extractAudioOnlyFromFmp4Parts,
  hasAudioTrackInInit,
  mergeFmp4VideoAndAudio,
  mergeFmp4VideoAndAudioParts,
  normalizeFmp4Fragment,
  parseIsoBoxes,
  readHandlerTypeFromTrak,
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

function makeTypedTrak(trackId, handlerType) {
  const tkhdPayload = makeFullBoxPayload(0, 80);
  new DataView(tkhdPayload.buffer).setUint32(12, trackId, false);
  const tkhd = buildIsoBox('tkhd', [tkhdPayload]);

  const hdlrPayload = makeFullBoxPayload(0, 20);
  for (let i = 0; i < 4; i += 1) {
    hdlrPayload[8 + i] = handlerType.charCodeAt(i);
  }
  const hdlr = buildIsoBox('hdlr', [hdlrPayload]);
  const mdia = buildIsoBox('mdia', [hdlr]);
  return buildIsoBox('trak', [tkhd, mdia]);
}

function makeTypedInit(tracks) {
  const ftyp = buildIsoBox('ftyp', [new Uint8Array([0x69, 0x73, 0x6f, 0x6d])]);
  const traks = tracks.map((t) => makeTypedTrak(t.trackId, t.handlerType));
  const trexs = tracks.map((t) => makeTrex(t.trackId));
  const maxId = tracks.reduce((acc, t) => Math.max(acc, t.trackId), 1);
  const moov = buildIsoBox('moov', [
    makeMvhd(maxId + 1),
    ...traks,
    buildIsoBox('mvex', trexs)
  ]);
  const out = new Uint8Array(ftyp.byteLength + moov.byteLength);
  out.set(ftyp, 0);
  out.set(moov, ftyp.byteLength);
  return out;
}

test('extractAudioOnlyFromFmp4Parts isolates soun track from muxed fMP4 and rejects video-only streams', () => {
  const muxedInit = makeTypedInit([
    { trackId: 1, handlerType: 'vide' },
    { trackId: 2, handlerType: 'soun' }
  ]);
  const videoFrag = makeMediaChunk(1, 0x11);
  const audioFragA = makeMediaChunk(2, 0x22);
  const audioFragB = makeMediaChunk(2, 0x33);

  const audioParts = extractAudioOnlyFromFmp4Parts(muxedInit, [videoFrag, audioFragA, audioFragB]);
  const totalLen = audioParts.reduce((sum, p) => sum + p.byteLength, 0);
  const combinedAudio = new Uint8Array(totalLen);
  let pos = 0;
  for (const part of audioParts) {
    combinedAudio.set(part, pos);
    pos += part.byteLength;
  }

  const split = splitFmp4InitAndFragments(combinedAudio);
  assert.equal(countTracksInInit(split.initSegment), 1);
  assert.equal(split.fragments.length, 2);
  const topBoxes = parseIsoBoxes(split.initSegment);
  const moov = topBoxes.find((b) => b.type === 'moov');
  const traks = parseIsoBoxes(split.initSegment, moov.start + 8, moov.end).filter((b) => b.type === 'trak');
  assert.equal(readHandlerTypeFromTrak(traks[0].data), 'soun');
  assert.equal(readTrackIdFromTrak(traks[0].data), 2);

  const videoOnlyInit = makeTypedInit([{ trackId: 1, handlerType: 'vide' }]);
  assert.throws(
    () => extractAudioOnlyFromFmp4Parts(videoOnlyInit, [videoFrag]),
    /NO_AUDIO_TRACK/
  );
});

test('extractAudioOnlyFromFmp4Parts shifts trun data_offset negatively when stripping video traf from multi-traf moof', () => {
  const muxedInit = makeTypedInit([
    { trackId: 1, handlerType: 'vide' },
    { trackId: 2, handlerType: 'soun' }
  ]);
  const videoTfhdBody = new Uint8Array(8);
  new DataView(videoTfhdBody.buffer).setUint32(4, 1, false);
  const videoTrunBody = new Uint8Array(12);
  videoTrunBody[3] = 0x01;
  new DataView(videoTrunBody.buffer).setUint32(4, 1, false);
  const videoTraf = buildIsoBox('traf', [
    buildIsoBox('tfhd', [videoTfhdBody]),
    buildIsoBox('trun', [videoTrunBody])
  ]);

  const audioTfhdBody = new Uint8Array(8);
  new DataView(audioTfhdBody.buffer).setUint32(4, 2, false);
  const audioTrunBody = new Uint8Array(12);
  audioTrunBody[3] = 0x01; // data-offset-present
  new DataView(audioTrunBody.buffer).setUint32(4, 1, false);
  const audioTraf = buildIsoBox('traf', [
    buildIsoBox('tfhd', [audioTfhdBody]),
    buildIsoBox('trun', [audioTrunBody])
  ]);

  const rawMoof = buildIsoBox('moof', [videoTraf, audioTraf]);
  // Video payload (4 bytes) followed by audio payload (4 bytes) inside mdat
  const mdatPayload = new Uint8Array([0x11, 0x11, 0x11, 0x11, 0xaa, 0xbb, 0xcc, 0xdd]);
  const mdat = buildIsoBox('mdat', [mdatPayload]);
  const origAudioDataOffset = rawMoof.byteLength + 8 + 4;

  // Patch the audio traf's trun data_offset inside rawMoof
  const moofBoxes = parseIsoBoxes(rawMoof, 8, rawMoof.byteLength);
  const audioTrafBox = moofBoxes[1];
  const audioTrafChildren = parseIsoBoxes(rawMoof, audioTrafBox.start + 8, audioTrafBox.end);
  const audioTrunBox = audioTrafChildren.find((b) => b.type === 'trun');
  new DataView(rawMoof.buffer, rawMoof.byteOffset + audioTrunBox.start + 16, 4).setInt32(0, origAudioDataOffset, false);

  const combinedFrag = new Uint8Array(rawMoof.byteLength + mdat.byteLength);
  combinedFrag.set(rawMoof, 0);
  combinedFrag.set(mdat, rawMoof.byteLength);

  const audioParts = extractAudioOnlyFromFmp4Parts(muxedInit, [combinedFrag]);
  const totalLen = audioParts.reduce((sum, p) => sum + p.byteLength, 0);
  const out = new Uint8Array(totalLen);
  let pos = 0;
  for (const part of audioParts) {
    out.set(part, pos);
    pos += part.byteLength;
  }

  const outBoxes = parseIsoBoxes(out);
  const outMoof = outBoxes.find((b) => b.type === 'moof');
  const outMdat = outBoxes.find((b) => b.type === 'mdat');
  assert.ok(outMoof && outMdat);
  assert.ok(outMoof.data.byteLength < rawMoof.byteLength);

  const outTraf = parseIsoBoxes(out, outMoof.start + 8, outMoof.end).find((b) => b.type === 'traf');
  const outTrun = parseIsoBoxes(out, outTraf.start + 8, outTraf.end).find((b) => b.type === 'trun');
  const newDataOffset = new DataView(out.buffer, out.byteOffset + outTrun.start + 16, 4).getInt32(0, false);

  assert.equal(newDataOffset, outMoof.data.byteLength + 8 + 4);
  assert.deepEqual(
    Array.from(out.subarray(outMoof.start + newDataOffset, outMoof.start + newDataOffset + 4)),
    [0xaa, 0xbb, 0xcc, 0xdd]
  );
});

test('normalizeFmp4Fragment strips base-data-offset-present and updates trun data_offset safely', () => {
  const tfhdBody = new Uint8Array(16);
  tfhdBody[0] = 0; // version
  tfhdBody[3] = 0x01; // base-data-offset-present
  const tfhdView = new DataView(tfhdBody.buffer);
  tfhdView.setUint32(4, 1, false); // track_ID = 1
  tfhdView.setBigUint64(8, 9999n, false); // stale absolute base_data_offset
  const tfhd = buildIsoBox('tfhd', [tfhdBody]);

  const trunBody = new Uint8Array(12);
  trunBody[3] = 0x01; // data-offset-present
  new DataView(trunBody.buffer).setUint32(4, 1, false); // sample_count = 1
  const traf = buildIsoBox('traf', [tfhd, buildIsoBox('trun', [trunBody])]);
  const rawMoof = buildIsoBox('moof', [traf]);
  const oldDataOffset = rawMoof.byteLength + 8;

  // Patch initial trun data_offset to oldMoofSize + 8
  const rawChunk = new Uint8Array(rawMoof.byteLength + 12);
  rawChunk.set(rawMoof, 0);
  new DataView(rawChunk.buffer).setInt32(rawMoof.byteLength - 4, oldDataOffset, false);
  rawChunk.set(buildIsoBox('mdat', [new Uint8Array([0x11, 0x22, 0x33, 0x44])]), rawMoof.byteLength);

  const normalized = normalizeFmp4Fragment(rawChunk, 2);
  const boxes = parseIsoBoxes(normalized);
  assert.deepEqual(boxes.map((b) => b.type), ['moof', 'mdat']);
  const newMoof = boxes[0];
  assert.equal(newMoof.data.byteLength, rawMoof.byteLength - 8);

  const newTraf = parseIsoBoxes(normalized, newMoof.start + 8, newMoof.end).find((b) => b.type === 'traf');
  const trafChildren = parseIsoBoxes(normalized, newTraf.start + 8, newTraf.end);
  const newTfhd = trafChildren.find((b) => b.type === 'tfhd');
  const newTrun = trafChildren.find((b) => b.type === 'trun');

  const newFlags = (newTfhd.data[9] << 16) | (newTfhd.data[10] << 8) | newTfhd.data[11];
  assert.equal(newFlags & 0x000001, 0);
  assert.equal(newFlags & 0x020000, 0x020000);
  assert.equal(new DataView(newTfhd.data.buffer, newTfhd.data.byteOffset).getUint32(12, false), 2);
  assert.equal(
    new DataView(newTrun.data.buffer, newTrun.data.byteOffset).getInt32(16, false),
    newMoof.data.byteLength + 8
  );
  assert.equal(hasAudioTrackInInit(makeTypedInit([{ trackId: 1, handlerType: 'vide' }])), false);
  assert.equal(hasAudioTrackInInit(makeTypedInit([{ trackId: 2, handlerType: 'soun' }])), true);
});

test('alignFmp4MseFragments trims stale leading fragments when ABR switches mid-playback', () => {
  function makeInitWithTimescale(trackId, timescale) {
    const ftyp = buildIsoBox('ftyp', [new Uint8Array([0x69, 0x73, 0x6f, 0x6d])]);
    const mdhdBody = makeFullBoxPayload(0, 20);
    new DataView(mdhdBody.buffer).setUint32(12, timescale, false);
    const mdia = buildIsoBox('mdia', [buildIsoBox('mdhd', [mdhdBody])]);
    const tkhdPayload = makeFullBoxPayload(0, 80);
    new DataView(tkhdPayload.buffer).setUint32(12, trackId, false);
    const trak = buildIsoBox('trak', [buildIsoBox('tkhd', [tkhdPayload]), mdia]);
    const moov = buildIsoBox('moov', [
      makeMvhd(trackId + 1),
      trak,
      buildIsoBox('mvex', [makeTrex(trackId)])
    ]);
    const out = new Uint8Array(ftyp.byteLength + moov.byteLength);
    out.set(ftyp, 0);
    out.set(moov, ftyp.byteLength);
    return out;
  }

  function makeFragWithTfdt(trackId, decodeTicks, marker) {
    const tfhdPayload = makeFullBoxPayload(0, 8);
    new DataView(tfhdPayload.buffer).setUint32(4, trackId, false);
    const tfdtPayload = makeFullBoxPayload(0, 8);
    new DataView(tfdtPayload.buffer).setUint32(4, decodeTicks, false);
    const moof = buildIsoBox('moof', [
      buildIsoBox('traf', [buildIsoBox('tfhd', [tfhdPayload]), buildIsoBox('tfdt', [tfdtPayload])])
    ]);
    const mdat = buildIsoBox('mdat', [new Uint8Array([marker])]);
    const out = new Uint8Array(moof.byteLength + mdat.byteLength);
    out.set(moof, 0);
    out.set(mdat, moof.byteLength);
    return out;
  }

  const vInit = makeInitWithTimescale(1, 1000);
  const aInit = makeInitWithTimescale(1, 48000);
  const vFrags = [makeFragWithTfdt(1, 10000, 0x10), makeFragWithTfdt(1, 12000, 0x12)];
  const aFrags = [
    makeFragWithTfdt(1, 0, 0xa0),
    makeFragWithTfdt(1, 480000, 0xa1),
    makeFragWithTfdt(1, 576000, 0xa2)
  ];

  const aligned = alignFmp4MseFragments(vInit, vFrags, aInit, aFrags);
  assert.equal(aligned.videoFrags.length, 2);
  assert.equal(aligned.audioFrags.length, 2);
});
