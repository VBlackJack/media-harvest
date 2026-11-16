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

const ID_EBML = 0x1a45dfa3;
const ID_SEGMENT = 0x18538067;
const ID_INFO = 0x1549a966;
const ID_TIMESTAMP_SCALE = 0x2ad7b1;
const ID_TRACKS = 0x1654ae6b;
const ID_TRACK_ENTRY = 0xae;
const ID_TRACK_NUMBER = 0xd7;
const ID_CLUSTER = 0x1f43b675;
const ID_CLUSTER_TIMESTAMP = 0xe7;
const ID_BLOCK_GROUP = 0xa0;
const ID_BLOCK = 0xa1;
const ID_SIMPLE_BLOCK = 0xa3;

const DEFAULT_TIMESTAMP_SCALE = 1000000;
const SEGMENT_UNKNOWN_SIZE = new Uint8Array([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);

function toUint8(input) {
  return input instanceof Uint8Array ? input : new Uint8Array(input);
}

export function concatUint8Parts(parts) {
  if (parts.length === 1) {
    return toUint8(parts[0]);
  }
  const normalized = parts.map(toUint8);
  const total = normalized.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const part of normalized) {
    out.set(part, cursor);
    cursor += part.byteLength;
  }
  return out;
}

/**
 * Decodes an EBML element ID (keeping its leading VINT marker bit).
 * @param {Uint8Array} bytes
 * @param {number} offset
 * @param {number} end
 * @returns {{ id: number, length: number } | null}
 */
function readVintId(bytes, offset, end) {
  if (offset >= end) {
    return null;
  }
  const first = bytes[offset];
  if (first === 0) {
    return null;
  }
  let length = 1;
  let mask = 0x80;
  while (length <= 4 && (first & mask) === 0) {
    length += 1;
    mask >>= 1;
  }
  if (length > 4 || offset + length > end) {
    return null;
  }
  let id = 0;
  for (let i = 0; i < length; i += 1) {
    id = (id * 256) + bytes[offset + i];
  }
  return { id, length };
}

/**
 * Decodes an EBML VINT unsigned integer / data size (stripping the VINT marker bit).
 * Returns size = -1 when all data bits are 1 (unknown/streaming element size).
 * @param {Uint8Array} bytes
 * @param {number} offset
 * @param {number} end
 * @returns {{ value: number, length: number, unknown: boolean } | null}
 */
export function readVintValue(bytes, offset, end) {
  if (offset >= end) {
    return null;
  }
  const first = bytes[offset];
  if (first === 0) {
    return null;
  }
  let length = 1;
  let mask = 0x80;
  while (length <= 8 && (first & mask) === 0) {
    length += 1;
    mask >>= 1;
  }
  if (length > 8 || offset + length > end) {
    return null;
  }
  let value = first & (mask - 1);
  let allOnes = value === (mask - 1);
  for (let i = 1; i < length; i += 1) {
    const b = bytes[offset + i];
    if (b !== 0xff) {
      allOnes = false;
    }
    value = (value * 256) + b;
  }
  return {
    value: allOnes ? -1 : value,
    length,
    unknown: allOnes
  };
}

/**
 * Encodes an EBML element ID integer into its big-endian bytes.
 * @param {number} id
 * @returns {Uint8Array}
 */
export function encodeEbmlId(id) {
  if (id <= 0xff) {
    return new Uint8Array([id]);
  }
  if (id <= 0xffff) {
    return new Uint8Array([(id >> 8) & 0xff, id & 0xff]);
  }
  if (id <= 0xffffff) {
    return new Uint8Array([(id >> 16) & 0xff, (id >> 8) & 0xff, id & 0xff]);
  }
  return new Uint8Array([
    (id >>> 24) & 0xff,
    (id >> 16) & 0xff,
    (id >> 8) & 0xff,
    id & 0xff
  ]);
}

