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

import {
  buildSoundFmp4Fragment,
  buildSoundFmp4InitSegment
} from './adts_transmuxer.js';
import {
  parseIsoBoxes,
  readHandlerTypeFromTrak,
  readTrackIdFromTrak,
  splitFmp4InitAndFragments,
  buildIsoBox
} from './fmp4_muxer.js';
import {
  buildEbmlElement,
  concatUint8Parts,
  encodeEbmlId,
  encodeUintPayload,
  encodeVintValue,
  parseEbmlElements,
  readUintPayload,
  readVintValue,
  splitWebmInitAndClusters
} from './webm_muxer.js';

const BOX_HEADER_SIZE = 8;
const OPUS_SAMPLE_RATE = 48000;
const DEFAULT_OPUS_FRAME_SAMPLES = 960;

const ID_EBML = 0x1a45dfa3;
const ID_DOC_TYPE = 0x4282;
const ID_TRACKS = 0x1654ae6b;
const ID_TRACK_ENTRY = 0xae;
const ID_TRACK_NUMBER = 0xd7;
const ID_TRACK_UID = 0x73c5;
const ID_TRACK_TYPE = 0x83;
const ID_CODEC_ID = 0x86;
const ID_CODEC_PRIVATE = 0x63a2;
const ID_AUDIO = 0xe1;
const ID_SAMPLING_FREQ = 0xb5;
const ID_CHANNELS = 0x9f;
const ID_CLUSTER = 0x1f43b675;
const ID_CLUSTER_TIMESTAMP = 0xe7;
const ID_BLOCK_GROUP = 0xa0;
const ID_BLOCK = 0xa1;
const ID_SIMPLE_BLOCK = 0xa3;
const ID_SEGMENT = 0x18538067;

// Opus frame durations per RFC 6716 Section 3.1 (in 48 kHz samples) indexed by TOC config (0..31)
const OPUS_CONFIG_FRAME_SAMPLES = [
  480, 960, 1920, 2880,
  480, 960, 1920, 2880,
  480, 960, 1920, 2880,
  480, 960,
  480, 960,
  120, 240, 480, 960,
  120, 240, 480, 960,
  120, 240, 480, 960,
  120, 240, 480, 960
];

function decodeAscii(bytes) {
  let out = '';
  for (let i = 0; i < bytes.byteLength; i += 1) {
    if (bytes[i] === 0) {
      break;
    }
    out += String.fromCharCode(bytes[i]);
  }
  return out;
}

function encodeAscii(str) {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i += 1) {
    out[i] = str.charCodeAt(i);
  }
  return out;
}

function encodeFloat64Be(value) {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setFloat64(0, value, false);
  return out;
}

/**
 * Computes exact Opus packet sample duration at 48 kHz from the RFC 6716 TOC byte.
 * @param {Uint8Array} packet
 * @returns {number}
 */
export function computeOpusPacketDurationSamples(packet) {
  if (!packet || packet.byteLength === 0) {
    return DEFAULT_OPUS_FRAME_SAMPLES;
  }
  const toc = packet[0];
  const config = (toc >> 3) & 0x1f;
  const code = toc & 0x03;
  const frameSamples = OPUS_CONFIG_FRAME_SAMPLES[config] || DEFAULT_OPUS_FRAME_SAMPLES;
  if (code === 0) {
    return frameSamples;
  }
  if (code === 1 || code === 2) {
    return frameSamples * 2;
  }
  if (packet.byteLength < 2) {
    return frameSamples;
  }
  const frameCount = Math.max(1, packet[1] & 0x3f);
  return frameSamples * frameCount;
}

/**
 * Parses TrackEntry metadata needed to identify A_OPUS audio tracks inside WebM.
 * @param {Uint8Array} entryData
 * @returns {{ codecId: string, codecPrivate: Uint8Array | null, channels: number, sampleRate: number }}
 */
