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
const TFHD_BASE_DATA_OFFSET_FLAG = 0x000001;
const TFHD_DEFAULT_BASE_IS_MOOF_FLAG = 0x020000;
const TFHD_FLAGS_OFFSET = 9;
const TFHD_BASE_DATA_OFFSET_POS = 16;
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
 * Strips tfhd base-data-offset-present (0x000001) into default-base-is-moof (0x020000) when present,
 * updating track_ID when newTrackId > 0 and keeping moof/traf/trun offsets consistent.
 * Returns input bytes zero-copy when no modification is needed.
 * @param {Uint8Array} chunkBytes
 * @param {number} newTrackId
 * @returns {Uint8Array}
 */
export function normalizeFmp4Fragment(chunkBytes, newTrackId = 0) {
  const topBoxes = parseIsoBoxes(chunkBytes);
  let needsBaseOffsetStrip = false;
  let hasMoof = false;

  for (const box of topBoxes) {
    if (box.type !== 'moof') {
      continue;
    }
    hasMoof = true;
    const moofChildren = parseIsoBoxes(chunkBytes, box.start + BOX_HEADER_SIZE, box.end);
    for (const traf of moofChildren) {
      if (traf.type !== 'traf') {
        continue;
      }
      const trafChildren = parseIsoBoxes(chunkBytes, traf.start + BOX_HEADER_SIZE, traf.end);
      const tfhd = trafChildren.find((child) => child.type === 'tfhd');
      if (tfhd && tfhd.data.byteLength >= TFHD_BASE_DATA_OFFSET_POS + 8) {
        const flags =
          (tfhd.data[TFHD_FLAGS_OFFSET] << 16) |
          (tfhd.data[TFHD_FLAGS_OFFSET + 1] << 8) |
          tfhd.data[TFHD_FLAGS_OFFSET + 2];
        if ((flags & TFHD_BASE_DATA_OFFSET_FLAG) !== 0) {
          needsBaseOffsetStrip = true;
        }
      }
    }
  }

  if (!hasMoof || (!needsBaseOffsetStrip && newTrackId <= 0)) {
    return chunkBytes;
  }

  if (!needsBaseOffsetStrip) {
    return rewriteFragmentTrackId(chunkBytes, newTrackId);
  }

  const rebuiltTopParts = [];
  for (const box of topBoxes) {
    if (box.type !== 'moof') {
      rebuiltTopParts.push(box.data);
      continue;
    }
    const oldMoofSize = box.data.byteLength;
    const moofChildren = parseIsoBoxes(chunkBytes, box.start + BOX_HEADER_SIZE, box.end);
    const trafAdjustments = [];
    let moofDelta = 0;

    for (const child of moofChildren) {
      if (child.type !== 'traf') {
        trafAdjustments.push({ kind: 'raw', data: child.data });
        continue;
      }
      const trafChildren = parseIsoBoxes(chunkBytes, child.start + BOX_HEADER_SIZE, child.end);
      let trafDelta = 0;
      const rebuiltTrafChildren = [];

      for (const tc of trafChildren) {
        if (tc.type !== 'tfhd') {
          rebuiltTrafChildren.push(tc.data);
          continue;
        }
        const flags =
          (tc.data[TFHD_FLAGS_OFFSET] << 16) |
          (tc.data[TFHD_FLAGS_OFFSET + 1] << 8) |
          tc.data[TFHD_FLAGS_OFFSET + 2];
        if ((flags & TFHD_BASE_DATA_OFFSET_FLAG) !== 0 && tc.data.byteLength >= TFHD_BASE_DATA_OFFSET_POS + 8) {
          const stripped = new Uint8Array(tc.data.byteLength - 8);
          stripped.set(tc.data.subarray(0, TFHD_BASE_DATA_OFFSET_POS), 0);
          stripped.set(tc.data.subarray(TFHD_BASE_DATA_OFFSET_POS + 8), TFHD_BASE_DATA_OFFSET_POS);
          new DataView(stripped.buffer).setUint32(0, stripped.byteLength, false);
          const nextFlags = (flags & ~TFHD_BASE_DATA_OFFSET_FLAG) | TFHD_DEFAULT_BASE_IS_MOOF_FLAG;
          stripped[TFHD_FLAGS_OFFSET] = (nextFlags >> 16) & 0xff;
          stripped[TFHD_FLAGS_OFFSET + 1] = (nextFlags >> 8) & 0xff;
          stripped[TFHD_FLAGS_OFFSET + 2] = nextFlags & 0xff;
          if (newTrackId > 0) {
            new DataView(stripped.buffer).setUint32(TFHD_TRACK_ID_OFFSET, newTrackId, false);
          }
          rebuiltTrafChildren.push(stripped);
          trafDelta -= 8;
        } else if (newTrackId > 0 && TFHD_TRACK_ID_OFFSET + 4 <= tc.data.byteLength) {
          const clonedTfhd = new Uint8Array(tc.data);
          new DataView(clonedTfhd.buffer).setUint32(TFHD_TRACK_ID_OFFSET, newTrackId, false);
          rebuiltTrafChildren.push(clonedTfhd);
        } else {
          rebuiltTrafChildren.push(tc.data);
        }
      }
      moofDelta += trafDelta;
      trafAdjustments.push({ kind: 'traf', children: rebuiltTrafChildren });
    }

    const newMoofSize = oldMoofSize + moofDelta;
    const finalizedMoofChildren = trafAdjustments.map((entry) => {
      if (entry.kind === 'raw') {
        return entry.data;
      }
      const adjustedChildren = entry.children.map((tcData) => {
        if (readBoxType(tcData, 4) !== 'trun' || tcData.byteLength < TRUN_DATA_OFFSET_POS + 4) {
          return tcData;
        }
        const flags = (tcData[9] << 16) | (tcData[10] << 8) | tcData[11];
        if ((flags & TRUN_DATA_OFFSET_FLAG) === 0) {
          return tcData;
        }
        const clonedTrun = new Uint8Array(tcData);
        const view = new DataView(clonedTrun.buffer);
        const currentOffset = view.getInt32(TRUN_DATA_OFFSET_POS, false);
        const nextOffset = currentOffset >= oldMoofSize
          ? currentOffset + moofDelta
          : newMoofSize + 8;
        view.setInt32(TRUN_DATA_OFFSET_POS, nextOffset, false);
        return clonedTrun;
      });
      return buildIsoBox('traf', adjustedChildren);
    });

    rebuiltTopParts.push(buildIsoBox('moof', finalizedMoofChildren));
  }

  let total = 0;
  for (const part of rebuiltTopParts) {
    total += part.byteLength;
  }
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const part of rebuiltTopParts) {
    out.set(part, cursor);
    cursor += part.byteLength;
  }
  return out;
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