/**
 * Encodes an unsigned integer as a minimal-width EBML VINT (for sizes or track numbers).
 * Avoids emitting all-1s reserved unknown-size values.
 * @param {number} value
 * @returns {Uint8Array}
 */
export function encodeVintValue(value) {
  const safeVal = Math.max(0, Math.floor(value));
  for (let length = 1; length <= 8; length += 1) {
    const maxData = (2 ** (length * 7)) - 2;
    if (safeVal <= maxData) {
      const out = new Uint8Array(length);
      let rem = safeVal;
      for (let i = length - 1; i >= 0; i -= 1) {
        out[i] = rem % 256;
        rem = Math.floor(rem / 256);
      }
      out[0] |= 1 << (8 - length);
      return out;
    }
  }
  return new Uint8Array(SEGMENT_UNKNOWN_SIZE);
}

/**
 * Encodes a Matroska unsigned integer payload in minimal big-endian bytes.
 * @param {number} value
 * @returns {Uint8Array}
 */
export function encodeUintPayload(value) {
  const safe = Math.max(0, Math.floor(value));
  if (safe === 0) {
    return new Uint8Array([0]);
  }
  const bytes = [];
  let rem = safe;
  while (rem > 0) {
    bytes.unshift(rem % 256);
    rem = Math.floor(rem / 256);
  }
  return new Uint8Array(bytes);
}

/**
 * Reads a Matroska unsigned integer payload of 1..8 bytes.
 * @param {Uint8Array} bytes
 * @param {number} start
 * @param {number} end
 * @returns {number}
 */
export function readUintPayload(bytes, start, end) {
  let out = 0;
  for (let i = start; i < end; i += 1) {
    out = (out * 256) + bytes[i];
  }
  return out;
}

/**
 * Wraps payload parts in an EBML element header (ID + VINT size).
 * @param {number} id
 * @param {Array<Uint8Array>} children
 * @returns {Uint8Array}
 */
export function buildEbmlElement(id, children) {
  const idBytes = encodeEbmlId(id);
  const payloadSize = children.reduce((sum, part) => sum + part.byteLength, 0);
  const sizeBytes = encodeVintValue(payloadSize);
  const out = new Uint8Array(idBytes.byteLength + sizeBytes.byteLength + payloadSize);
  out.set(idBytes, 0);
  out.set(sizeBytes, idBytes.byteLength);
  let cursor = idBytes.byteLength + sizeBytes.byteLength;
  for (const child of children) {
    out.set(child, cursor);
    cursor += child.byteLength;
  }
  return out;
}

/**
 * Parses immediate child EBML elements in [start, end).
 * @param {Uint8Array} bytes
 * @param {number} [start=0]
 * @param {number} [end=bytes.length]
 * @returns {Array<{ id: number, start: number, dataStart: number, end: number, unknownSize: boolean, data: Uint8Array }>}
 */
export function parseEbmlElements(bytes, start = 0, end = bytes.length) {
  const elements = [];
  let cursor = start;
  while (cursor < end) {
    const idInfo = readVintId(bytes, cursor, end);
    if (!idInfo) {
      break;
    }
    const sizeInfo = readVintValue(bytes, cursor + idInfo.length, end);
    if (!sizeInfo) {
      break;
    }
    const dataStart = cursor + idInfo.length + sizeInfo.length;
    const elemEnd = sizeInfo.unknown ? end : dataStart + sizeInfo.value;
    if (elemEnd > end || elemEnd < dataStart) {
      break;
    }
    elements.push({
      id: idInfo.id,
      start: cursor,
      dataStart,
      end: elemEnd,
      unknownSize: sizeInfo.unknown,
      data: bytes.subarray(dataStart, elemEnd)
    });
    cursor = elemEnd;
  }
  return elements;
}

/**
 * Reads TimestampScale (in nanoseconds) from a Segment Info element.
 * @param {Uint8Array} infoData
 * @returns {number}
 */
