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

const OGG_CRC_POLY = 0x04c11db7;
const OGG_CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i += 1) {
  let r = i << 24;
  for (let bit = 0; bit < 8; bit += 1) {
    r = (r & 0x80000000) !== 0 ? ((r << 1) ^ OGG_CRC_POLY) >>> 0 : (r << 1) >>> 0;
  }
  OGG_CRC_TABLE[i] = r >>> 0;
}

const OPUS_SAMPLE_RATE = 48000;
const OPUS_DEFAULT_PRESKIP = 312;
const OPUS_SERIAL = 0x4d484f50;
const MAX_SEGMENTS_PER_PAGE = 200;

/**
 * Computes RFC 3533 non-reflected CRC-32 over an Ogg page byte buffer.
 * Expects checksum bytes [22..25] to be zeroed before invocation.
 * @param {Uint8Array} pageBytes
 * @returns {number}
 */
export function oggCrc32(pageBytes) {
  let crc = 0;
  for (let i = 0; i < pageBytes.length; i += 1) {
    const idx = ((crc >>> 24) ^ pageBytes[i]) & 0xff;
    crc = ((crc << 8) ^ OGG_CRC_TABLE[idx]) >>> 0;
  }
  return crc >>> 0;
}

/**
 * Builds RFC 7845 OpusHead identification packet (19 bytes).
 * @param {number} channels
 * @param {number} [inputSampleRate=48000]
 * @param {number} [preSkip=312]
 * @returns {Uint8Array}
 */
export function buildOpusHeadPacket(
  channels,
  inputSampleRate = OPUS_SAMPLE_RATE,
  preSkip = OPUS_DEFAULT_PRESKIP
) {
  // RFC 7845 Section 5.1.1: channel mapping family 0 supports 1 or 2 channels only
  const ch = Math.min(2, Math.max(1, Math.trunc(Number(channels) || 2)));
  const sr = Math.max(8000, Math.trunc(Number(inputSampleRate) || OPUS_SAMPLE_RATE));
  const skip = Math.max(0, Math.min(65535, Math.trunc(Number(preSkip) || 0)));

  const out = new Uint8Array(19);
  const view = new DataView(out.buffer);
  out.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64], 0); // 'OpusHead'
  out[8] = 1; // Version
  out[9] = ch;
  view.setUint16(10, skip, true);
  view.setUint32(12, sr, true);
  view.setInt16(16, 0, true); // Output gain 0 dB
  out[18] = 0; // Channel mapping family 0
  return out;
}

/**
 * Builds RFC 7845 OpusTags metadata packet.
 * @param {string} [vendor='MediaHarvest']
 * @returns {Uint8Array}
 */
export function buildOpusTagsPacket(vendor = 'MediaHarvest') {
  const vendorBytes = new TextEncoder().encode(String(vendor || 'MediaHarvest'));
  const out = new Uint8Array(16 + vendorBytes.length);
  const view = new DataView(out.buffer);
  out.set([0x4f, 0x70, 0x75, 0x73, 0x54, 0x61, 0x67, 0x73], 0); // 'OpusTags'
  view.setUint32(8, vendorBytes.length, true);
  out.set(vendorBytes, 12);
  view.setUint32(12 + vendorBytes.length, 0, true); // User comment count = 0
  return out;
}

/**
 * Computes Ogg lacing segment lengths for a single packet.
 * @param {number} packetLength
 * @returns {number[]}
 */
function encodePacketLacing(packetLength) {
  const segments = [];
  let remaining = packetLength;
  while (remaining >= 255) {
    segments.push(255);
    remaining -= 255;
  }
  segments.push(remaining);
  return segments;
}

/**
 * Serializes an ordered array of packet byte slices into one RFC 3533 Ogg page.
 * @param {Uint8Array[]} packets
 * @param {object} options
 * @returns {Uint8Array}
 */