function readWebmAudioTrackMetadata(entryData) {
  const children = parseEbmlElements(entryData);
  let codecId = '';
  let codecPrivate = null;
  let channels = 2;
  let sampleRate = OPUS_SAMPLE_RATE;

  for (const child of children) {
    if (child.id === ID_CODEC_ID) {
      codecId = decodeAscii(child.data);
    } else if (child.id === ID_CODEC_PRIVATE) {
      codecPrivate = child.data;
    } else if (child.id === ID_AUDIO) {
      const audioChildren = parseEbmlElements(child.data);
      for (const ac of audioChildren) {
        if (ac.id === ID_CHANNELS && ac.data.byteLength > 0) {
          channels = Math.max(1, readUintPayload(ac.data, 0, ac.data.byteLength));
        } else if (ac.id === ID_SAMPLING_FREQ && ac.data.byteLength === 8) {
          const val = new DataView(ac.data.buffer, ac.data.byteOffset, 8).getFloat64(0, false);
          if (Number.isFinite(val) && val > 0) {
            sampleRate = Math.round(val);
          }
        } else if (ac.id === ID_SAMPLING_FREQ && ac.data.byteLength === 4) {
          const val = new DataView(ac.data.buffer, ac.data.byteOffset, 4).getFloat32(0, false);
          if (Number.isFinite(val) && val > 0) {
            sampleRate = Math.round(val);
          }
        }
      }
    }
  }
  return { codecId, codecPrivate, channels, sampleRate };
}

/**
 * Converts WebM CodecPrivate (OpusHead) into an ISO BMFF OpusSpecificBox ('dOps').
 * @param {Uint8Array | null} codecPrivate
 * @param {number} fallbackChannels
 * @param {number} fallbackSampleRate
 * @returns {{ channelCount: number, dOpsBox: Uint8Array }}
 */
function buildDopsBoxFromOpusHead(codecPrivate, fallbackChannels, fallbackSampleRate) {
  const hasValidHead = codecPrivate
    && codecPrivate.byteLength >= 19
    && decodeAscii(codecPrivate.subarray(0, 8)) === 'OpusHead';

  const channelCount = hasValidHead ? codecPrivate[9] : Math.max(1, fallbackChannels || 2);
  let preSkip = 312;
  let inputRate = fallbackSampleRate || OPUS_SAMPLE_RATE;
  let outputGain = 0;
  let mappingFamily = 0;
  let mappingTail = new Uint8Array(0);

  if (hasValidHead) {
    const view = new DataView(codecPrivate.buffer, codecPrivate.byteOffset, codecPrivate.byteLength);
    preSkip = view.getUint16(10, true);
    inputRate = view.getUint32(12, true) || OPUS_SAMPLE_RATE;
    outputGain = view.getUint16(16, true);
    mappingFamily = codecPrivate[18];
    if (mappingFamily !== 0 && codecPrivate.byteLength > 19) {
      mappingTail = codecPrivate.subarray(19);
    }
  }

  const dOpsPayload = new Uint8Array(11 + mappingTail.byteLength);
  const dOpsView = new DataView(dOpsPayload.buffer);
  dOpsPayload[0] = 0; // Version 0 in ISOBMFF
  dOpsPayload[1] = channelCount;
  dOpsView.setUint16(2, preSkip, false);
  dOpsView.setUint32(4, inputRate, false);
  dOpsView.setUint16(8, outputGain, false);
  dOpsPayload[10] = mappingFamily;
  if (mappingTail.byteLength > 0) {
    dOpsPayload.set(mappingTail, 11);
  }

  return {
    channelCount,
    dOpsBox: buildIsoBox('dOps', [dOpsPayload])
  };
}

/**
 * Extracts raw Opus packets and their per-packet 48 kHz durations from one WebM Cluster.
 * @param {Uint8Array} clusterBytes
 * @returns {{ timestampUnits: number, packets: Array<Uint8Array>, durations: Array<number> }}
 */
function extractClusterOpusPackets(clusterBytes) {
  const [clusterEl] = parseEbmlElements(clusterBytes);
  if (!clusterEl) {
    return { timestampUnits: 0, packets: [], durations: [] };
  }
  const children = parseEbmlElements(clusterBytes, clusterEl.dataStart, clusterEl.end);
  let timestampUnits = 0;
  const packets = [];
  const durations = [];

  const pushBlock = (blockData) => {
    const trackVint = readVintValue(blockData, 0, blockData.byteLength);
    if (!trackVint || trackVint.unknown) {
      return;
    }
    const headerEnd = trackVint.length + 3; // TrackNumber VINT + int16 relative TS + flags
    if (headerEnd >= blockData.byteLength) {
      return;
    }
    const packet = blockData.subarray(headerEnd);
    packets.push(packet);
    durations.push(computeOpusPacketDurationSamples(packet));
  };

  for (const child of children) {
    if (child.id === ID_CLUSTER_TIMESTAMP && child.data.byteLength > 0) {
      timestampUnits = readUintPayload(child.data, 0, child.data.byteLength);
    } else if (child.id === ID_SIMPLE_BLOCK) {
      pushBlock(child.data);
    } else if (child.id === ID_BLOCK_GROUP) {
      const groupChildren = parseEbmlElements(child.data);
      for (const gc of groupChildren) {
        if (gc.id === ID_BLOCK) {
          pushBlock(gc.data);
        }
      }
    }
  }
  return { timestampUnits, packets, durations };
}

