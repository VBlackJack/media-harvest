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

import { buildIsoBox } from './fmp4_muxer.js';

const ADTS_SAMPLE_RATES = [
  96000, 88200, 64000, 48000,
  44100, 32000, 24000, 22050,
  16000, 12000, 11025, 8000, 7350
];
const AAC_SAMPLES_PER_FRAME = 1024;
const ADTS_BASE_HEADER_BYTES = 7;
const ADTS_CRC_HEADER_BYTES = 9;
const AUDIO_TRACK_ID = 1;

function toUint8(input) {
  return input instanceof Uint8Array ? input : new Uint8Array(input);
}

/**
 * Returns the byte offset past any leading ID3v2 metadata tags (common on HLS .aac segments).
 * @param {Uint8Array} bytes
 * @param {number} [offset=0]
 * @returns {number}
 */
export function skipLeadingId3v2Tags(bytes, offset = 0) {
  let cursor = offset;
  while (
    cursor + 10 <= bytes.byteLength &&
    bytes[cursor] === 0x49 &&
    bytes[cursor + 1] === 0x44 &&
    bytes[cursor + 2] === 0x33
  ) {
    const syncsafeSize =
      ((bytes[cursor + 6] & 0x7f) << 21) |
      ((bytes[cursor + 7] & 0x7f) << 14) |
      ((bytes[cursor + 8] & 0x7f) << 7) |
      (bytes[cursor + 9] & 0x7f);
    const hasFooter = (bytes[cursor + 5] & 0x10) !== 0;
    const totalTagSize = 10 + syncsafeSize + (hasFooter ? 10 : 0);
    if (totalTagSize <= 10 || cursor + totalTagSize > bytes.byteLength) {
      break;
    }
    cursor += totalTagSize;
  }
  return cursor;
}

/**
 * Checks whether a buffer starts (optionally after ID3v2 tags) with an ADTS AAC syncword.
 * @param {ArrayBuffer | Uint8Array} input
 * @returns {boolean}
 */
export function looksLikeAdtsAudio(input) {
  if (!input) {
    return false;
  }
  const bytes = toUint8(input);
  const start = skipLeadingId3v2Tags(bytes, 0);
  if (start + ADTS_BASE_HEADER_BYTES > bytes.byteLength) {
    return false;
  }
  if (bytes[start] !== 0xff || (bytes[start + 1] & 0xf6) !== 0xf0) {
    return false;
  }
  const freqIndex = (bytes[start + 2] >> 2) & 0x0f;
  const frameLen =
    ((bytes[start + 3] & 0x03) << 11) |
    (bytes[start + 4] << 3) |
    ((bytes[start + 5] >> 5) & 0x07);
  return freqIndex < ADTS_SAMPLE_RATES.length && frameLen >= ADTS_BASE_HEADER_BYTES;
}

/**
 * Parses concatenated ADTS AAC frames inside a single segment buffer.
 * @param {ArrayBuffer | Uint8Array} input
 * @returns {{
 *   objectType: number,
 *   freqIndex: number,
 *   sampleRate: number,
 *   channelConfig: number,
 *   rawFrames: Array<Uint8Array>
 * }}
 */
