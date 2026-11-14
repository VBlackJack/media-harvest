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

const BOX_HEADER_SIZE = 8;
const FULL_BOX_VERSION_OFFSET = 8;
const TKHD_V0_TRACK_ID_OFFSET = 20;
const TKHD_V1_TRACK_ID_OFFSET = 28;
const TREX_TRACK_ID_OFFSET = 12;
const TFHD_TRACK_ID_OFFSET = 12;
const MVHD_V0_NEXT_TRACK_OFFSET = 104;
const MVHD_V1_NEXT_TRACK_OFFSET = 116;

/**
 * Reads a 4-character ASCII ISO BMFF box type at the given offset.
 * @param {Uint8Array} bytes
 * @param {number} offset
 * @returns {string}
 */
function readBoxType(bytes, offset) {
  return String.fromCharCode(
    bytes[offset],
    bytes[offset + 1],
    bytes[offset + 2],
    bytes[offset + 3]
  );
}

/**
 * Parses immediate child boxes within [start, end) of a byte buffer.
 * @param {Uint8Array} bytes
 * @param {number} [start=0]
 * @param {number} [end=bytes.length]
 * @returns {Array<{ type: string, start: number, end: number, data: Uint8Array }>}
 */
export function parseIsoBoxes(bytes, start = 0, end = bytes.length) {
  const boxes = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let cursor = start;

  while (cursor + BOX_HEADER_SIZE <= end) {
    const size = view.getUint32(cursor, false);
    if (size < BOX_HEADER_SIZE || cursor + size > end) {
      break;
    }
    const type = readBoxType(bytes, cursor + 4);
    boxes.push({
      type,
      start: cursor,
      end: cursor + size,
      data: bytes.subarray(cursor, cursor + size)
    });
    cursor += size;
  }

  return boxes;
}

/**
 * Wraps child box payloads inside a new container box with updated 32-bit size.
 * @param {string} type
 * @param {Array<Uint8Array>} children
 * @returns {Uint8Array}
 */
export function buildIsoBox(type, children) {
  const payloadBytes = children.reduce((sum, child) => sum + child.byteLength, 0);
  const totalSize = BOX_HEADER_SIZE + payloadBytes;
  const out = new Uint8Array(totalSize);
  const view = new DataView(out.buffer);

  view.setUint32(0, totalSize, false);
  for (let i = 0; i < 4; i += 1) {
    out[4 + i] = type.charCodeAt(i);
  }

  let offset = BOX_HEADER_SIZE;
  for (const child of children) {
    out.set(child, offset);
    offset += child.byteLength;
  }
  return out;
}

/**
 * Reads track_ID from a trak box via its tkhd child.
 * @param {Uint8Array} trakBytes
 * @returns {number}
 */
export function readTrackIdFromTrak(trakBytes) {
  const children = parseIsoBoxes(trakBytes, BOX_HEADER_SIZE);
  const tkhd = children.find((box) => box.type === 'tkhd');
  if (!tkhd) {
    return 0;
  }
  const version = tkhd.data[FULL_BOX_VERSION_OFFSET];
  const offset = version === 1 ? TKHD_V1_TRACK_ID_OFFSET : TKHD_V0_TRACK_ID_OFFSET;
  if (offset + 4 > tkhd.data.byteLength) {
    return 0;
  }
  const view = new DataView(tkhd.data.buffer, tkhd.data.byteOffset, tkhd.data.byteLength);
  return view.getUint32(offset, false);
}

/**
 * Clones a trak box and rewrites tkhd.track_ID in place.
 * @param {Uint8Array} trakBytes
 * @param {number} newTrackId
 * @returns {Uint8Array}
 */
function cloneTrakWithTrackId(trakBytes, newTrackId) {
  const cloned = new Uint8Array(trakBytes);
  const children = parseIsoBoxes(cloned, BOX_HEADER_SIZE);
  const tkhd = children.find((box) => box.type === 'tkhd');
  if (!tkhd) {
    return cloned;
  }
  const version = tkhd.data[FULL_BOX_VERSION_OFFSET];
  const relOffset = version === 1 ? TKHD_V1_TRACK_ID_OFFSET : TKHD_V0_TRACK_ID_OFFSET;
  if (relOffset + 4 <= tkhd.data.byteLength) {
    const view = new DataView(cloned.buffer, cloned.byteOffset + tkhd.start, tkhd.data.byteLength);
    view.setUint32(relOffset, newTrackId, false);
  }
  return cloned;
}

/**
 * Clones a trex box and rewrites its track_ID in place.
 * @param {Uint8Array} trexBytes
 * @param {number} newTrackId
 * @returns {Uint8Array}
 */
function cloneTrexWithTrackId(trexBytes, newTrackId) {
  const cloned = new Uint8Array(trexBytes);
  if (TREX_TRACK_ID_OFFSET + 4 <= cloned.byteLength) {
    new DataView(cloned.buffer).setUint32(TREX_TRACK_ID_OFFSET, newTrackId, false);
  }
  return cloned;
}

/**
 * Clones a media chunk (moof + mdat) and rewrites every traf/tfhd track_ID in place.
 * Preserves moof byte size so trun data_offset values remain exact.
 * @param {Uint8Array} chunkBytes
 * @param {number} newTrackId
 * @returns {Uint8Array}
 */
