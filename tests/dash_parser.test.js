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
  decodeXmlEntities,
  expandDashTemplate,
  parseDashManifest,
  parseIsoDurationSec
} from '../src/shared/dash_parser.js';

test('parseIsoDurationSec and decodeXmlEntities handle standard DASH values', () => {
  assert.equal(parseIsoDurationSec('PT1H2M3.5S'), 3724);
  assert.equal(parseIsoDurationSec('P0Y0M0DT0H1M30S'), 90);
  assert.equal(parseIsoDurationSec('PT12.4S'), 12);
  assert.equal(parseIsoDurationSec(''), 0);
  assert.equal(decodeXmlEntities('a&amp;b&lt;c&gt;&quot;d&quot;&apos;e'), 'a&b<c>"d"\'e');
});

test('expandDashTemplate expands RepresentationID, Bandwidth, Number with padding, and Time', () => {
  const expanded = expandDashTemplate('seg/$RepresentationID$/$Bandwidth$/chunk-$Number%04d$-$Time$.m4s', {
    repId: 'v720',
    bandwidth: 1500000,
    number: 7,
    time: 4000
  });
  assert.equal(expanded, 'seg/v720/1500000/chunk-0007-4000.m4s');
});

test('parseDashManifest parses SegmentTemplate + SegmentTimeline static VOD and prefers MP4', () => {
  const mpd = `<?xml version="1.0" encoding="utf-8"?>
  <MPD type="static" mediaPresentationDuration="PT6S">
    <BaseURL>https://cdn.example.com/dash/</BaseURL>
    <Period>
      <AdaptationSet contentType="video" mimeType="video/mp4">
        <SegmentTemplate timescale="1000" initialization="$RepresentationID$/init.mp4" media="$RepresentationID$/seg-$Number%03d$.m4s" startNumber="1">
          <SegmentTimeline>
            <S t="0" d="2000" r="2"/>
          </SegmentTimeline>
        </SegmentTemplate>
        <Representation id="360p" bandwidth="800000" width="640" height="360"/>
        <Representation id="720p" bandwidth="2400000" width="1280" height="720"/>
      </AdaptationSet>
      <AdaptationSet contentType="video" mimeType="video/webm">
        <Representation id="vp9" bandwidth="3000000" width="1920" height="1080">
          <BaseURL>vp9.webm</BaseURL>
        </Representation>
      </AdaptationSet>
      <AdaptationSet contentType="audio" mimeType="audio/mp4" lang="en">
        <SegmentTemplate timescale="1000" initialization="audio/init.mp4" media="audio/seg-$Number$.m4s" startNumber="1">
          <SegmentTimeline>
            <S t="0" d="3000" r="1"/>
          </SegmentTimeline>
        </SegmentTemplate>
        <Representation id="a128" bandwidth="128000"/>
      </AdaptationSet>
    </Period>
  </MPD>`;

  const parsed = parseDashManifest(mpd, 'https://cdn.example.com/manifest.mpd');
  assert.equal(parsed.format, 'dash');
  assert.equal(parsed.encrypted, false);
  assert.equal(parsed.isDynamic, false);
  assert.equal(parsed.totalDurationSec, 6);
  assert.equal(parsed.variants.length, 2);
  assert.equal(parsed.variants[0].id, '720p');
  assert.equal(parsed.variants[0].resolution, '1280x720');
  assert.equal(parsed.variants[0].initSegmentUrl, 'https://cdn.example.com/dash/720p/init.mp4');
  assert.equal(parsed.variants[0].segments.length, 3);
  assert.equal(parsed.variants[0].segments[0].url, 'https://cdn.example.com/dash/720p/seg-001.m4s');
  assert.equal(parsed.variants[0].segments[2].url, 'https://cdn.example.com/dash/720p/seg-003.m4s');
  assert.equal(parsed.audioTracks.length, 1);
  assert.equal(parsed.audioTracks[0].initSegmentUrl, 'https://cdn.example.com/dash/audio/init.mp4');
  assert.equal(parsed.audioTracks[0].segments.length, 2);
});

