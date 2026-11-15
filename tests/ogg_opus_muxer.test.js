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
  buildOpusHeadPacket,
  buildOpusTagsPacket,
  muxOpusPacketsToOgg,
  oggCrc32
} from '../src/shared/ogg_opus_muxer.js';

function readOggPages(bytes) {
  const pages = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  while (offset < bytes.byteLength) {
    assert.equal(String.fromCharCode(...bytes.slice(offset, offset + 4)), 'OggS');
    const headerType = bytes[offset + 5];
    const granule = view.getBigUint64(offset + 6, true);
    const serial = view.getUint32(offset + 14, true);
    const sequence = view.getUint32(offset + 18, true);
    const crc = view.getUint32(offset + 22, true);
    const segCount = bytes[offset + 26];
    let payloadLen = 0;
    for (let i = 0; i < segCount; i += 1) {
      payloadLen += bytes[offset + 27 + i];
    }
    const pageLen = 27 + segCount + payloadLen;
    const pageCopy = bytes.slice(offset, offset + pageLen);
    pageCopy.set([0, 0, 0, 0], 22);
    assert.equal(oggCrc32(pageCopy), crc);
    pages.push({ headerType, granule, serial, sequence, payloadLen });
    offset += pageLen;
  }
  assert.equal(offset, bytes.byteLength);
  return pages;
}

test('buildOpusHeadPacket and buildOpusTagsPacket emit RFC 7845 compliant headers', () => {
  const head = buildOpusHeadPacket(2, 44100, 312);
  assert.equal(head.byteLength, 19);
  assert.equal(String.fromCharCode(...head.slice(0, 8)), 'OpusHead');
  assert.equal(head[8], 1);
  assert.equal(head[9], 2);
  const headView = new DataView(head.buffer);
  assert.equal(headView.getUint16(10, true), 312);
  assert.equal(headView.getUint32(12, true), 44100);
  assert.equal(head[18], 0);

  const tags = buildOpusTagsPacket('MediaHarvest');
  assert.equal(String.fromCharCode(...tags.slice(0, 8)), 'OpusTags');
  const tagsView = new DataView(tags.buffer);
  assert.equal(tagsView.getUint32(8, true), 'MediaHarvest'.length);
  assert.equal(String.fromCharCode(...tags.slice(12, 24)), 'MediaHarvest');
});

test('muxOpusPacketsToOgg writes valid OggS pages with BOS, EOS, CRCs, and multi-page lacing', () => {
  assert.throws(() => muxOpusPacketsToOgg([], { channels: 2 }), /OPUS_EMPTY_FRAMES/);

  // Build enough large packets (>200 segments total) to force multiple audio pages
  const frames = [];
  for (let i = 0; i < 60; i += 1) {
    frames.push({
      data: new Uint8Array(1100).fill(i & 0xff),
      durationUs: 20000
    });
  }

  const oggBytes = muxOpusPacketsToOgg(frames, {
    channels: 2,
    sampleRate: 48000,
    preSkip: 312
  });
  const pages = readOggPages(oggBytes);
  assert.ok(pages.length >= 4, `Expected >= 4 Ogg pages, got ${pages.length}`);
  assert.equal(pages[0].headerType, 0x02); // BOS
  assert.equal(pages[0].sequence, 0);
  assert.equal(pages[1].headerType, 0x00); // OpusTags
  assert.equal(pages[1].sequence, 1);
  const last = pages[pages.length - 1];
  assert.equal(last.headerType, 0x04); // EOS
  // 60 frames * 20 ms = 1.2s = 57600 samples + preSkip 312
  assert.equal(last.granule, 57912n);
});
