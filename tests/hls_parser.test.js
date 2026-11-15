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
import { estimateHlsBytes, parseHlsPlaylist, selectBestVariant } from '../src/shared/hls_parser.js';

test('parseHlsPlaylist parses master playlist variants sorted by resolution and bandwidth', () => {
  const master = [
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Main",LANGUAGE="en",URI="/audio/main.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=832000,RESOLUTION=640x360,AUDIO="audio"',
    '/360p/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=2176000,RESOLUTION=1280x720,AUDIO="audio"',
    '/720p/index.m3u8'
  ].join('\n');

  const parsed = parseHlsPlaylist(master, 'https://video.twimg.com/ext_tw_video/1/pl/master.m3u8');
  assert.equal(parsed.isMaster, true);
  assert.equal(parsed.encrypted, false);
  assert.equal(parsed.variants.length, 2);
  assert.equal(parsed.variants[0].resolution, '1280x720');
  assert.equal(parsed.variants[0].url, 'https://video.twimg.com/720p/index.m3u8');
  assert.equal(parsed.audioTracks.length, 1);
  assert.equal(parsed.audioTracks[0].url, 'https://video.twimg.com/audio/main.m3u8');
  assert.equal(selectBestVariant(parsed.variants).resolution, '1280x720');
});

test('parseHlsPlaylist detects fMP4 init segment and outputs mp4 extension', () => {
  const media = [
    '#EXTM3U',
    '#EXT-X-MAP:URI="init.mp4"',
    '#EXTINF:3.0,',
    'seg1.m4s',
    '#EXTINF:2.5,',
    'seg2.m4s',
    '#EXT-X-ENDLIST'
  ].join('\n');

  const parsed = parseHlsPlaylist(media, 'https://cdn.example.com/hls/720p/index.m3u8');
  assert.equal(parsed.isMaster, false);
  assert.equal(parsed.initSegmentUrl, 'https://cdn.example.com/hls/720p/init.mp4');
  assert.equal(parsed.segments.length, 2);
  assert.equal(parsed.totalDurationSec, 6);
  assert.equal(estimateHlsBytes(2000000, parsed.totalDurationSec), 1500000);
  assert.equal(parsed.outputExtension, 'mp4');
});

test('parseHlsPlaylist flags encrypted streams explicitly', () => {
  const encrypted = [
    '#EXTM3U',
    '#EXT-X-KEY:METHOD=AES-128,URI="https://example.com/key"',
    '#EXTINF:4.0,',
    'seg1.ts'
  ].join('\n');

  const parsed = parseHlsPlaylist(encrypted, 'https://example.com/stream.m3u8');
  assert.equal(parsed.encrypted, true);
  assert.equal(parsed.encryptionMethod, 'AES-128');
});

test('parseHlsPlaylist handles METHOD=NONE, EXT-X-SESSION-KEY, and boundary helpers', () => {
  const clear = [
    '#EXTM3U',
    '#EXT-X-KEY:METHOD=NONE',
    '#EXTINF:2.0,',
    'seg1.ts'
  ].join('\n');
  const clearParsed = parseHlsPlaylist(clear, 'https://example.com/clear.m3u8');
  assert.equal(clearParsed.encrypted, false);
  assert.equal(clearParsed.outputExtension, 'ts');

  const sessionEncrypted = [
    '#EXTM3U',
    '#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,URI="skd://key"',
    '#EXT-X-STREAM-INF:BANDWIDTH=1000000',
    '720p.m3u8'
  ].join('\n');
  const sessionParsed = parseHlsPlaylist(sessionEncrypted, 'https://example.com/master.m3u8');
  assert.equal(sessionParsed.encrypted, true);
  assert.equal(sessionParsed.encryptionMethod, 'SAMPLE-AES');

  assert.equal(estimateHlsBytes(0, 10), 0);
  assert.equal(estimateHlsBytes(1000000, -5), 0);
  assert.equal(selectBestVariant([]), null);
});