/**
 * Remuxes a WebM Opus audio stream into single-track ISO BMFF `'soun'` Opus fMP4 parts
 * so it can be cleanly muxed alongside H.264/AV1/VP9 fMP4 video via mergeFmp4VideoAndAudioParts.
 * @param {ArrayBuffer | Uint8Array | Array<ArrayBuffer | Uint8Array>} webmAudioInput
 * @returns {{ initSegment: Uint8Array, dataChunks: Array<Uint8Array>, parts: Array<Uint8Array> }}
 */
export function transmuxWebmOpusToFmp4Parts(webmAudioInput) {
  const parsed = splitWebmInitAndClusters(webmAudioInput);
  if (parsed.clusters.length === 0) {
    throw new Error('EMPTY_WEBM_CLUSTERS');
  }

  let trackMeta = null;
  for (const entry of parsed.trackEntries) {
    const meta = readWebmAudioTrackMetadata(entry.data);
    if (!trackMeta || meta.codecId === 'A_OPUS') {
      trackMeta = meta;
      if (meta.codecId === 'A_OPUS') {
        break;
      }
    }
  }
  if (!trackMeta || (trackMeta.codecId && trackMeta.codecId !== 'A_OPUS')) {
    throw new Error('UNSUPPORTED_WEBM_AUDIO_CODEC');
  }

  const { channelCount, dOpsBox } = buildDopsBoxFromOpusHead(
    trackMeta.codecPrivate,
    trackMeta.channels,
    trackMeta.sampleRate
  );
  const opusEntryHeader = new Uint8Array(28);
  const entryView = new DataView(opusEntryHeader.buffer);
  entryView.setUint16(6, 1, false);
  entryView.setUint16(16, channelCount, false);
  entryView.setUint16(18, 16, false);
  entryView.setUint32(24, (OPUS_SAMPLE_RATE & 0xffff) << 16, false);
  const opusSampleEntry = buildIsoBox('Opus', [opusEntryHeader, dOpsBox]);

  const initSegment = buildSoundFmp4InitSegment({
    sampleRate: OPUS_SAMPLE_RATE,
    defaultSampleDuration: DEFAULT_OPUS_FRAME_SAMPLES,
    sampleEntryBox: opusSampleEntry,
    compatBrands: 'isomiso2mp41'
  });

  const dataChunks = [];
  let seqNum = 1;
  let runningSamples = 0;

  for (const cluster of parsed.clusters) {
    const extracted = extractClusterOpusPackets(cluster);
    if (extracted.packets.length === 0) {
      continue;
    }
    const clusterStartSamples = extracted.timestampUnits > 0
      ? Math.round((extracted.timestampUnits * parsed.timestampScale * OPUS_SAMPLE_RATE) / 1e9)
      : runningSamples;
    const baseTime = Math.max(runningSamples, clusterStartSamples);
    dataChunks.push(
      buildSoundFmp4Fragment(
        extracted.packets,
        seqNum,
        baseTime,
        DEFAULT_OPUS_FRAME_SAMPLES,
        extracted.durations
      )
    );
    seqNum += 1;
    runningSamples = baseTime + extracted.durations.reduce((sum, d) => sum + d, 0);
  }

  if (dataChunks.length === 0) {
    throw new Error('EMPTY_WEBM_CLUSTERS');
  }

  return {
    initSegment,
    dataChunks,
    parts: [initSegment, ...dataChunks]
  };
}

function readEsdsTagLength(bytes, offset) {
  let len = 0;
  let cursor = offset;
  for (let i = 0; i < 4 && cursor < bytes.byteLength; i += 1) {
    const b = bytes[cursor];
    cursor += 1;
    len = (len << 7) | (b & 0x7f);
    if ((b & 0x80) === 0) {
      break;
    }
  }
  return { length: len, nextOffset: cursor };
}