export function parseAdtsFrames(input) {
  const bytes = toUint8(input);
  let cursor = skipLeadingId3v2Tags(bytes, 0);
  let objectType = 2;
  let freqIndex = 4;
  let sampleRate = 44100;
  let channelConfig = 2;
  const rawFrames = [];

  while (cursor + ADTS_BASE_HEADER_BYTES <= bytes.byteLength) {
    if (bytes[cursor] === 0x49 && bytes[cursor + 1] === 0x44 && bytes[cursor + 2] === 0x33) {
      const skipped = skipLeadingId3v2Tags(bytes, cursor);
      if (skipped > cursor) {
        cursor = skipped;
        continue;
      }
    }
    if (bytes[cursor] !== 0xff || (bytes[cursor + 1] & 0xf6) !== 0xf0) {
      cursor += 1;
      continue;
    }

    const noCrc = (bytes[cursor + 1] & 0x01) === 1;
    const headerLen = noCrc ? ADTS_BASE_HEADER_BYTES : ADTS_CRC_HEADER_BYTES;
    const profile = ((bytes[cursor + 2] >> 6) & 0x03) + 1;
    const fIdx = (bytes[cursor + 2] >> 2) & 0x0f;
    const chCfg = ((bytes[cursor + 2] & 0x01) << 2) | ((bytes[cursor + 3] >> 6) & 0x03);
    const frameLen =
      ((bytes[cursor + 3] & 0x03) << 11) |
      (bytes[cursor + 4] << 3) |
      ((bytes[cursor + 5] >> 5) & 0x07);

    if (
      fIdx >= ADTS_SAMPLE_RATES.length ||
      frameLen < headerLen ||
      cursor + frameLen > bytes.byteLength
    ) {
      break;
    }

    if (rawFrames.length === 0) {
      objectType = profile;
      freqIndex = fIdx;
      sampleRate = ADTS_SAMPLE_RATES[fIdx];
      channelConfig = chCfg > 0 ? chCfg : 2;
    }
    rawFrames.push(bytes.subarray(cursor + headerLen, cursor + frameLen));
    cursor += frameLen;
  }

  return {
    objectType,
    freqIndex,
    sampleRate,
    channelConfig,
    rawFrames
  };
}

function buildFullBox(type, version, flags, payload) {
  const full = new Uint8Array(4 + payload.byteLength);
  full[0] = version & 0xff;
  full[1] = (flags >> 16) & 0xff;
  full[2] = (flags >> 8) & 0xff;
  full[3] = flags & 0xff;
  full.set(payload, 4);
  return buildIsoBox(type, [full]);
}

function encodeAscii(str) {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i += 1) {
    out[i] = str.charCodeAt(i);
  }
  return out;
}

/**
 * Builds an ISO BMFF audio-only initialization segment (ftyp + moov) matching ADTS AAC parameters.
 * @param {{ objectType: number, freqIndex: number, sampleRate: number, channelConfig: number }} params
 * @returns {Uint8Array}
 */
