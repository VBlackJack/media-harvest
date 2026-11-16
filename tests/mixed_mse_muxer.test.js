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
  hasAudioTrackInInit,
  mergeFmp4VideoAndAudioParts,
  parseIsoBoxes
} from '../src/shared/fmp4_muxer.js';
import { buildFullIsoBox } from '../src/shared/adts_transmuxer.js';
import {
  buildEbmlElement,
  countTracksInWebmInit,
  parseEbmlElements
} from '../src/shared/webm_muxer.js';
import {
  computeOpusPacketDurationSamples,
  mergeWebmVideoAndFmp4AacParts,
  transmuxWebmOpusToFmp4Parts
} from '../src/shared/mixed_mse_muxer.js';

function ascii(str) {
  return Uint8Array.from(str, (c) => c.charCodeAt(0));
}

function makeOpusWebmAudio() {
  const opusHead = new Uint8Array(19);
  opusHead.set(ascii('OpusHead'), 0);
  opusHead[8] = 1;
  opusHead[9] = 2;
  new DataView(opusHead.buffer).setUint16(10, 312, true);
  new DataView(opusHead.buffer).setUint32(12, 48000, true);

  const ebml = buildEbmlElement(0x1a45dfa3, [
    buildEbmlElement(0x4286, [new Uint8Array([1])]),
    buildEbmlElement(0x4282, [ascii('webm')])
  ]);
  const info = buildEbmlElement(0x1549a966, [
    buildEbmlElement(0x2ad7b1, [new Uint8Array([0x0f, 0x42, 0x40])])
  ]);
  const tracks = buildEbmlElement(0x1654ae6b, [
    buildEbmlElement(0xae, [
      buildEbmlElement(0xd7, [new Uint8Array([1])]),
      buildEbmlElement(0x83, [new Uint8Array([2])]),
      buildEbmlElement(0x86, [ascii('A_OPUS')]),
      buildEbmlElement(0x63a2, [opusHead])
    ])
  ]);
  // TOC config 16 (480 samples) / code 0 -> 10 ms frame
  const packet = new Uint8Array([16 << 3, 0xaa, 0xbb, 0xcc]);
  const simpleBlock = new Uint8Array(4 + packet.byteLength);
  simpleBlock[0] = 0x81;
  simpleBlock[3] = 0x80;
  simpleBlock.set(packet, 4);
  const cluster = buildEbmlElement(0x1f43b675, [
    buildEbmlElement(0xe7, [new Uint8Array([20])]),
    buildEbmlElement(0xa3, [simpleBlock])
  ]);
  const seg = buildEbmlElement(0x18538067, [info, tracks, cluster]);
  return Buffer.concat([ebml, seg]);
}

function makeVp9WebmVideo() {
  const ebml = buildEbmlElement(0x1a45dfa3, [
    buildEbmlElement(0x4286, [new Uint8Array([1])]),
    buildEbmlElement(0x4282, [ascii('webm')])
  ]);
  const info = buildEbmlElement(0x1549a966, [
    buildEbmlElement(0x2ad7b1, [new Uint8Array([0x0f, 0x42, 0x40])])
  ]);
  const tracks = buildEbmlElement(0x1654ae6b, [
    buildEbmlElement(0xae, [
      buildEbmlElement(0xd7, [new Uint8Array([1])]),
      buildEbmlElement(0x83, [new Uint8Array([1])]),
      buildEbmlElement(0x86, [ascii('V_VP9')])
    ])
  ]);
  const cluster = buildEbmlElement(0x1f43b675, [
    buildEbmlElement(0xe7, [new Uint8Array([0])]),
    buildEbmlElement(0xa3, [new Uint8Array([0x81, 0x00, 0x00, 0x80, 0x55])])
  ]);
  const seg = buildEbmlElement(0x18538067, [info, tracks, cluster]);
  return Buffer.concat([ebml, seg]);
}