/**
 * Extracts DecoderSpecificInfo (AudioSpecificConfig) bytes from an ISO BMFF esds box payload.
 * @param {Uint8Array} esdsBoxData
 * @returns {Uint8Array | null}
 */
function parseAudioSpecificConfigFromEsds(esdsBoxData) {
  let cursor = BOX_HEADER_SIZE + 4; // skip box header + FullBox version/flags
  while (cursor + 2 <= esdsBoxData.byteLength) {
    const tag = esdsBoxData[cursor];
    const { length, nextOffset } = readEsdsTagLength(esdsBoxData, cursor + 1);
    if (tag === 0x05 && nextOffset + length <= esdsBoxData.byteLength) {
      return esdsBoxData.subarray(nextOffset, nextOffset + length);
    }
    if (tag === 0x03) {
      cursor = nextOffset + 3; // ES_ID(2) + flags(1), step into child descriptors
      if (cursor < esdsBoxData.byteLength && (esdsBoxData[nextOffset + 2] & 0x80)) {
        cursor += 2;
      }
      if (cursor < esdsBoxData.byteLength && (esdsBoxData[nextOffset + 2] & 0x40)) {
        cursor += 1 + esdsBoxData[cursor];
      }
      if (cursor < esdsBoxData.byteLength && (esdsBoxData[nextOffset + 2] & 0x20)) {
        cursor += 2;
      }
      continue;
    }
    if (tag === 0x04) {
      cursor = nextOffset + 13; // DecoderConfigDescriptor header before child DecoderSpecificInfo
      continue;
    }
    cursor = nextOffset + length;
  }
  return null;
}

/**
 * Reads timescale, sampleRate, channels, defaults, and AAC CodecPrivate from fMP4 init.
 * @param {Uint8Array} initBytes
 * @returns {{
 *   timescale: number,
 *   sampleRate: number,
 *   channels: number,
 *   defaultSampleDuration: number,
 *   defaultSampleSize: number,
 *   audioSpecificConfig: Uint8Array
 * }}
 */
function parseFmp4AacInitInfo(initBytes) {
  const topBoxes = parseIsoBoxes(initBytes);
  const moov = topBoxes.find((b) => b.type === 'moov');
  if (!moov) {
    throw new Error('INVALID_FMP4_INIT');
  }
  const moovChildren = parseIsoBoxes(initBytes, moov.start + BOX_HEADER_SIZE, moov.end);
  const audioTrak = moovChildren.find(
    (b) => b.type === 'trak' && readHandlerTypeFromTrak(b.data) === 'soun'
  ) || moovChildren.find((b) => b.type === 'trak');
  if (!audioTrak) {
    throw new Error('MISSING_AUDIO_TRACK');
  }

  const audioTrackId = readTrackIdFromTrak(audioTrak.data);
  let timescale = 44100;
  let sampleRate = 44100;
  let channels = 2;
  let audioSpecificConfig = null;
  let defaultSampleDuration = 1024;
  let defaultSampleSize = 0;

  const trakChildren = parseIsoBoxes(audioTrak.data, BOX_HEADER_SIZE);
  const mdia = trakChildren.find((b) => b.type === 'mdia');
  if (mdia) {
    const mdiaChildren = parseIsoBoxes(audioTrak.data, mdia.start + BOX_HEADER_SIZE, mdia.end);
    const mdhd = mdiaChildren.find((b) => b.type === 'mdhd');
    if (mdhd && mdhd.data.byteLength >= 28) {
      const mdhdVer = mdhd.data[BOX_HEADER_SIZE];
      const tsPos = mdhdVer === 1 ? BOX_HEADER_SIZE + 20 : BOX_HEADER_SIZE + 12;
      if (tsPos + 4 <= mdhd.data.byteLength) {
        const ts = new DataView(mdhd.data.buffer, mdhd.data.byteOffset, mdhd.data.byteLength)
          .getUint32(tsPos, false);
        if (ts > 0) {
          timescale = ts;
        }
      }
    }
    const minf = mdiaChildren.find((b) => b.type === 'minf');
    const stbl = minf && parseIsoBoxes(audioTrak.data, minf.start + BOX_HEADER_SIZE, minf.end)
      .find((b) => b.type === 'stbl');
    const stsd = stbl && parseIsoBoxes(audioTrak.data, stbl.start + BOX_HEADER_SIZE, stbl.end)
      .find((b) => b.type === 'stsd');
    if (stsd && stsd.data.byteLength > 16) {
      const entries = parseIsoBoxes(audioTrak.data, stsd.start + 16, stsd.end);
      const mp4a = entries.find((b) => b.type === 'mp4a') || entries[0];
      if (mp4a && mp4a.data.byteLength >= BOX_HEADER_SIZE + 28) {
        const view = new DataView(mp4a.data.buffer, mp4a.data.byteOffset, mp4a.data.byteLength);
        channels = view.getUint16(BOX_HEADER_SIZE + 16, false) || 2;
        const srFixed = view.getUint32(BOX_HEADER_SIZE + 24, false) >>> 16;
        if (srFixed > 0) {
          sampleRate = srFixed;
        }
        const entryChildren = parseIsoBoxes(audioTrak.data, mp4a.start + BOX_HEADER_SIZE + 28, mp4a.end);
        const esds = entryChildren.find((b) => b.type === 'esds');
        if (esds) {
          audioSpecificConfig = parseAudioSpecificConfigFromEsds(esds.data);
        }
      }
    }
  }

  const mvex = moovChildren.find((b) => b.type === 'mvex');
  if (mvex) {
    for (const child of parseIsoBoxes(initBytes, mvex.start + BOX_HEADER_SIZE, mvex.end)) {
      if (child.type === 'trex' && child.data.byteLength >= 32) {
        const view = new DataView(child.data.buffer, child.data.byteOffset, child.data.byteLength);
        const tid = view.getUint32(12, false);
        if (audioTrackId === 0 || tid === audioTrackId) {
          defaultSampleDuration = view.getUint32(20, false) || defaultSampleDuration;
          defaultSampleSize = view.getUint32(24, false) || 0;
        }
      }
    }
  }

  if (!audioSpecificConfig || audioSpecificConfig.byteLength < 2) {
    // Fallback AAC-LC AudioSpecificConfig when init omits esds
    audioSpecificConfig = new Uint8Array([0x12, 0x10]);
  }

  return {
    timescale: timescale || sampleRate,
    sampleRate,
    channels,
    defaultSampleDuration,
    defaultSampleSize,
    audioSpecificConfig
  };
}