function buildAacFmp4InitSegment({ objectType, freqIndex, sampleRate, channelConfig }) {
  const ftyp = buildIsoBox('ftyp', [
    encodeAscii('isom'),
    new Uint8Array([0, 0, 2, 0]),
    encodeAscii('isommp41')
  ]);

  const mvhdBody = new Uint8Array(96);
  const mvhdView = new DataView(mvhdBody.buffer);
  mvhdView.setUint32(8, sampleRate, false);
  mvhdView.setUint32(20, 0x00010000, false); // rate 1.0
  mvhdView.setUint16(24, 0x0100, false); // volume 1.0
  // identity matrix
  mvhdView.setUint32(36, 0x00010000, false);
  mvhdView.setUint32(52, 0x00010000, false);
  mvhdView.setUint32(68, 0x40000000, false);
  mvhdView.setUint32(92, AUDIO_TRACK_ID + 1, false);
  const mvhd = buildFullBox('mvhd', 0, 0, mvhdBody);

  const tkhdBody = new Uint8Array(80);
  const tkhdView = new DataView(tkhdBody.buffer);
  tkhdView.setUint32(8, AUDIO_TRACK_ID, false);
  tkhdView.setUint16(24, 0x0100, false); // audio volume 1.0
  tkhdView.setUint32(28, 0x00010000, false);
  tkhdView.setUint32(44, 0x00010000, false);
  tkhdView.setUint32(60, 0x40000000, false);
  const tkhd = buildFullBox('tkhd', 0, 0x07, tkhdBody);

  const mdhdBody = new Uint8Array(20);
  const mdhdView = new DataView(mdhdBody.buffer);
  mdhdView.setUint32(8, sampleRate, false);
  mdhdView.setUint16(16, 0x55c4, false); // 'und'
  const mdhd = buildFullBox('mdhd', 0, 0, mdhdBody);

  const hdlrBody = new Uint8Array(24);
  hdlrBody.set(encodeAscii('soun'), 4);
  hdlrBody.set(encodeAscii('Sound\0'), 18);
  const hdlr = buildFullBox('hdlr', 0, 0, hdlrBody);

  const smhd = buildFullBox('smhd', 0, 0, new Uint8Array(4));
  const urlBox = buildFullBox('url ', 0, 1, new Uint8Array(0));
  const drefPayload = new Uint8Array(4 + urlBox.byteLength);
  new DataView(drefPayload.buffer).setUint32(0, 1, false);
  drefPayload.set(urlBox, 4);
  const dref = buildFullBox('dref', 0, 0, drefPayload);
  const dinf = buildIsoBox('dinf', [dref]);

  // 2-byte AudioSpecificConfig: 5 bits objectType | 4 bits freqIndex | 4 bits channelConfig | 3 bits 0
  const ascByte0 = ((objectType & 0x1f) << 3) | ((freqIndex >> 1) & 0x07);
  const ascByte1 = ((freqIndex & 0x01) << 7) | ((channelConfig & 0x0f) << 3);
  const esdsPayload = new Uint8Array([
    0x03, 25, 0x00, AUDIO_TRACK_ID, 0x00,
    0x04, 17, 0x40, 0x15, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x05, 2, ascByte0, ascByte1,
    0x06, 1, 0x02
  ]);
  const esds = buildFullBox('esds', 0, 0, esdsPayload);

  const mp4aHeader = new Uint8Array(28);
  const mp4aView = new DataView(mp4aHeader.buffer);
  mp4aView.setUint16(6, 1, false); // data_reference_index
  mp4aView.setUint16(16, channelConfig, false);
  mp4aView.setUint16(18, 16, false); // sample size
  mp4aView.setUint32(24, (sampleRate & 0xffff) << 16, false);
  const mp4a = buildIsoBox('mp4a', [mp4aHeader, esds]);

  const stsdPayload = new Uint8Array(4 + mp4a.byteLength);
  new DataView(stsdPayload.buffer).setUint32(0, 1, false);
  stsdPayload.set(mp4a, 4);
  const stsd = buildFullBox('stsd', 0, 0, stsdPayload);
  const emptyCountBox = new Uint8Array(4);
  const stts = buildFullBox('stts', 0, 0, emptyCountBox);
  const stsc = buildFullBox('stsc', 0, 0, emptyCountBox);
  const stsz = buildFullBox('stsz', 0, 0, new Uint8Array(8));
  const stco = buildFullBox('stco', 0, 0, emptyCountBox);
  const stbl = buildIsoBox('stbl', [stsd, stts, stsc, stsz, stco]);

  const minf = buildIsoBox('minf', [smhd, dinf, stbl]);
  const mdia = buildIsoBox('mdia', [mdhd, hdlr, minf]);
  const trak = buildIsoBox('trak', [tkhd, mdia]);

  const trexBody = new Uint8Array(20);
  const trexView = new DataView(trexBody.buffer);
  trexView.setUint32(0, AUDIO_TRACK_ID, false);
  trexView.setUint32(4, 1, false); // default_sample_description_index
  trexView.setUint32(8, AAC_SAMPLES_PER_FRAME, false); // default_sample_duration
  const trex = buildFullBox('trex', 0, 0, trexBody);
  const mvex = buildIsoBox('mvex', [trex]);

  const moov = buildIsoBox('moov', [mvhd, trak, mvex]);
  const initSegment = new Uint8Array(ftyp.byteLength + moov.byteLength);
  initSegment.set(ftyp, 0);
  initSegment.set(moov, ftyp.byteLength);
  return initSegment;
}

/**
 * Wraps one segment's raw AAC frames inside a self-contained fMP4 fragment (moof + mdat).
 * @param {Array<Uint8Array>} rawFrames
 * @param {number} sequenceNumber
 * @param {number} baseDecodeTimeSamples
 * @returns {Uint8Array}
 */