function readTimestampScale(infoData) {
  const children = parseEbmlElements(infoData);
  const scaleEl = children.find((el) => el.id === ID_TIMESTAMP_SCALE);
  if (!scaleEl || scaleEl.data.byteLength === 0) {
    return DEFAULT_TIMESTAMP_SCALE;
  }
  const parsed = readUintPayload(scaleEl.data, 0, scaleEl.data.byteLength);
  return parsed > 0 ? parsed : DEFAULT_TIMESTAMP_SCALE;
}

/**
 * Reads TrackNumber from a TrackEntry payload.
 * @param {Uint8Array} entryData
 * @returns {number}
 */
function readTrackEntryNumber(entryData) {
  const children = parseEbmlElements(entryData);
  const numEl = children.find((el) => el.id === ID_TRACK_NUMBER);
  if (!numEl || numEl.data.byteLength === 0) {
    return 0;
  }
  return readUintPayload(numEl.data, 0, numEl.data.byteLength);
}

/**
 * Rebuilds a TrackEntry element with an updated TrackNumber.
 * @param {Uint8Array} entryData
 * @param {number} newTrackNumber
 * @returns {Uint8Array}
 */
function rewriteTrackEntryElement(entryData, newTrackNumber) {
  const children = parseEbmlElements(entryData);
  const rebuilt = [];
  let replaced = false;
  for (const child of children) {
    if (child.id === ID_TRACK_NUMBER) {
      rebuilt.push(buildEbmlElement(ID_TRACK_NUMBER, [encodeUintPayload(newTrackNumber)]));
      replaced = true;
    } else {
      rebuilt.push(entryData.subarray(child.start, child.end));
    }
  }
  if (!replaced) {
    rebuilt.unshift(buildEbmlElement(ID_TRACK_NUMBER, [encodeUintPayload(newTrackNumber)]));
  }
  return buildEbmlElement(ID_TRACK_ENTRY, rebuilt);
}

/**
 * Splits a single- or chunked WebM byte stream into EBML header, Segment Info,
 * TrackEntry elements, and ordered Cluster slices.
 * @param {ArrayBuffer | Uint8Array | Array<ArrayBuffer | Uint8Array>} input
 * @returns {{
 *   ebmlHeader: Uint8Array,
 *   infoElement: Uint8Array,
 *   timestampScale: number,
 *   trackEntries: Array<{ trackNumber: number, element: Uint8Array, data: Uint8Array }>,
 *   clusters: Array<Uint8Array>
 * }}
 */
export function splitWebmInitAndClusters(input) {
  const bytes = Array.isArray(input) ? concatUint8Parts(input) : toUint8(input);
  const topElements = parseEbmlElements(bytes);
  const ebmlEl = topElements.find((el) => el.id === ID_EBML);
  const segmentEl = topElements.find((el) => el.id === ID_SEGMENT);
  if (!ebmlEl || !segmentEl) {
    throw new Error('INVALID_WEBM_INIT');
  }

  const segmentChildren = parseEbmlElements(bytes, segmentEl.dataStart, segmentEl.end);
  const infoEl = segmentChildren.find((el) => el.id === ID_INFO);
  const tracksEl = segmentChildren.find((el) => el.id === ID_TRACKS);
  if (!infoEl || !tracksEl) {
    throw new Error('INVALID_WEBM_INIT');
  }

  const timestampScale = readTimestampScale(infoEl.data);
  const trackEntries = parseEbmlElements(bytes, tracksEl.dataStart, tracksEl.end)
    .filter((el) => el.id === ID_TRACK_ENTRY)
    .map((el) => ({
      trackNumber: readTrackEntryNumber(el.data),
      element: bytes.subarray(el.start, el.end),
      data: el.data
    }));

  if (trackEntries.length === 0) {
    throw new Error('INVALID_WEBM_TRACKS');
  }

  const clusters = segmentChildren
    .filter((el) => el.id === ID_CLUSTER)
    .map((el) => bytes.subarray(el.start, el.end));

  return {
    ebmlHeader: bytes.subarray(ebmlEl.start, ebmlEl.end),
    infoElement: bytes.subarray(infoEl.start, infoEl.end),
    timestampScale,
    trackEntries,
    clusters
  };
}