/**
 * Extracts raw AAC frames and presentation timestamps from one ISO BMFF moof+mdat fragment.
 * @param {Uint8Array} fragmentBytes
 * @param {{ timescale: number, defaultSampleDuration: number, defaultSampleSize: number }} info
 * @param {number} targetTimestampScale
 * @returns {Array<{ timestampUnits: number, frames: Array<Uint8Array> }>}
 */
function extractFmp4AudioClusterGroups(fragmentBytes, info, targetTimestampScale) {
  const topBoxes = parseIsoBoxes(fragmentBytes);
  const groups = [];

  for (let idx = 0; idx < topBoxes.length; idx += 1) {
    if (topBoxes[idx].type !== 'moof') {
      continue;
    }
    const moof = topBoxes[idx];
    const mdat = topBoxes[idx + 1] && topBoxes[idx + 1].type === 'mdat' ? topBoxes[idx + 1] : null;
    if (!mdat) {
      continue;
    }

    const moofChildren = parseIsoBoxes(fragmentBytes, moof.start + BOX_HEADER_SIZE, moof.end);
    const traf = moofChildren.find((b) => b.type === 'traf');
    if (!traf) {
      continue;
    }

    const trafChildren = parseIsoBoxes(fragmentBytes, traf.start + BOX_HEADER_SIZE, traf.end);
    const tfhd = trafChildren.find((b) => b.type === 'tfhd');
    const tfdt = trafChildren.find((b) => b.type === 'tfdt');
    const trun = trafChildren.find((b) => b.type === 'trun');
    if (!trun || trun.data.byteLength < 16) {
      continue;
    }

    let sampleDuration = info.defaultSampleDuration;
    let sampleSize = info.defaultSampleSize;
    if (tfhd && tfhd.data.byteLength >= 16) {
      const tFlags = (tfhd.data[9] << 16) | (tfhd.data[10] << 8) | tfhd.data[11];
      const tv = new DataView(tfhd.data.buffer, tfhd.data.byteOffset, tfhd.data.byteLength);
      let pos = 16;
      if (tFlags & 0x000001) pos += 8;
      if (tFlags & 0x000002) pos += 4;
      if ((tFlags & 0x000008) && pos + 4 <= tfhd.data.byteLength) {
        sampleDuration = tv.getUint32(pos, false) || sampleDuration;
        pos += 4;
      }
      if ((tFlags & 0x000010) && pos + 4 <= tfhd.data.byteLength) {
        sampleSize = tv.getUint32(pos, false) || sampleSize;
      }
    }

    let baseDecodeTicks = 0;
    if (tfdt && tfdt.data.byteLength >= 16) {
      const ver = tfdt.data[BOX_HEADER_SIZE];
      const dv = new DataView(tfdt.data.buffer, tfdt.data.byteOffset, tfdt.data.byteLength);
      baseDecodeTicks = ver === 1 && tfdt.data.byteLength >= 20
        ? Number(dv.getBigUint64(12, false))
        : dv.getUint32(12, false);
    }

    const trunFlags = (trun.data[9] << 16) | (trun.data[10] << 8) | trun.data[11];
    const rv = new DataView(trun.data.buffer, trun.data.byteOffset, trun.data.byteLength);
    const sampleCount = rv.getUint32(12, false);
    let rPos = 16;
    if (trunFlags & 0x000001) rPos += 4;
    if (trunFlags & 0x000004) rPos += 4;

    const frames = [];
    let dataCursor = mdat.start + BOX_HEADER_SIZE;
    let firstTsUnits = Math.round((baseDecodeTicks * 1e9) / (info.timescale * targetTimestampScale));
    let elapsedTicks = 0;

    for (let s = 0; s < sampleCount; s += 1) {
      const dur = (trunFlags & 0x000100) && rPos + 4 <= trun.data.byteLength
        ? (rv.getUint32(rPos, false) || sampleDuration)
        : sampleDuration;
      if (trunFlags & 0x000100) rPos += 4;

      const size = (trunFlags & 0x000200) && rPos + 4 <= trun.data.byteLength
        ? rv.getUint32(rPos, false)
        : sampleSize;
      if (trunFlags & 0x000200) rPos += 4;

      if (trunFlags & 0x000400) rPos += 4;
      if (trunFlags & 0x000800) rPos += 4;

      if (size > 0 && dataCursor + size <= mdat.end) {
        frames.push({
          relTsUnits: Math.round(((elapsedTicks) * 1e9) / (info.timescale * targetTimestampScale)),
          bytes: fragmentBytes.subarray(dataCursor, dataCursor + size)
        });
        dataCursor += size;
      }
      elapsedTicks += dur;
    }

    if (frames.length > 0) {
      groups.push({ timestampUnits: firstTsUnits, frames });
    }
  }
  return groups;
}