function toUint8(input) {
  return input instanceof Uint8Array ? input : new Uint8Array(input);
}

/**
 * Counts how many trak boxes exist inside an fMP4 init segment.
 * @param {ArrayBuffer | Uint8Array} initInput
 * @returns {number}
 */
export function countTracksInInit(initInput) {
  const bytes = toUint8(initInput);
  const top = parseIsoBoxes(bytes);
  const moov = top.find((b) => b.type === 'moov');
  if (!moov) {
    return 0;
  }
  return parseIsoBoxes(bytes, moov.start + BOX_HEADER_SIZE, moov.end)
    .filter((b) => b.type === 'trak')
    .length;
}

/**
 * Checks whether an fMP4 init segment already declares an audio ('soun') track.
 * @param {ArrayBuffer | Uint8Array} initInput
 * @returns {boolean}
 */
export function hasAudioTrackInInit(initInput) {
  const bytes = toUint8(initInput);
  const top = parseIsoBoxes(bytes);
  const moov = top.find((b) => b.type === 'moov');
  if (!moov) {
    return false;
  }
  return parseIsoBoxes(bytes, moov.start + BOX_HEADER_SIZE, moov.end)
    .some((b) => b.type === 'trak' && readHandlerTypeFromTrak(b.data) === 'soun');
}

/**
 * Splits a combined fMP4 buffer (e.g. from mux.js) into its init box bytes and moof+mdat fragment views.
 * @param {ArrayBuffer | Uint8Array} input
 * @returns {{ initSegment: Uint8Array, fragments: Array<Uint8Array> }}
 */