export function rewriteFragmentTrackId(chunkBytes, newTrackId) {
  const cloned = new Uint8Array(chunkBytes);
  const topBoxes = parseIsoBoxes(cloned);

  for (const box of topBoxes) {
    if (box.type !== 'moof') {
      continue;
    }
    const moofChildren = parseIsoBoxes(cloned, box.start + BOX_HEADER_SIZE, box.end);
    for (const traf of moofChildren) {
      if (traf.type !== 'traf') {
        continue;
      }
      const trafChildren = parseIsoBoxes(cloned, traf.start + BOX_HEADER_SIZE, traf.end);
      const tfhd = trafChildren.find((child) => child.type === 'tfhd');
      if (tfhd && TFHD_TRACK_ID_OFFSET + 4 <= tfhd.data.byteLength) {
        const view = new DataView(cloned.buffer, cloned.byteOffset + tfhd.start, tfhd.data.byteLength);
        view.setUint32(TFHD_TRACK_ID_OFFSET, newTrackId, false);
      }
    }
  }

  return cloned;
}

/**
 * Updates mvhd.next_track_ID when needed so the combined moov declares a valid next ID.
 * @param {Uint8Array} mvhdBytes
 * @param {number} minNextTrackId
 * @returns {Uint8Array}
 */
function cloneMvhdWithNextTrackId(mvhdBytes, minNextTrackId) {
  const cloned = new Uint8Array(mvhdBytes);
  const version = cloned[FULL_BOX_VERSION_OFFSET];
  const offset = version === 1 ? MVHD_V1_NEXT_TRACK_OFFSET : MVHD_V0_NEXT_TRACK_OFFSET;
  if (offset + 4 <= cloned.byteLength) {
    const view = new DataView(cloned.buffer);
    const current = view.getUint32(offset, false);
    if (current < minNextTrackId) {
      view.setUint32(offset, minNextTrackId, false);
    }
  }
  return cloned;
}

/**
 * Merges separate fMP4 video and audio init/media chunks into a single valid dual-track MP4 buffer.
 * @param {ArrayBuffer | Uint8Array} videoInitInput
 * @param {Array<ArrayBuffer | Uint8Array>} videoChunkInputs
 * @param {ArrayBuffer | Uint8Array} audioInitInput
 * @param {Array<ArrayBuffer | Uint8Array>} audioChunkInputs
 * @returns {Uint8Array}
 */
export function mergeFmp4VideoAndAudio(
  videoInitInput,
  videoChunkInputs,
  audioInitInput,
  audioChunkInputs
) {
  const videoInit = new Uint8Array(videoInitInput);
  const audioInit = new Uint8Array(audioInitInput);

  const videoTopBoxes = parseIsoBoxes(videoInit);
  const audioTopBoxes = parseIsoBoxes(audioInit);

  const ftypBox = videoTopBoxes.find((b) => b.type === 'ftyp');
  const videoMoov = videoTopBoxes.find((b) => b.type === 'moov');
  const audioMoov = audioTopBoxes.find((b) => b.type === 'moov');
  if (!videoMoov || !audioMoov) {
    throw new Error('INVALID_FMP4_INIT');
  }

  const videoMoovChildren = parseIsoBoxes(videoInit, videoMoov.start + BOX_HEADER_SIZE, videoMoov.end);
  const audioMoovChildren = parseIsoBoxes(audioInit, audioMoov.start + BOX_HEADER_SIZE, audioMoov.end);

  const maxVideoTrackId = videoMoovChildren
    .filter((b) => b.type === 'trak')
    .reduce((max, trak) => Math.max(max, readTrackIdFromTrak(trak.data)), 0);
  const audioTrackId = maxVideoTrackId + 1;

  const audioTraks = audioMoovChildren
    .filter((b) => b.type === 'trak')
    .map((trak) => cloneTrakWithTrackId(trak.data, audioTrackId));
  if (audioTraks.length === 0) {
    throw new Error('MISSING_AUDIO_TRACK');
  }

  const videoMvex = videoMoovChildren.find((b) => b.type === 'mvex');
  const audioMvex = audioMoovChildren.find((b) => b.type === 'mvex');
  const combinedMvexChildren = [];

  if (videoMvex) {
    for (const child of parseIsoBoxes(videoInit, videoMvex.start + BOX_HEADER_SIZE, videoMvex.end)) {
      combinedMvexChildren.push(child.data);
    }
  }
  if (audioMvex) {
    for (const child of parseIsoBoxes(audioInit, audioMvex.start + BOX_HEADER_SIZE, audioMvex.end)) {
      if (child.type === 'trex') {
        combinedMvexChildren.push(cloneTrexWithTrackId(child.data, audioTrackId));
      }
    }
  }

  const mergedMoovChildren = [];
  for (const child of videoMoovChildren) {
    if (child.type === 'mvhd') {
      mergedMoovChildren.push(cloneMvhdWithNextTrackId(child.data, audioTrackId + 1));
    } else if (child.type === 'mvex') {
      continue;
    } else {
      mergedMoovChildren.push(child.data);
    }
  }
  mergedMoovChildren.push(...audioTraks);
  if (combinedMvexChildren.length > 0) {
    mergedMoovChildren.push(buildIsoBox('mvex', combinedMvexChildren));
  }

  const mergedMoov = buildIsoBox('moov', mergedMoovChildren);
  const outputParts = [];
  if (ftypBox) {
    outputParts.push(ftypBox.data);
  }
  outputParts.push(mergedMoov);

  const maxPairs = Math.max(videoChunkInputs.length, audioChunkInputs.length);
  for (let i = 0; i < maxPairs; i += 1) {
    if (i < videoChunkInputs.length) {
      outputParts.push(new Uint8Array(videoChunkInputs[i]));
    }
    if (i < audioChunkInputs.length) {
      outputParts.push(rewriteFragmentTrackId(new Uint8Array(audioChunkInputs[i]), audioTrackId));
    }
  }

  const totalBytes = outputParts.reduce((sum, part) => sum + part.byteLength, 0);
  const merged = new Uint8Array(totalBytes);
  let cursor = 0;
  for (const part of outputParts) {
    merged.set(part, cursor);
    cursor += part.byteLength;
  }
  return merged;
}