function rewriteEbmlDocType(ebmlHeaderBytes, targetDocType) {
  const [ebmlEl] = parseEbmlElements(ebmlHeaderBytes);
  if (!ebmlEl) {
    return ebmlHeaderBytes;
  }
  const children = parseEbmlElements(ebmlHeaderBytes, ebmlEl.dataStart, ebmlEl.end);
  const rebuilt = [];
  let replaced = false;
  for (const child of children) {
    if (child.id === ID_DOC_TYPE) {
      rebuilt.push(buildEbmlElement(ID_DOC_TYPE, [encodeAscii(targetDocType)]));
      replaced = true;
    } else {
      rebuilt.push(ebmlHeaderBytes.subarray(child.start, child.end));
    }
  }
  if (!replaced) {
    rebuilt.push(buildEbmlElement(ID_DOC_TYPE, [encodeAscii(targetDocType)]));
  }
  return buildEbmlElement(ID_EBML, rebuilt);
}

function readClusterTimestampQuick(clusterBytes) {
  const [clusterEl] = parseEbmlElements(clusterBytes);
  if (!clusterEl) {
    return 0;
  }
  const tsEl = parseEbmlElements(clusterBytes, clusterEl.dataStart, clusterEl.end)
    .find((el) => el.id === ID_CLUSTER_TIMESTAMP);
  return tsEl && tsEl.data.byteLength > 0 ? readUintPayload(tsEl.data, 0, tsEl.data.byteLength) : 0;
}

/**
 * Merges a WebM video stream (VP8/VP9/AV1) with an fMP4 AAC audio stream into a
 * compliant Matroska (`.mkv`) part array without re-encoding either track.
 * @param {ArrayBuffer | Uint8Array | Array<ArrayBuffer | Uint8Array>} webmVideoInput
 * @param {ArrayBuffer | Uint8Array | Array<ArrayBuffer | Uint8Array>} fmp4AudioInput
 * @returns {Array<Uint8Array>}
 */