export function splitFmp4InitAndFragments(input) {
  const bytes = toUint8(input);
  const topBoxes = parseIsoBoxes(bytes);
  const moovIndex = topBoxes.findIndex((b) => b.type === 'moov');
  if (moovIndex < 0) {
    throw new Error('INVALID_FMP4_INIT');
  }
  const initEnd = topBoxes[moovIndex].end;
  const initSegment = bytes.subarray(0, initEnd);
  const fragments = [];
  for (let i = moovIndex + 1; i < topBoxes.length; i += 1) {
    if (topBoxes[i].type === 'moof' && i + 1 < topBoxes.length && topBoxes[i + 1].type === 'mdat') {
      fragments.push(bytes.subarray(topBoxes[i].start, topBoxes[i + 1].end));
      i += 1;
    }
  }
  return { initSegment, fragments };
}

/**
 * Merges separate fMP4 video and audio initialization segments into `[ftyp?, mergedMoov]`
 * and returns the assigned `audioTrackId` for subsequent fragment rewriting.
 * @param {ArrayBuffer | Uint8Array} videoInitInput
 * @param {ArrayBuffer | Uint8Array} audioInitInput
 * @returns {{ initParts: Array<Uint8Array>, audioTrackId: number }}
 */
export function mergeFmp4InitSegments(videoInitInput, audioInitInput) {
  const videoInit = toUint8(videoInitInput);
  const audioInit = toUint8(audioInitInput);

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

  const allAudioTraks = audioMoovChildren.filter((b) => b.type === 'trak');
  const sounAudioTraks = allAudioTraks.filter((b) => readHandlerTypeFromTrak(b.data) === 'soun');
  const selectedAudioTraks = sounAudioTraks.length > 0 ? sounAudioTraks : allAudioTraks;
  const sourceAudioTrackIds = new Set(
    selectedAudioTraks.map((trak) => readTrackIdFromTrak(trak.data)).filter((id) => id > 0)
  );
  const audioTraks = selectedAudioTraks.map((trak) => cloneTrakWithTrackId(trak.data, audioTrackId));
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
        const trexTrackId = TREX_TRACK_ID_OFFSET + 4 <= child.data.byteLength
          ? new DataView(child.data.buffer, child.data.byteOffset, child.data.byteLength)
            .getUint32(TREX_TRACK_ID_OFFSET, false)
          : 0;
        if (sourceAudioTrackIds.size === 0 || sourceAudioTrackIds.has(trexTrackId)) {
          combinedMvexChildren.push(cloneTrexWithTrackId(child.data, audioTrackId));
        }
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
  const initParts = [];
  if (ftypBox) {
    initParts.push(ftypBox.data);
  }
  initParts.push(mergedMoov);
  return { initParts, audioTrackId };
}

/**
 * Merges separate fMP4 video and audio init/media chunks into an ordered array of Uint8Array parts,
 * avoiding a single large contiguous buffer copy for Blob creation.
 * @param {ArrayBuffer | Uint8Array} videoInitInput
 * @param {Array<ArrayBuffer | Uint8Array>} videoChunkInputs
 * @param {ArrayBuffer | Uint8Array} audioInitInput
 * @param {Array<ArrayBuffer | Uint8Array>} audioChunkInputs
 * @returns {Array<Uint8Array>}
 */
export function mergeFmp4VideoAndAudioParts(
  videoInitInput,
  videoChunkInputs,
  audioInitInput,
  audioChunkInputs
) {
  const { initParts, audioTrackId } = mergeFmp4InitSegments(videoInitInput, audioInitInput);
  const outputParts = [...initParts];

  const maxPairs = Math.max(videoChunkInputs.length, audioChunkInputs.length);
  for (let i = 0; i < maxPairs; i += 1) {
    if (i < videoChunkInputs.length) {
      outputParts.push(normalizeFmp4Fragment(toUint8(videoChunkInputs[i]), 0));
    }
    if (i < audioChunkInputs.length) {
      outputParts.push(normalizeFmp4Fragment(toUint8(audioChunkInputs[i]), audioTrackId));
    }
  }

  return outputParts;
}

const HDLR_HANDLER_OFFSET = 16;
const TRUN_DATA_OFFSET_FLAG = 0x000001;
const TRUN_DATA_OFFSET_POS = 16;

