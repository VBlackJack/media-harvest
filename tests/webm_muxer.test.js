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
  buildEbmlElement,
  countTracksInWebmInit,
  mergeWebmVideoAndAudioParts,
  parseEbmlElements,
  splitWebmInitAndClusters
} from '../src/shared/webm_muxer.js';

function uintBytes(val) {
  if (val === 0) {
    return new Uint8Array([0]);
  }
  const arr = [];
  let rem = val;
  while (rem > 0) {
    arr.unshift(rem & 0xff);
    rem = Math.floor(rem / 256);
  }
  return new Uint8Array(arr);
}

function makeSimpleBlock(trackNum, payloadByte) {
  return buildEbmlElement(0xa3, [new Uint8Array([0x80 | trackNum, 0x00, 0x10, 0x80, payloadByte])]);
}

function makeCluster(timestamp, blocks) {
  return buildEbmlElement(0x1f43b675, [
    buildEbmlElement(0xe7, [uintBytes(timestamp)]),
    ...blocks
  ]);
}

function makeWebmStream({ trackType, timestampScale = 1000000, clusters = [] }) {
  const ebml = buildEbmlElement(0x1a45dfa3, [
    buildEbmlElement(0x4286, [new Uint8Array([1])])
  ]);
  const info = buildEbmlElement(0x1549a966, [
    buildEbmlElement(0x2ad7b1, [uintBytes(timestampScale)])
  ]);
  const trackEntry = buildEbmlElement(0xae, [
    buildEbmlElement(0xd7, [new Uint8Array([1])]),
    buildEbmlElement(0x83, [new Uint8Array([trackType])])
  ]);
  const tracks = buildEbmlElement(0x1654ae6b, [trackEntry]);
  const segment = buildEbmlElement(0x18538067, [info, tracks, ...clusters]);
  return Buffer.concat([ebml, segment]);
}

test('mergeWebmVideoAndAudioParts combines video and audio WebM tracks with remapped audio blocks', () => {
  const videoBuf = makeWebmStream({
    trackType: 1,
    clusters: [
      makeCluster(0, [makeSimpleBlock(1, 0xaa)]),
      makeCluster(2000, [makeSimpleBlock(1, 0xab)])
    ]
  });
  const audioBuf = makeWebmStream({
    trackType: 2,
    clusters: [
      makeCluster(0, [makeSimpleBlock(1, 0xba)]),
      makeCluster(1000, [
        buildEbmlElement(0xa0, [
          buildEbmlElement(0xa1, [new Uint8Array([0x81, 0x00, 0x05, 0x00, 0xbb])])
        ])
      ])
    ]
  });

  const mergedParts = mergeWebmVideoAndAudioParts([videoBuf], [audioBuf]);
  const merged = Buffer.concat(mergedParts);
  assert.equal(countTracksInWebmInit(merged), 2);

  const split = splitWebmInitAndClusters(merged);
  assert.deepEqual(split.trackEntries.map((t) => t.trackNumber), [1, 2]);
  assert.equal(split.clusters.length, 4);

  const clusterTimestamps = split.clusters.map((c) => {
    const [el] = parseEbmlElements(c);
    const tsEl = parseEbmlElements(c, el.dataStart, el.end).find((x) => x.id === 0xe7);
    let val = 0;
    for (const b of tsEl.data) {
      val = (val * 256) + b;
    }
    return val;
  });
  assert.deepEqual(clusterTimestamps, [0, 0, 1000, 2000]);

  // Verify BlockGroup -> Block on the interleaved 1000ms audio cluster has TrackNumber VINT 0x82
  const [c2El] = parseEbmlElements(split.clusters[2]);
  const blockGroup = parseEbmlElements(split.clusters[2], c2El.dataStart, c2El.end).find((x) => x.id === 0xa0);
  const blockEl = parseEbmlElements(blockGroup.data).find((x) => x.id === 0xa1);
  assert.equal(blockEl.data[0], 0x82);
  assert.equal(blockEl.data[4], 0xbb);
});

test('mergeWebmVideoAndAudioParts rescales audio Cluster timestamps when TimestampScale differs', () => {
  const videoBuf = makeWebmStream({
    trackType: 1,
    timestampScale: 1000000,
    clusters: [makeCluster(1500, [makeSimpleBlock(1, 0x11)])]
  });
  const audioBuf = makeWebmStream({
    trackType: 2,
    timestampScale: 500000,
    clusters: [makeCluster(2000, [makeSimpleBlock(1, 0x22)])]
  });

  const merged = Buffer.concat(mergeWebmVideoAndAudioParts(videoBuf, audioBuf));
  const split = splitWebmInitAndClusters(merged);
  assert.equal(split.clusters.length, 2);

  const firstTsEl = parseEbmlElements(
    split.clusters[0],
    parseEbmlElements(split.clusters[0])[0].dataStart,
    parseEbmlElements(split.clusters[0])[0].end
  ).find((x) => x.id === 0xe7);
  const firstTs = (firstTsEl.data[0] << 8) | firstTsEl.data[1];
  // 2000 * 500000 / 1000000 = 1000, sorted before video's 1500
  assert.equal(firstTs, 1000);
});

test('mergeWebmVideoAndAudioParts rejects invalid or empty-cluster WebM inputs', () => {
  assert.throws(
    () => mergeWebmVideoAndAudioParts(new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])),
    /INVALID_WEBM_INIT/
  );
  const emptyVideo = makeWebmStream({ trackType: 1, clusters: [] });
  const nonEmptyAudio = makeWebmStream({
    trackType: 2,
    clusters: [makeCluster(0, [makeSimpleBlock(1, 0x22)])]
  });
  assert.throws(
    () => mergeWebmVideoAndAudioParts(emptyVideo, nonEmptyAudio),
    /EMPTY_WEBM_CLUSTERS/
  );
});

test('mergeWebmVideoAndAudioParts trims misaligned leading clusters when alignAbr is enabled', () => {
  const videoBuf = makeWebmStream({
    trackType: 1,
    timestampScale: 1000000,
    clusters: [
      makeCluster(10000, [makeSimpleBlock(1, 0xaa)]),
      makeCluster(12000, [makeSimpleBlock(1, 0xab)])
    ]
  });
  const audioBuf = makeWebmStream({
    trackType: 2,
    timestampScale: 1000000,
    clusters: [
      makeCluster(0, [makeSimpleBlock(1, 0xba)]),
      makeCluster(5000, [makeSimpleBlock(1, 0xbb)]),
      makeCluster(10000, [makeSimpleBlock(1, 0xbc)]),
      makeCluster(12000, [makeSimpleBlock(1, 0xbd)])
    ]
  });

  const merged = Buffer.concat(mergeWebmVideoAndAudioParts(videoBuf, audioBuf, { alignAbr: true }));
  const split = splitWebmInitAndClusters(merged);
  assert.equal(split.clusters.length, 4);
  const firstTsEl = parseEbmlElements(
    split.clusters[0],
    parseEbmlElements(split.clusters[0])[0].dataStart,
    parseEbmlElements(split.clusters[0])[0].end
  ).find((x) => x.id === 0xe7);
  let ts = 0;
  for (const b of firstTsEl.data) {
    ts = (ts * 256) + b;
  }
  assert.equal(ts, 10000);
});