function makeFmp4TrakInit(handlerType, trackId = 1) {
  const ftyp = buildIsoBox('ftyp', [ascii('isom')]);
  const mvhdBody = new Uint8Array(96);
  new DataView(mvhdBody.buffer).setUint32(92, trackId + 1, false);
  const tkhdBody = new Uint8Array(80);
  new DataView(tkhdBody.buffer).setUint32(8, trackId, false);
  const mdhdBody = new Uint8Array(20);
  new DataView(mdhdBody.buffer).setUint32(8, 48000, false);
  const hdlrBody = new Uint8Array(24);
  hdlrBody.set(ascii(handlerType), 4);
  const mp4aHeader = new Uint8Array(28);
  new DataView(mp4aHeader.buffer).setUint16(16, 2, false);
  new DataView(mp4aHeader.buffer).setUint32(24, 48000 << 16, false);
  const esds = buildFullIsoBox('esds', 0, 0, new Uint8Array([
    0x03, 21, 0x00, trackId, 0x00,
    0x04, 15, 0x40, 0x15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0x05, 2, 0x11, 0x90
  ]));
  const sampleEntry = handlerType === 'soun'
    ? buildIsoBox('mp4a', [mp4aHeader, esds])
    : buildIsoBox('avc1', [new Uint8Array(78)]);
  const stsdPayload = new Uint8Array(4 + sampleEntry.byteLength);
  new DataView(stsdPayload.buffer).setUint32(0, 1, false);
  stsdPayload.set(sampleEntry, 4);
  const stbl = buildIsoBox('stbl', [buildFullIsoBox('stsd', 0, 0, stsdPayload)]);
  const minf = buildIsoBox('minf', [stbl]);
  const mdia = buildIsoBox('mdia', [
    buildFullIsoBox('mdhd', 0, 0, mdhdBody),
    buildFullIsoBox('hdlr', 0, 0, hdlrBody),
    minf
  ]);
  const trak = buildIsoBox('trak', [buildFullIsoBox('tkhd', 0, 0x07, tkhdBody), mdia]);
  const trexBody = new Uint8Array(20);
  new DataView(trexBody.buffer).setUint32(0, trackId, false);
  new DataView(trexBody.buffer).setUint32(4, 1, false);
  new DataView(trexBody.buffer).setUint32(8, 1024, false);
  const moov = buildIsoBox('moov', [
    buildFullIsoBox('mvhd', 0, 0, mvhdBody),
    trak,
    buildIsoBox('mvex', [buildFullIsoBox('trex', 0, 0, trexBody)])
  ]);
  return Buffer.concat([ftyp, moov]);
}

function makeSimpleFmp4Frag(trackId, markerByte) {
  const mfhd = buildFullIsoBox('mfhd', 0, 0, new Uint8Array([0, 0, 0, 1]));
  const tfhdBody = new Uint8Array(4);
  new DataView(tfhdBody.buffer).setUint32(0, trackId, false);
  const tfhd = buildFullIsoBox('tfhd', 0, 0x020000, tfhdBody);
  const tfdt = buildFullIsoBox('tfdt', 1, 0, new Uint8Array([0, 0, 0, 0, 0, 0, 1, 0]));
  const trunBody = new Uint8Array(12);
  const trunView = new DataView(trunBody.buffer);
  trunView.setUint32(0, 1, false);
  trunView.setInt32(4, 0, false);
  trunView.setUint32(8, 4, false);
  const trun = buildFullIsoBox('trun', 0, 0x000201, trunBody);
  const moof = buildIsoBox('moof', [mfhd, buildIsoBox('traf', [tfhd, tfdt, trun])]);
  new DataView(moof.buffer, moof.byteOffset).setInt32(moof.byteLength - 8, moof.byteLength + 8, false);
  const mdat = buildIsoBox('mdat', [new Uint8Array([markerByte, markerByte, markerByte, markerByte])]);
  return Buffer.concat([moof, mdat]);
}

test('computeOpusPacketDurationSamples computes exact 48 kHz durations from Opus TOC bytes', () => {
  assert.equal(computeOpusPacketDurationSamples(new Uint8Array([0 << 3])), 480);
  assert.equal(computeOpusPacketDurationSamples(new Uint8Array([(1 << 3) | 1])), 1920);
  assert.equal(computeOpusPacketDurationSamples(new Uint8Array([(16 << 3) | 3, 3])), 360);
});

test('transmuxWebmOpusToFmp4Parts produces valid soun Opus+dOps fMP4 compatible with MP4 video muxing', () => {
  const opusFmp4 = transmuxWebmOpusToFmp4Parts(makeOpusWebmAudio());
  assert.equal(countTracksInInit(opusFmp4.initSegment), 1);
  assert.equal(hasAudioTrackInInit(opusFmp4.initSegment), true);
  assert.equal(opusFmp4.dataChunks.length, 1);
  const topBoxes = parseIsoBoxes(opusFmp4.initSegment);
  assert.ok(topBoxes.some((b) => b.type === 'moov'));

  const mergedParts = mergeFmp4VideoAndAudioParts(
    makeFmp4TrakInit('vide', 1),
    [makeSimpleFmp4Frag(1, 0x22)],
    opusFmp4.initSegment,
    opusFmp4.dataChunks
  );
  const merged = Buffer.concat(mergedParts);
  assert.equal(countTracksInInit(merged), 2);
  assert.equal(hasAudioTrackInInit(merged), true);
});

test('mergeWebmVideoAndFmp4AacParts merges WebM video and fMP4 AAC audio into Matroska MKV', () => {
  const mkvParts = mergeWebmVideoAndFmp4AacParts(
    makeVp9WebmVideo(),
    Buffer.concat([makeFmp4TrakInit('soun', 1), makeSimpleFmp4Frag(1, 0x33)])
  );
  const mkvBytes = Buffer.concat(mkvParts);
  assert.equal(countTracksInWebmInit(mkvBytes), 2);

  const [ebmlEl] = parseEbmlElements(mkvBytes);
  const ebmlChildren = parseEbmlElements(mkvBytes, ebmlEl.dataStart, ebmlEl.end);
  const docTypeEl = ebmlChildren.find((el) => el.id === 0x4282);
  assert.ok(docTypeEl);
  assert.equal(Buffer.from(docTypeEl.data).toString('ascii'), 'matroska');
});