test('parseDashManifest supports SegmentList, progressive BaseURL, ContentProtection, and dynamic rejection', () => {
  const segmentListMpd = `
  <MPD type="static" mediaPresentationDuration="PT4S">
    <Period>
      <AdaptationSet mimeType="video/mp4">
        <Representation id="v1" bandwidth="1000000" width="854" height="480">
          <SegmentList timescale="1" duration="2">
            <Initialization sourceURL="init.mp4"/>
            <SegmentURL media="part1.m4s"/>
            <SegmentURL media="part2.m4s"/>
          </SegmentList>
        </Representation>
      </AdaptationSet>
    </Period>
  </MPD>`;

  const listParsed = parseDashManifest(segmentListMpd, 'https://cdn.example.com/vod/stream.mpd');
  assert.equal(listParsed.variants.length, 1);
  assert.equal(listParsed.variants[0].initSegmentUrl, 'https://cdn.example.com/vod/init.mp4');
  assert.deepEqual(
    listParsed.variants[0].segments.map((s) => s.url),
    ['https://cdn.example.com/vod/part1.m4s', 'https://cdn.example.com/vod/part2.m4s']
  );

  const drmMpd = `
  <MPD type="dynamic">
    <Period>
      <AdaptationSet mimeType="video/mp4">
        <ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc"/>
        <Representation id="v1" bandwidth="1000000">
          <BaseURL>enc.mp4</BaseURL>
        </Representation>
      </AdaptationSet>
    </Period>
  </MPD>`;
  const drmParsed = parseDashManifest(drmMpd, 'https://cdn.example.com/drm.mpd');
  assert.equal(drmParsed.encrypted, true);
  assert.equal(drmParsed.encryptionMethod, 'cenc');
  assert.equal(drmParsed.isDynamic, true);

  assert.throws(() => parseDashManifest('<html><body>not mpd</body></html>', 'https://example.com/x.mpd'), /INVALID_DASH_MANIFEST/);
});

test('parseDashManifest supports duration-based SegmentTemplate, r=-1 repeat, and blocks non-HTTP schemes', () => {
  const durationMpd = `
  <MPD type="static" mediaPresentationDuration="PT6S">
    <Period>
      <AdaptationSet mimeType="video/mp4">
        <SegmentTemplate timescale="1" duration="2" startNumber="bad" initialization="data:text/plain,evil" media="chunk-$Number$.m4s"/>
        <Representation id="v1" bandwidth="1000000" width="640" height="360"/>
      </AdaptationSet>
    </Period>
  </MPD>`;
  const durParsed = parseDashManifest(durationMpd, 'https://cdn.example.com/vod/dur.mpd');
  assert.equal(durParsed.variants[0].initSegmentUrl, null);
  assert.deepEqual(
    durParsed.variants[0].segments.map((s) => s.url),
    [
      'https://cdn.example.com/vod/chunk-1.m4s',
      'https://cdn.example.com/vod/chunk-2.m4s',
      'https://cdn.example.com/vod/chunk-3.m4s'
    ]
  );

  const openRepeatMpd = `
  <MPD type="static" mediaPresentationDuration="PT6S">
    <Period>
      <AdaptationSet mimeType="video/mp4">
        <SegmentTemplate timescale="1000" media="seg-$Number$.m4s" startNumber="1">
          <SegmentTimeline>
            <S t="0" d="2000" r="-1"/>
          </SegmentTimeline>
        </SegmentTemplate>
        <Representation id="v1" bandwidth="900000"/>
      </AdaptationSet>
    </Period>
  </MPD>`;
  const repeatParsed = parseDashManifest(openRepeatMpd, 'https://cdn.example.com/vod/rep.mpd');
  assert.equal(repeatParsed.variants[0].segments.length, 3);
});