/**
 * Reads the 4-character media handler type (e.g. 'soun', 'vide') from a trak box.
 * @param {Uint8Array} trakBytes
 * @returns {string}
 */
export function readHandlerTypeFromTrak(trakBytes) {
  const trakChildren = parseIsoBoxes(trakBytes, BOX_HEADER_SIZE);
  const mdia = trakChildren.find((box) => box.type === 'mdia');
  if (!mdia) {
    return '';
  }
  const mdiaChildren = parseIsoBoxes(trakBytes, mdia.start + BOX_HEADER_SIZE, mdia.end);
  const hdlr = mdiaChildren.find((box) => box.type === 'hdlr');
  if (!hdlr || HDLR_HANDLER_OFFSET + 4 > hdlr.data.byteLength) {
    return '';
  }
  return readBoxType(hdlr.data, HDLR_HANDLER_OFFSET);
}

/**
 * Adjusts signed trun data_offset fields inside a cloned traf box by deltaBytes.
 * @param {Uint8Array} trafBytes
 * @param {number} deltaBytes
 * @returns {Uint8Array}
 */
function shiftTrafTrunDataOffsets(trafBytes, deltaBytes) {
  if (!deltaBytes) {
    return trafBytes;
  }
  const cloned = new Uint8Array(trafBytes);
  const children = parseIsoBoxes(cloned, BOX_HEADER_SIZE);
  for (const child of children) {
    if (child.type !== 'trun' || child.data.byteLength < TRUN_DATA_OFFSET_POS + 4) {
      continue;
    }
    const flags = (child.data[9] << 16) | (child.data[10] << 8) | child.data[11];
    if ((flags & TRUN_DATA_OFFSET_FLAG) === 0) {
      continue;
    }
    const view = new DataView(cloned.buffer, cloned.byteOffset + child.start, child.data.byteLength);
    const currentOffset = view.getInt32(TRUN_DATA_OFFSET_POS, false);
    view.setInt32(TRUN_DATA_OFFSET_POS, currentOffset + deltaBytes, false);
  }
  return cloned;
}

/**
 * Reads track_ID from the first tfhd box inside a traf box.
 * @param {Uint8Array} trafBytes
 * @returns {number}
 */
function readTrackIdFromTraf(trafBytes) {
  const children = parseIsoBoxes(trafBytes, BOX_HEADER_SIZE);
  const tfhd = children.find((box) => box.type === 'tfhd');
  if (!tfhd || TFHD_TRACK_ID_OFFSET + 4 > tfhd.data.byteLength) {
    return 0;
  }
  const view = new DataView(tfhd.data.buffer, tfhd.data.byteOffset, tfhd.data.byteLength);
  return view.getUint32(TFHD_TRACK_ID_OFFSET, false);
}

/**
 * Extracts only the audio ('soun') track from a single or multi-track fMP4 init + fragment list.
 * @param {ArrayBuffer | Uint8Array} initInput
 * @param {Array<ArrayBuffer | Uint8Array>} [fragmentInputs=[]]
 * @returns {Array<Uint8Array>}
 */