/**
 * Counts TrackEntry boxes declared inside a WebM init buffer.
 * @param {ArrayBuffer | Uint8Array | Array<ArrayBuffer | Uint8Array>} input
 * @returns {number}
 */
export function countTracksInWebmInit(input) {
  try {
    return splitWebmInitAndClusters(input).trackEntries.length;
  } catch {
    return 0;
  }
}

/**
 * Reads Cluster Timestamp in raw cluster units (0 when omitted).
 * @param {Uint8Array} clusterBytes
 * @returns {number}
 */
function readClusterTimestamp(clusterBytes) {
  const [clusterEl] = parseEbmlElements(clusterBytes);
  if (!clusterEl) {
    return 0;
  }
  const children = parseEbmlElements(clusterBytes, clusterEl.dataStart, clusterEl.end);
  const tsEl = children.find((el) => el.id === ID_CLUSTER_TIMESTAMP);
  if (!tsEl || tsEl.data.byteLength === 0) {
    return 0;
  }
  return readUintPayload(tsEl.data, 0, tsEl.data.byteLength);
}

/**
 * Rewrites a SimpleBlock or Block payload so its leading TrackNumber VINT equals targetTrackNumber.
 * @param {Uint8Array} blockData
 * @param {number} targetTrackNumber
 * @returns {Uint8Array}
 */
function rewriteBlockTrackNumber(blockData, targetTrackNumber) {
  const vint = readVintValue(blockData, 0, blockData.byteLength);
  if (!vint || vint.unknown) {
    return blockData;
  }
  const encodedNew = encodeVintValue(targetTrackNumber);
  if (encodedNew.byteLength === vint.length) {
    const out = new Uint8Array(blockData);
    out.set(encodedNew, 0);
    return out;
  }
  const remainder = blockData.subarray(vint.length);
  const out = new Uint8Array(encodedNew.byteLength + remainder.byteLength);
  out.set(encodedNew, 0);
  out.set(remainder, encodedNew.byteLength);
  return out;
}

/**
 * Rewrites all blocks inside a BlockGroup to targetTrackNumber.
 * @param {Uint8Array} groupData
 * @param {number} targetTrackNumber
 * @returns {Uint8Array}
 */
function rewriteBlockGroupElement(groupData, targetTrackNumber) {
  const children = parseEbmlElements(groupData);
  const rebuilt = [];
  for (const child of children) {
    if (child.id === ID_BLOCK) {
      rebuilt.push(buildEbmlElement(ID_BLOCK, [rewriteBlockTrackNumber(child.data, targetTrackNumber)]));
    } else {
      rebuilt.push(groupData.subarray(child.start, child.end));
    }
  }
  return buildEbmlElement(ID_BLOCK_GROUP, rebuilt);
}

/**
 * Clones an audio Cluster, remaps its SimpleBlock/Block TrackNumber VINTs, and optionally rescales Timestamp.
 * @param {Uint8Array} clusterBytes
 * @param {number} targetTrackNumber
 * @param {number} srcScale
 * @param {number} dstScale
 * @returns {{ timestampScaled: number, bytes: Uint8Array }}
 */
