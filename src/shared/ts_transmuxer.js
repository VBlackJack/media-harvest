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

/**
 * Transmuxes MPEG-TS or ADTS segments into fragmented MP4 parts without allocating a single
 * contiguous output buffer.
 * @param {Array<ArrayBuffer | Uint8Array>} tsSegments
 * @param {new (opts?: object) => object} [TransmuxerCtor]
 * @param {{ flushPerSegment?: boolean }} [options]
 * @returns {{ initSegment: Uint8Array | null, dataChunks: Array<Uint8Array>, parts: Array<Uint8Array> }}
 */
export function transmuxTsSegmentsToMp4Parts(
  tsSegments,
  TransmuxerCtor,
  { flushPerSegment = false, discontinuityIndices = null } = {}
) {
  const Ctor = TransmuxerCtor || (globalThis.muxjs && globalThis.muxjs.Transmuxer);
  if (typeof Ctor !== 'function') {
    throw new Error('TRANSMUXER_UNAVAILABLE');
  }

  const discontinuitySet = discontinuityIndices instanceof Set
    ? discontinuityIndices
    : new Set(Array.isArray(discontinuityIndices) ? discontinuityIndices : []);

  const transmuxer = new Ctor({ keepOriginalTimestamps: false });
  let initSegment = null;
  const dataChunks = [];
  const parts = [];

  transmuxer.on('data', (segment) => {
    if (!initSegment && segment.initSegment && segment.initSegment.byteLength > 0) {
      initSegment = new Uint8Array(segment.initSegment);
      parts.push(initSegment);
    }
    if (segment.data && segment.data.byteLength > 0) {
      const dataPart = new Uint8Array(segment.data);
      dataChunks.push(dataPart);
      parts.push(dataPart);
    }
  });

  for (let i = 0; i < tsSegments.length; i += 1) {
    if (i > 0 && discontinuitySet.has(i)) {
      if (typeof transmuxer.endTimeline === 'function') {
        transmuxer.endTimeline();
      }
      transmuxer.flush();
    }
    const chunk = tsSegments[i];
    const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    transmuxer.push(bytes);
    if (flushPerSegment) {
      transmuxer.flush();
    }
  }
  if (!flushPerSegment) {
    transmuxer.flush();
  }

  if (parts.length === 0) {
    throw new Error('TRANSMUX_EMPTY');
  }

  return { initSegment, dataChunks, parts };
}

/**
 * Transmuxes MPEG-TS segments into a single fragmented MP4 byte buffer.
 * Accepts an optional Transmuxer constructor for testability; defaults to global muxjs.
 * @param {Array<ArrayBuffer | Uint8Array>} tsSegments
 * @param {new (opts?: object) => object} [TransmuxerCtor]
 * @returns {Uint8Array}
 */
export function transmuxTsSegmentsToMp4(tsSegments, TransmuxerCtor) {
  const { parts } = transmuxTsSegmentsToMp4Parts(tsSegments, TransmuxerCtor);
  const totalBytes = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(totalBytes);
  let cursor = 0;
  for (const part of parts) {
    out.set(part, cursor);
    cursor += part.byteLength;
  }
  return out;
}
