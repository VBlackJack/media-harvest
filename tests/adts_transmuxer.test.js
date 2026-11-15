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
  looksLikeAdtsAudio,
  parseAdtsFrames,
  skipLeadingId3v2Tags,
  transmuxAdtsSegmentsToFmp4Parts
} from '../src/shared/adts_transmuxer.js';
import {
  countTracksInInit,
  hasAudioTrackInInit,
  parseIsoBoxes,
  readHandlerTypeFromTrak
} from '../src/shared/fmp4_muxer.js';

function makeAdtsFrame({ profileMinus1 = 1, freqIndex = 3, channels = 2, payloadBytes = 12, fill = 0x5a } = {}) {
  const frameLen = 7 + payloadBytes;
  const frame = new Uint8Array(frameLen);
  frame[0] = 0xff;
  frame[1] = 0xf1; // MPEG-4 ADTS, no CRC
  frame[2] = ((profileMinus1 & 0x03) << 6) | ((freqIndex & 0x0f) << 2) | ((channels >> 2) & 0x01);
  frame[3] = ((channels & 0x03) << 6) | ((frameLen >> 11) & 0x03);
  frame[4] = (frameLen >> 3) & 0xff;
  frame[5] = ((frameLen & 0x07) << 5) | 0x1f;
  frame[6] = 0xfc;
  frame.fill(fill, 7);
  return frame;
}

function makeId3v2Tag(bodyLen = 14) {
  const tag = new Uint8Array(10 + bodyLen);
  tag[0] = 0x49; // I
  tag[1] = 0x44; // D
  tag[2] = 0x33; // 3
  tag[3] = 0x04; // v2.4
  tag[6] = (bodyLen >> 21) & 0x7f;
  tag[7] = (bodyLen >> 14) & 0x7f;
  tag[8] = (bodyLen >> 7) & 0x7f;
  tag[9] = bodyLen & 0x7f;
  return tag;
}

test('looksLikeAdtsAudio and parseAdtsFrames handle raw and ID3v2-prefixed HLS ADTS segments', () => {
  const f1 = makeAdtsFrame({ freqIndex: 3, channels: 2, payloadBytes: 10, fill: 0x33 });
  const f2 = makeAdtsFrame({ freqIndex: 3, channels: 2, payloadBytes: 8, fill: 0x44 });
  const id3 = makeId3v2Tag(12);
  const seg = new Uint8Array(id3.byteLength + f1.byteLength + f2.byteLength);
  seg.set(id3, 0);
  seg.set(f1, id3.byteLength);
  seg.set(f2, id3.byteLength + f1.byteLength);

  assert.equal(skipLeadingId3v2Tags(seg), id3.byteLength);
  assert.equal(looksLikeAdtsAudio(seg), true);
  assert.equal(looksLikeAdtsAudio(new Uint8Array([0x00, 0x00, 0x00, 0x18])), false);

  const parsed = parseAdtsFrames(seg);
  assert.equal(parsed.objectType, 2);
  assert.equal(parsed.sampleRate, 48000);
  assert.equal(parsed.channelConfig, 2);
  assert.equal(parsed.rawFrames.length, 2);
  assert.equal(parsed.rawFrames[0].byteLength, 10);
  assert.equal(parsed.rawFrames[1].byteLength, 8);
});

test('transmuxAdtsSegmentsToFmp4Parts builds valid soun initSegment and moof+mdat fragments', () => {
  const seg1 = Buffer.concat([makeId3v2Tag(10), makeAdtsFrame({ payloadBytes: 12, fill: 0xaa })]);
  const seg2 = makeAdtsFrame({ payloadBytes: 16, fill: 0xbb });

  const result = transmuxAdtsSegmentsToFmp4Parts([seg1, seg2]);
  assert.equal(countTracksInInit(result.initSegment), 1);
  assert.equal(hasAudioTrackInInit(result.initSegment), true);
  assert.equal(result.dataChunks.length, 2);
  assert.equal(result.parts.length, 3);

  const initBoxes = parseIsoBoxes(result.initSegment);
  assert.deepEqual(initBoxes.map((b) => b.type), ['ftyp', 'moov']);
  const moov = initBoxes[1];
  const trak = parseIsoBoxes(result.initSegment, moov.start + 8, moov.end).find((b) => b.type === 'trak');
  assert.equal(readHandlerTypeFromTrak(trak.data), 'soun');

  // Verify each fragment's trun.data_offset points accurately to mdat payload
  for (const chunk of result.dataChunks) {
    const boxes = parseIsoBoxes(chunk);
    assert.deepEqual(boxes.map((b) => b.type), ['moof', 'mdat']);
    const moof = boxes[0];
    const traf = parseIsoBoxes(chunk, moof.start + 8, moof.end).find((b) => b.type === 'traf');
    const trun = parseIsoBoxes(chunk, traf.start + 8, traf.end).find((b) => b.type === 'trun');
    const dataOffset = new DataView(trun.data.buffer, trun.data.byteOffset, trun.data.byteLength).getInt32(16, false);
    assert.equal(dataOffset, moof.data.byteLength + 8);
  }

  assert.throws(() => transmuxAdtsSegmentsToFmp4Parts([]), /TRANSMUX_EMPTY/);
  assert.throws(() => transmuxAdtsSegmentsToFmp4Parts([new Uint8Array([1, 2, 3, 4])]), /TRANSMUX_EMPTY/);
});