export function extractAudioOnlyFromFmp4Parts(initInput, fragmentInputs = []) {
  const initBytes = toUint8(initInput);
  const topBoxes = parseIsoBoxes(initBytes);
  const ftypBox = topBoxes.find((b) => b.type === 'ftyp');
  const moovBox = topBoxes.find((b) => b.type === 'moov');
  if (!moovBox) {
    throw new Error('INVALID_FMP4_INIT');
  }

  const moovChildren = parseIsoBoxes(initBytes, moovBox.start + BOX_HEADER_SIZE, moovBox.end);
  const allTraks = moovChildren.filter((b) => b.type === 'trak');
  const audioTraks = allTraks.filter((b) => readHandlerTypeFromTrak(b.data) === 'soun');
  if (audioTraks.length === 0) {
    throw new Error('NO_AUDIO_TRACK');
  }

  const audioTrackIds = new Set(audioTraks.map((b) => readTrackIdFromTrak(b.data)).filter((id) => id > 0));
  const rawFragments = fragmentInputs.map((part) => toUint8(part)).filter((part) => part.byteLength > 0);
  if (audioTraks.length === allTraks.length) {
    return [initBytes, ...rawFragments];
  }

  const rebuiltMoovChildren = [];
  for (const child of moovChildren) {
    if (child.type === 'trak') {
      if (readHandlerTypeFromTrak(child.data) === 'soun') {
        rebuiltMoovChildren.push(child.data);
      }
    } else if (child.type === 'mvex') {
      const mvexChildren = parseIsoBoxes(initBytes, child.start + BOX_HEADER_SIZE, child.end);
      const keptMvex = mvexChildren
        .filter((mc) => {
          if (mc.type !== 'trex' || TREX_TRACK_ID_OFFSET + 4 > mc.data.byteLength) {
            return true;
          }
          const trackId = new DataView(mc.data.buffer, mc.data.byteOffset, mc.data.byteLength)
            .getUint32(TREX_TRACK_ID_OFFSET, false);
          return audioTrackIds.has(trackId);
        })
        .map((mc) => mc.data);
      if (keptMvex.length > 0) {
        rebuiltMoovChildren.push(buildIsoBox('mvex', keptMvex));
      }
    } else {
      rebuiltMoovChildren.push(child.data);
    }
  }

  const outputParts = [];
  if (ftypBox) {
    outputParts.push(ftypBox.data);
  }
  outputParts.push(buildIsoBox('moov', rebuiltMoovChildren));

  for (const frag of rawFragments) {
    const fragTopBoxes = parseIsoBoxes(frag);
    let idx = 0;
    while (idx < fragTopBoxes.length) {
      const box = fragTopBoxes[idx];
      if (box.type !== 'moof') {
        if (box.type !== 'mdat') {
          outputParts.push(box.data);
        }
        idx += 1;
        continue;
      }

      const nextBox = idx + 1 < fragTopBoxes.length && fragTopBoxes[idx + 1].type === 'mdat'
        ? fragTopBoxes[idx + 1]
        : null;
      const moofChildren = parseIsoBoxes(frag, box.start + BOX_HEADER_SIZE, box.end);
      const trafBoxes = moofChildren.filter((c) => c.type === 'traf');
      const audioTrafBoxes = trafBoxes.filter((t) => audioTrackIds.has(readTrackIdFromTraf(t.data)));

      if (audioTrafBoxes.length === 0) {
        idx += nextBox ? 2 : 1;
        continue;
      }

      if (audioTrafBoxes.length === trafBoxes.length) {
        outputParts.push(box.data);
        if (nextBox) {
          outputParts.push(nextBox.data);
        }
        idx += nextBox ? 2 : 1;
        continue;
      }

      const prebuiltChildren = [];
      for (const mc of moofChildren) {
        if (mc.type !== 'traf' || audioTrackIds.has(readTrackIdFromTraf(mc.data))) {
          prebuiltChildren.push(mc.data);
        }
      }
      const newMoofSize = BOX_HEADER_SIZE + prebuiltChildren.reduce((sum, c) => sum + c.byteLength, 0);
      const offsetDelta = newMoofSize - box.data.byteLength;
      const adjustedChildren = prebuiltChildren.map((childData) => {
        if (readBoxType(childData, 4) === 'traf') {
          return shiftTrafTrunDataOffsets(childData, offsetDelta);
        }
        return childData;
      });
      outputParts.push(buildIsoBox('moof', adjustedChildren));
      if (nextBox) {
        outputParts.push(nextBox.data);
      }
      idx += nextBox ? 2 : 1;
    }
  }

  return outputParts;
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
  const outputParts = mergeFmp4VideoAndAudioParts(
    videoInitInput,
    videoChunkInputs,
    audioInitInput,
    audioChunkInputs
  );
  const totalBytes = outputParts.reduce((sum, part) => sum + part.byteLength, 0);
  const merged = new Uint8Array(totalBytes);
  let cursor = 0;
  for (const part of outputParts) {
    merged.set(part, cursor);
    cursor += part.byteLength;
  }
  return merged;
}