export function mergeWebmVideoAndFmp4AacParts(webmVideoInput, fmp4AudioInput) {
  const video = splitWebmInitAndClusters(webmVideoInput);
  if (video.clusters.length === 0) {
    throw new Error('EMPTY_WEBM_CLUSTERS');
  }
  const audioRaw = Array.isArray(fmp4AudioInput) ? concatUint8Parts(fmp4AudioInput) : (
    fmp4AudioInput instanceof Uint8Array ? fmp4AudioInput : new Uint8Array(fmp4AudioInput)
  );
  const audioSplit = splitFmp4InitAndFragments(audioRaw);
  if (audioSplit.fragments.length === 0) {
    throw new Error('EMPTY_FMP4_FRAGMENTS');
  }

  const audioInfo = parseFmp4AacInitInfo(audioSplit.initSegment);
  const maxVideoTrackNum = video.trackEntries.reduce(
    (max, entry) => Math.max(max, entry.trackNumber || 0),
    0
  );
  const audioTrackNum = maxVideoTrackNum + 1;
  const audioTrackVint = encodeVintValue(audioTrackNum);

  const audioTrackEntry = buildEbmlElement(ID_TRACK_ENTRY, [
    buildEbmlElement(ID_TRACK_NUMBER, [encodeUintPayload(audioTrackNum)]),
    buildEbmlElement(ID_TRACK_UID, [encodeUintPayload(audioTrackNum)]),
    buildEbmlElement(ID_TRACK_TYPE, [new Uint8Array([2])]),
    buildEbmlElement(ID_CODEC_ID, [encodeAscii('A_AAC')]),
    buildEbmlElement(ID_CODEC_PRIVATE, [audioInfo.audioSpecificConfig]),
    buildEbmlElement(ID_AUDIO, [
      buildEbmlElement(ID_SAMPLING_FREQ, [encodeFloat64Be(audioInfo.sampleRate)]),
      buildEbmlElement(ID_CHANNELS, [encodeUintPayload(audioInfo.channels)])
    ])
  ]);

  const mergedTracks = buildEbmlElement(ID_TRACKS, [
    ...video.trackEntries.map((entry) => entry.element),
    audioTrackEntry
  ]);

  const timelineItems = video.clusters.map((bytes) => ({
    ts: readClusterTimestampQuick(bytes),
    order: 0,
    bytes
  }));

  for (const frag of audioSplit.fragments) {
    const groups = extractFmp4AudioClusterGroups(frag, audioInfo, video.timestampScale);
    for (const group of groups) {
      const blocks = group.frames.map((frame) => {
        const relTs = Math.max(-32768, Math.min(32767, frame.relTsUnits));
        const sb = new Uint8Array(audioTrackVint.byteLength + 3 + frame.bytes.byteLength);
        sb.set(audioTrackVint, 0);
        new DataView(sb.buffer).setInt16(audioTrackVint.byteLength, relTs, false);
        sb[audioTrackVint.byteLength + 2] = 0x80; // keyframe flag
        sb.set(frame.bytes, audioTrackVint.byteLength + 3);
        return buildEbmlElement(ID_SIMPLE_BLOCK, [sb]);
      });
      const cluster = buildEbmlElement(ID_CLUSTER, [
        buildEbmlElement(ID_CLUSTER_TIMESTAMP, [encodeUintPayload(group.timestampUnits)]),
        ...blocks
      ]);
      timelineItems.push({ ts: group.timestampUnits, order: 1, bytes: cluster });
    }
  }

  timelineItems.sort((a, b) => (a.ts - b.ts) || (a.order - b.order));
  const ebmlHeader = rewriteEbmlDocType(video.ebmlHeader, 'matroska');
  const segmentPayloadSize =
    video.infoElement.byteLength +
    mergedTracks.byteLength +
    timelineItems.reduce((sum, item) => sum + item.bytes.byteLength, 0);
  const segId = encodeEbmlId(ID_SEGMENT);
  const segSize = encodeVintValue(segmentPayloadSize);
  const segHeader = new Uint8Array(segId.byteLength + segSize.byteLength);
  segHeader.set(segId, 0);
  segHeader.set(segSize, segId.byteLength);

  return [
    ebmlHeader,
    segHeader,
    video.infoElement,
    mergedTracks,
    ...timelineItems.map((item) => item.bytes)
  ];
}