function rewriteAudioCluster(clusterBytes, targetTrackNumber, srcScale, dstScale) {
  const [clusterEl] = parseEbmlElements(clusterBytes);
  if (!clusterEl) {
    return { timestampScaled: 0, bytes: clusterBytes };
  }
  const children = parseEbmlElements(clusterBytes, clusterEl.dataStart, clusterEl.end);
  const rebuilt = [];
  let timestampScaled = 0;

  for (const child of children) {
    if (child.id === ID_CLUSTER_TIMESTAMP) {
      const rawTs = readUintPayload(child.data, 0, child.data.byteLength);
      timestampScaled = srcScale === dstScale
        ? rawTs
        : Math.round((rawTs * srcScale) / dstScale);
      if (srcScale === dstScale) {
        rebuilt.push(clusterBytes.subarray(child.start, child.end));
      } else {
        rebuilt.push(buildEbmlElement(ID_CLUSTER_TIMESTAMP, [encodeUintPayload(timestampScaled)]));
      }
    } else if (child.id === ID_SIMPLE_BLOCK) {
      rebuilt.push(buildEbmlElement(ID_SIMPLE_BLOCK, [rewriteBlockTrackNumber(child.data, targetTrackNumber)]));
    } else if (child.id === ID_BLOCK_GROUP) {
      rebuilt.push(rewriteBlockGroupElement(child.data, targetTrackNumber));
    } else {
      rebuilt.push(clusterBytes.subarray(child.start, child.end));
    }
  }

  return {
    timestampScaled,
    bytes: buildEbmlElement(ID_CLUSTER, rebuilt)
  };
}

/**
 * Builds a streaming-safe dual-track WebM initialization prefix (`EBML` + unknown-size `Segment`
 * + `Info` + merged `Tracks`) so clusters can be written incrementally straight to disk.
 * @param {ArrayBuffer | Uint8Array} videoInitInput
 * @param {ArrayBuffer | Uint8Array} audioInitInput
 * @returns {{ prefixParts: Array<Uint8Array>, audioTrackNumber: number, videoScale: number, audioScale: number }}
 */
export function buildDualWebmStreamInit(videoInitInput, audioInitInput) {
  const video = splitWebmInitAndClusters(videoInitInput);
  const audio = splitWebmInitAndClusters(audioInitInput);
  const maxVideoTrackNum = video.trackEntries.reduce(
    (max, entry) => Math.max(max, entry.trackNumber || 0),
    0
  );
  let nextTrackNum = maxVideoTrackNum + 1;
  const audioTrackEntryElements = audio.trackEntries.map((entry) => {
    const assigned = nextTrackNum;
    nextTrackNum += 1;
    return {
      newTrackNumber: assigned,
      element: rewriteTrackEntryElement(entry.data, assigned)
    };
  });
  const mergedTracksElement = buildEbmlElement(ID_TRACKS, [
    ...video.trackEntries.map((entry) => entry.element),
    ...audioTrackEntryElements.map((entry) => entry.element)
  ]);
  const segId = encodeEbmlId(ID_SEGMENT);
  const segHeader = new Uint8Array(segId.byteLength + SEGMENT_UNKNOWN_SIZE.byteLength);
  segHeader.set(segId, 0);
  segHeader.set(SEGMENT_UNKNOWN_SIZE, segId.byteLength);
  return {
    prefixParts: [video.ebmlHeader, segHeader, video.infoElement, mergedTracksElement],
    audioTrackNumber: audioTrackEntryElements[0].newTrackNumber,
    videoScale: video.timestampScale,
    audioScale: audio.timestampScale
  };
}

/**
 * Rewrites a WebM audio cluster for streaming insertion against a merged target TrackNumber.
 * @param {ArrayBuffer | Uint8Array} clusterInput
 * @param {number} targetTrackNumber
 * @param {number} srcScale
 * @param {number} dstScale
 * @returns {Uint8Array}
 */
export function rewriteAudioClusterForMux(clusterInput, targetTrackNumber, srcScale, dstScale) {
  return rewriteAudioCluster(toUint8(clusterInput), targetTrackNumber, srcScale, dstScale).bytes;
}

function trimLeadingWebmClusters(clusters, targetScaledTs, scale) {
  if (clusters.length <= 1) {
    return clusters;
  }
  let keepFrom = 0;
  for (let i = 0; i < clusters.length - 1; i += 1) {
    const nextMs = (readClusterTimestamp(clusters[i + 1]) * scale) / 1e6;
    if (nextMs <= targetScaledTs + 50) {
      keepFrom = i + 1;
    } else {
      break;
    }
  }
  return keepFrom > 0 ? clusters.slice(keepFrom) : clusters;
}