test('parseHlsPlaylist parses EXT-X-BYTERANGE and EXT-X-MAP BYTERANGE per target URL', () => {
  const byterangePlaylist = [
    '#EXTM3U',
    '#EXT-X-MAP:URI="media.mp4",BYTERANGE="800@0"',
    '#EXTINF:4.0,',
    '#EXT-X-BYTERANGE:1000@800',
    'media.mp4',
    '#EXTINF:4.0,',
    '#EXT-X-BYTERANGE:1200',
    'media.mp4',
    '#EXTINF:4.0,',
    '#EXT-X-BYTERANGE:500@200',
    'other.mp4',
    '#EXTINF:4.0,',
    '#EXT-X-BYTERANGE:600',
    'media.mp4',
    '#EXT-X-ENDLIST'
  ].join('\n');

  const parsed = parseHlsPlaylist(byterangePlaylist, 'https://cdn.example.com/hls/playlist.m3u8');
  assert.equal(parsed.format, 'hls');
  assert.deepEqual(parsed.initSegmentByteRange, { offset: 0, length: 800 });
  assert.equal(parsed.segments.length, 4);
  assert.deepEqual(parsed.segments[0].byteRange, { offset: 800, length: 1000 });
  assert.deepEqual(parsed.segments[1].byteRange, { offset: 1800, length: 1200 });
  assert.deepEqual(parsed.segments[2].byteRange, { offset: 200, length: 500 });
  assert.deepEqual(parsed.segments[3].byteRange, { offset: 3000, length: 600 });
});

test('parseHlsPlaylist parses SUBTITLES tracks and detects live/event playlists accurately', () => {
  const masterWithSubs = [
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",URI="aud_en.m3u8"',
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="French",LANGUAGE="fr",DEFAULT=YES,URI="subs/fr.m3u8"',
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",URI="subs/en.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=1200000,RESOLUTION=1280x720,AUDIO="aud",SUBTITLES="subs"',
    '720p.m3u8'
  ].join('\n');

  const parsedMaster = parseHlsPlaylist(masterWithSubs, 'https://cdn.example.com/hls/master.m3u8');
  assert.equal(parsedMaster.isDynamic, false);
  assert.equal(parsedMaster.subtitles.length, 2);
  assert.deepEqual(parsedMaster.subtitles[0], {
    groupId: 'subs',
    name: 'French',
    language: 'fr',
    url: 'https://cdn.example.com/hls/subs/fr.m3u8',
    isDefault: true
  });
  assert.equal(parsedMaster.subtitles[1].url, 'https://cdn.example.com/hls/subs/en.m3u8');
  assert.equal(parsedMaster.subtitles[1].isDefault, false);

  const eventLive = parseHlsPlaylist(
    '#EXTM3U\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXTINF:4.0,\nseg1.ts',
    'https://cdn.example.com/hls/event.m3u8'
  );
  assert.equal(eventLive.isDynamic, true);

  const slidingWindowLive = parseHlsPlaylist(
    '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:100\n#EXTINF:4.0,\nseg100.ts',
    'https://cdn.example.com/hls/live.m3u8'
  );
  assert.equal(slidingWindowLive.isDynamic, true);

  const vodEnded = parseHlsPlaylist(
    '#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:4.0,\nseg1.ts',
    'https://cdn.example.com/hls/vod.m3u8'
  );
  assert.equal(vodEnded.isDynamic, false);

  const discontVod = parseHlsPlaylist(
    [
      '#EXTM3U',
      '#EXT-X-PLAYLIST-TYPE:VOD',
      '#EXTINF:4.0,',
      'pre.ts',
      '#EXT-X-DISCONTINUITY',
      '#EXTINF:6.0,',
      'ad.ts',
      '#EXT-X-ENDLIST'
    ].join('\n'),
    'https://cdn.example.com/hls/discont.m3u8'
  );
  assert.equal(discontVod.segments.length, 2);
  assert.equal(discontVod.segments[0].discontinuity, false);
  assert.equal(discontVod.segments[1].discontinuity, true);
  assert.equal(discontVod.discontinuityCount, 1);
});