function readTrackTimescaleFromInit(initBytes) {
  const top = parseIsoBoxes(initBytes);
  const moov = top.find((b) => b.type === 'moov');
  if (!moov) {
    return 0;
  }
  const trak = parseIsoBoxes(initBytes, moov.start + BOX_HEADER_SIZE, moov.end).find((b) => b.type === 'trak');
  if (!trak) {
    return 0;
  }
  const mdia = parseIsoBoxes(initBytes, trak.start + BOX_HEADER_SIZE, trak.end).find((b) => b.type === 'mdia');
  if (!mdia) {
    return 0;
  }
  const mdhd = parseIsoBoxes(initBytes, mdia.start + BOX_HEADER_SIZE, mdia.end).find((b) => b.type === 'mdhd');
  if (!mdhd || mdhd.data.byteLength < 24) {
    return 0;
  }
  const version = mdhd.data[FULL_BOX_VERSION_OFFSET];
  const tsPos = version === 1 ? 28 : 20;
  if (tsPos + 4 > mdhd.data.byteLength) {
    return 0;
  }
  return new DataView(mdhd.data.buffer, mdhd.data.byteOffset, mdhd.data.byteLength).getUint32(tsPos, false);
}

function readFragmentDecodeTimeSec(fragmentBytes, timescale) {
  if (!timescale || timescale <= 0) {
    return null;
  }
  const bytes = toUint8(fragmentBytes);
  const moof = parseIsoBoxes(bytes).find((b) => b.type === 'moof');
  if (!moof) {
    return null;
  }
  const traf = parseIsoBoxes(bytes, moof.start + BOX_HEADER_SIZE, moof.end).find((b) => b.type === 'traf');
  if (!traf) {
    return null;
  }
  const tfdt = parseIsoBoxes(bytes, traf.start + BOX_HEADER_SIZE, traf.end).find((b) => b.type === 'tfdt');
  if (!tfdt || tfdt.data.byteLength < 16) {
    return null;
  }
  const version = tfdt.data[FULL_BOX_VERSION_OFFSET];
  const view = new DataView(tfdt.data.buffer, tfdt.data.byteOffset, tfdt.data.byteLength);
  const rawTicks = version === 1 && tfdt.data.byteLength >= 20
    ? Number(view.getBigUint64(12, false))
    : view.getUint32(12, false);
  return Number.isFinite(rawTicks) ? rawTicks / timescale : null;
}

function trimEarlierFragments(fragments, timescale, targetStartSec) {
  if (fragments.length <= 1) {
    return fragments;
  }
  let keepFrom = 0;
  for (let i = 0; i < fragments.length - 1; i += 1) {
    const nextSec = readFragmentDecodeTimeSec(fragments[i + 1], timescale);
    if (nextSec !== null && nextSec <= targetStartSec + 0.05) {
      keepFrom = i + 1;
    } else {
      break;
    }
  }
  return keepFrom > 0 ? fragments.slice(keepFrom) : fragments;
}

/**
 * Aligns video and audio MSE fragment arrays when one track was reset mid-playback
 * due to an ABR resolution switch (keeping both tracks starting at the same timestamp).
 * @param {Uint8Array} videoInit
 * @param {Array<Uint8Array>} videoFrags
 * @param {Uint8Array} audioInit
 * @param {Array<Uint8Array>} audioFrags
 * @returns {{ videoFrags: Array<Uint8Array>, audioFrags: Array<Uint8Array> }}
 */
export function alignFmp4MseFragments(videoInit, videoFrags, audioInit, audioFrags) {
  if (videoFrags.length === 0 || audioFrags.length === 0) {
    return { videoFrags, audioFrags };
  }
  const videoScale = readTrackTimescaleFromInit(videoInit);
  const audioScale = readTrackTimescaleFromInit(audioInit);
  const vStartSec = readFragmentDecodeTimeSec(videoFrags[0], videoScale);
  const aStartSec = readFragmentDecodeTimeSec(audioFrags[0], audioScale);
  if (vStartSec === null || aStartSec === null || Math.abs(vStartSec - aStartSec) < 0.5) {
    return { videoFrags, audioFrags };
  }
  if (vStartSec > aStartSec) {
    return {
      videoFrags,
      audioFrags: trimEarlierFragments(audioFrags, audioScale, vStartSec)
    };
  }
  return {
    videoFrags: trimEarlierFragments(videoFrags, videoScale, aStartSec),
    audioFrags
  };
}