function buildAacFmp4Fragment(rawFrames, sequenceNumber, baseDecodeTimeSamples) {
  const mfhdPayload = new Uint8Array(4);
  new DataView(mfhdPayload.buffer).setUint32(0, sequenceNumber, false);
  const mfhd = buildFullBox('mfhd', 0, 0, mfhdPayload);

  // default-base-is-moof (0x020000) | default-sample-duration-present (0x000008)
  const tfhdBody = new Uint8Array(8);
  const tfhdView = new DataView(tfhdBody.buffer);
  tfhdView.setUint32(0, AUDIO_TRACK_ID, false);
  tfhdView.setUint32(4, AAC_SAMPLES_PER_FRAME, false);
  const tfhd = buildFullBox('tfhd', 0, 0x020008, tfhdBody);

  // tfdt version 1 (64-bit baseMediaDecodeTime)
  const tfdtBody = new Uint8Array(8);
  const tfdtView = new DataView(tfdtBody.buffer);
  tfdtView.setBigUint64(0, BigInt(Math.max(0, Math.floor(baseDecodeTimeSamples))), false);
  const tfdt = buildFullBox('tfdt', 1, 0, tfdtBody);

  // trun flags: data-offset-present (0x000001) | sample-size-present (0x000200)
  const trunBody = new Uint8Array(8 + (rawFrames.length * 4));
  const trunView = new DataView(trunBody.buffer);
  trunView.setUint32(0, rawFrames.length, false);
  trunView.setInt32(4, 0, false); // placeholder data_offset patched once moof size is known
  let mdatPayloadBytes = 0;
  for (let i = 0; i < rawFrames.length; i += 1) {
    trunView.setUint32(8 + (i * 4), rawFrames[i].byteLength, false);
    mdatPayloadBytes += rawFrames[i].byteLength;
  }
  const trun = buildFullBox('trun', 0, 0x000201, trunBody);

  const traf = buildIsoBox('traf', [tfhd, tfdt, trun]);
  const moof = buildIsoBox('moof', [mfhd, traf]);
  const dataOffset = moof.byteLength + 8;

  // Patch trun.data_offset directly inside assembled moof
  const trunDataOffsetPos = moof.byteLength - (rawFrames.length * 4) - 4;
  new DataView(moof.buffer, moof.byteOffset).setInt32(trunDataOffsetPos, dataOffset, false);

  const mdat = new Uint8Array(8 + mdatPayloadBytes);
  const mdatView = new DataView(mdat.buffer);
  mdatView.setUint32(0, mdat.byteLength, false);
  mdat.set(encodeAscii('mdat'), 4);
  let cursor = 8;
  for (const frame of rawFrames) {
    mdat.set(frame, cursor);
    cursor += frame.byteLength;
  }

  const fragment = new Uint8Array(moof.byteLength + mdat.byteLength);
  fragment.set(moof, 0);
  fragment.set(mdat, moof.byteLength);
  return fragment;
}

/**
 * Transmuxes raw ADTS AAC segments (with optional leading ID3v2 tags) into single-track fMP4 parts.
 * @param {Array<ArrayBuffer | Uint8Array>} adtsSegments
 * @returns {{ initSegment: Uint8Array, dataChunks: Array<Uint8Array>, parts: Array<Uint8Array> }}
 */
export function transmuxAdtsSegmentsToFmp4Parts(adtsSegments) {
  if (!Array.isArray(adtsSegments) || adtsSegments.length === 0) {
    throw new Error('TRANSMUX_EMPTY');
  }

  let streamParams = null;
  let seqNum = 1;
  let sampleTime = 0;
  const dataChunks = [];

  for (const seg of adtsSegments) {
    const parsed = parseAdtsFrames(seg);
    if (parsed.rawFrames.length === 0) {
      continue;
    }
    if (!streamParams) {
      streamParams = parsed;
    }
    const fragment = buildAacFmp4Fragment(parsed.rawFrames, seqNum, sampleTime);
    dataChunks.push(fragment);
    seqNum += 1;
    sampleTime += parsed.rawFrames.length * AAC_SAMPLES_PER_FRAME;
  }

  if (!streamParams || dataChunks.length === 0) {
    throw new Error('TRANSMUX_EMPTY');
  }

  const initSegment = buildAacFmp4InitSegment(streamParams);
  return {
    initSegment,
    dataChunks,
    parts: [initSegment, ...dataChunks]
  };
}