function buildOggPage(packets, { headerType = 0, granule = 0n, serial = OPUS_SERIAL, sequence = 0 }) {
  const lacing = [];
  let bodyLength = 0;
  for (const pkt of packets) {
    bodyLength += pkt.byteLength;
    for (const segLen of encodePacketLacing(pkt.byteLength)) {
      lacing.push(segLen);
    }
  }
  if (lacing.length > 255) {
    throw new Error('OGG_PAGE_SEGMENT_OVERFLOW');
  }

  const headerSize = 27 + lacing.length;
  const page = new Uint8Array(headerSize + bodyLength);
  const view = new DataView(page.buffer);

  page.set([0x4f, 0x67, 0x67, 0x53], 0); // 'OggS'
  page[4] = 0;
  page[5] = headerType & 0xff;
  view.setBigInt64(6, BigInt(granule), true);
  view.setUint32(14, serial >>> 0, true);
  view.setUint32(18, sequence >>> 0, true);
  view.setUint32(22, 0, true);
  page[26] = lacing.length;
  for (let i = 0; i < lacing.length; i += 1) {
    page[27 + i] = lacing[i];
  }

  let offset = headerSize;
  for (const pkt of packets) {
    page.set(pkt, offset);
    offset += pkt.byteLength;
  }

  view.setUint32(22, oggCrc32(page), true);
  return page;
}

/**
 * Muxes WebCodecs / raw Opus packet frames into a complete Ogg/Opus (.opus) byte buffer.
 * Each packet entry requires `{ data: Uint8Array, durationUs?: number, timestampUs?: number }`.
 * @param {Array<{ data: Uint8Array, durationUs?: number, timestampUs?: number }>} frames
 * @param {{ channels?: number, sampleRate?: number, preSkip?: number, vendor?: string }} [options={}]
 * @returns {Uint8Array}
 */
export function muxOpusPacketsToOgg(frames, options = {}) {
  if (!Array.isArray(frames) || frames.length === 0) {
    throw new Error('OPUS_EMPTY_FRAMES');
  }
  const channels = options.channels || 2;
  const sampleRate = options.sampleRate || OPUS_SAMPLE_RATE;
  const preSkip = Number.isFinite(options.preSkip) ? options.preSkip : OPUS_DEFAULT_PRESKIP;

  const pages = [];
  let pageSeq = 0;
  pages.push(buildOggPage([buildOpusHeadPacket(channels, sampleRate, preSkip)], {
    headerType: 0x02,
    granule: 0n,
    sequence: pageSeq
  }));
  pageSeq += 1;

  pages.push(buildOggPage([buildOpusTagsPacket(options.vendor)], {
    headerType: 0x00,
    granule: 0n,
    sequence: pageSeq
  }));
  pageSeq += 1;

  let cumulativeSamples = BigInt(preSkip);
  let batchPackets = [];
  let batchSegments = 0;

  for (let i = 0; i < frames.length; i += 1) {
    const frame = frames[i];
    const pkt = frame.data instanceof Uint8Array ? frame.data : new Uint8Array(frame.data);
    const pktSegs = Math.floor(pkt.byteLength / 255) + 1;
    const durationUs = Number.isFinite(frame.durationUs) && frame.durationUs > 0
      ? frame.durationUs
      : 20000;
    const deltaSamples = BigInt(Math.max(1, Math.round((durationUs * OPUS_SAMPLE_RATE) / 1000000)));

    if (batchPackets.length > 0 && batchSegments + pktSegs > MAX_SEGMENTS_PER_PAGE) {
      pages.push(buildOggPage(batchPackets, {
        headerType: 0x00,
        granule: cumulativeSamples,
        sequence: pageSeq
      }));
      pageSeq += 1;
      batchPackets = [];
      batchSegments = 0;
    }

    batchPackets.push(pkt);
    batchSegments += pktSegs;
    cumulativeSamples += deltaSamples;

    const isLast = i === frames.length - 1;
    if (isLast) {
      pages.push(buildOggPage(batchPackets, {
        headerType: 0x04,
        granule: cumulativeSamples,
        sequence: pageSeq
      }));
    }
  }

  let totalBytes = 0;
  for (const page of pages) {
    totalBytes += page.byteLength;
  }
  const output = new Uint8Array(totalBytes);
  let cursor = 0;
  for (const page of pages) {
    output.set(page, cursor);
    cursor += page.byteLength;
  }
  return output;
}