/**
 * Merges separate video and audio WebM streams into an ordered dual-track WebM Blob part array.
 * Preserves video cluster bytes without re-encoding and interleaves tracks chronologically.
 * @param {ArrayBuffer | Uint8Array | Array<ArrayBuffer | Uint8Array>} videoInput
 * @param {ArrayBuffer | Uint8Array | Array<ArrayBuffer | Uint8Array>} audioInput
 * @param {{ alignAbr?: boolean }} [options={}]
 * @returns {Array<Uint8Array>}
 */
export function mergeWebmVideoAndAudioParts(videoInput, audioInput, options = {}) {
  const video = splitWebmInitAndClusters(videoInput);
  const audio = splitWebmInitAndClusters(audioInput);

  if (video.clusters.length === 0 || audio.clusters.length === 0) {
    throw new Error('EMPTY_WEBM_CLUSTERS');
  }

  let videoClusters = video.clusters;
  let audioClusters = audio.clusters;
  if (options && options.alignAbr) {
    const vStartMs = (readClusterTimestamp(videoClusters[0]) * video.timestampScale) / 1e6;
    const aStartMs = (readClusterTimestamp(audioClusters[0]) * audio.timestampScale) / 1e6;
    if (vStartMs - aStartMs >= 500) {
      audioClusters = trimLeadingWebmClusters(audioClusters, vStartMs, audio.timestampScale);
    } else if (aStartMs - vStartMs >= 500) {
      videoClusters = trimLeadingWebmClusters(videoClusters, aStartMs, video.timestampScale);
    }
  }

  const maxVideoTrackNum = video.trackEntries.reduce(
    (max, entry) => Math.max(max, entry.trackNumber || 0),
    0
  );
  let nextTrackNum = maxVideoTrackNum + 1;
  const audioTrackEntryElements = audio.trackEntries.map((entry) => {
    const assigned = nextTrackNum;
    nextTrackNum += 1;
    return {
      newTrackNumber: assigned,
      element: rewriteTrackEntryElement(entry.data, assigned)
    };
  });
  const primaryAudioTrackNumber = audioTrackEntryElements[0].newTrackNumber;

  const mergedTracksElement = buildEbmlElement(ID_TRACKS, [
    ...video.trackEntries.map((entry) => entry.element),
    ...audioTrackEntryElements.map((entry) => entry.element)
  ]);

  const timelineItems = [];
  for (const vCluster of videoClusters) {
    timelineItems.push({
      ts: readClusterTimestamp(vCluster),
      order: 0,
      bytes: vCluster
    });
  }
  for (const aCluster of audioClusters) {
    const rewritten = rewriteAudioCluster(
      aCluster,
      primaryAudioTrackNumber,
      audio.timestampScale,
      video.timestampScale
    );
    timelineItems.push({
      ts: rewritten.timestampScaled,
      order: 1,
      bytes: rewritten.bytes
    });
  }
  timelineItems.sort((a, b) => (a.ts - b.ts) || (a.order - b.order));

  const segmentPayloadSize =
    video.infoElement.byteLength +
    mergedTracksElement.byteLength +
    timelineItems.reduce((sum, item) => sum + item.bytes.byteLength, 0);

  const segmentHeaderId = encodeEbmlId(ID_SEGMENT);
  const segmentHeaderSize = encodeVintValue(segmentPayloadSize);
  const segmentHeader = new Uint8Array(segmentHeaderId.byteLength + segmentHeaderSize.byteLength);
  segmentHeader.set(segmentHeaderId, 0);
  segmentHeader.set(segmentHeaderSize, segmentHeaderId.byteLength);

  return [
    video.ebmlHeader,
    segmentHeader,
    video.infoElement,
    mergedTracksElement,
    ...timelineItems.map((item) => item.bytes)
  ];
}
