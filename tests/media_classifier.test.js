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
  classifyMedia,
  classifyMseMime,
  deduplicateMedia,
  deriveFilenameStem,
  extractUrlExtension,
  isHttpUrl,
  isMseUrl,
  normalizeMimeType,
  sanitizeFilename
} from '../src/shared/media_classifier.js';
import { LIMITS, MEDIA_SOURCES, MEDIA_TYPES } from '../src/config/constants.js';

test('extractUrlExtension ignores query strings and handles missing extensions', () => {
  assert.equal(extractUrlExtension('https://video.twimg.com/ext_tw_video/123/pu/vid/1280x720/cat.mp4?tag=12'), 'mp4');
  assert.equal(extractUrlExtension('https://example.com/media/stream.m3u8?token=abc'), 'm3u8');
  assert.equal(extractUrlExtension('https://example.com/noext'), '');
  assert.equal(extractUrlExtension('blob:https://x.com/uuid'), '');
});

test('classifyMedia classifies videos, streams, images, and skips segments and blobs', () => {
  assert.deepEqual(
    classifyMedia('https://video.twimg.com/ext_tw_video/123/pl/cat.m3u8?tag=12'),
    { type: MEDIA_TYPES.STREAM, ext: 'm3u8', isStream: true }
  );
  assert.deepEqual(
    classifyMedia('https://cdn.example.com/video', 'video/mp4; codecs="avc1"'),
    { type: MEDIA_TYPES.VIDEO, ext: 'mp4', isStream: false }
  );
  assert.deepEqual(
    classifyMedia('https://pbs.twimg.com/media/abc.jpg?format=jpg&name=large'),
    { type: MEDIA_TYPES.IMAGE, ext: 'jpg', isStream: false }
  );
  assert.equal(classifyMedia('https://video.twimg.com/seg_001.ts'), null);
  assert.equal(classifyMedia('https://video.twimg.com/seg_001.m4s'), null);
  assert.equal(classifyMedia('blob:https://x.com/1234-5678'), null);
});

test('sanitizeFilename strips invalid Windows characters and appends extension once', () => {
  assert.equal(sanitizeFilename('Cat: Video / Post? #1', 'mp4'), 'Cat_Video_Post_#1.mp4');
  assert.equal(sanitizeFilename('clip.mp4', 'mp4'), 'clip.mp4');
  assert.equal(sanitizeFilename('   ', 'jpg'), 'media.jpg');
});

test('deriveFilenameStem uses X status handle/id, URL stem, or page title fallback', () => {
  assert.equal(
    deriveFilenameStem(
      'https://video.twimg.com/ext_tw_video/2121651904099078267/pu/pl/cat.m3u8',
      'PunchingCat on X',
      'https://x.com/PunchingCat/status/2121651904099078267'
    ),
    'PunchingCat_2121651904099078267'
  );
  assert.equal(deriveFilenameStem('https://example.com/videos/funny_cat.mp4', 'X Post'), 'funny_cat');
  assert.equal(deriveFilenameStem('https://example.com/0123456789abcdef0123456789abcdef.mp4', 'Cat Post'), 'Cat Post');
});

test('deduplicateMedia merges metadata for identical URLs', () => {
  const merged = deduplicateMedia([
    { url: 'https://example.com/a.mp4', sizeBytes: 2048, width: 0, height: 0 },
    { url: 'https://example.com/a.mp4', sizeBytes: 0, width: 1280, height: 720, title: 'Cat' }
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].sizeBytes, 2048);
  assert.equal(merged[0].width, 1280);
  assert.equal(merged[0].title, 'Cat');
});

test('normalizeMimeType and isHttpUrl validate inputs safely', () => {
  assert.equal(normalizeMimeType('Video/MP4; codecs="avc1"'), 'video/mp4');
  assert.equal(normalizeMimeType(null), '');
  assert.equal(isHttpUrl('https://example.com/a.mp4'), true);
  assert.equal(isHttpUrl('http://example.com/a.mp4'), true);
  assert.equal(isHttpUrl('javascript:alert(1)'), false);
  assert.equal(isHttpUrl('blob:https://x.com/1'), false);
  assert.equal(isHttpUrl(undefined), false);
});

test('classifyMedia rejects HTML/JSON error pages while keeping octet-stream and text/plain HLS', () => {
  assert.equal(classifyMedia('https://example.com/video.mp4', 'text/html; charset=utf-8'), null);
  assert.equal(classifyMedia('https://example.com/api.json', 'application/json'), null);
  assert.equal(classifyMedia('https://example.com/readme.mp4', 'text/plain'), null);
  assert.deepEqual(
    classifyMedia('https://cdn.example.com/stream.m3u8', 'text/plain'),
    { type: MEDIA_TYPES.STREAM, ext: 'm3u8', isStream: true }
  );
  assert.deepEqual(
    classifyMedia('https://cdn.example.com/clip.mp4', 'application/octet-stream'),
    { type: MEDIA_TYPES.VIDEO, ext: 'mp4', isStream: false }
  );
});

test('sanitizeFilename enforces MAX_FILENAME_LENGTH and handles missing extensions', () => {
  const longName = 'a'.repeat(LIMITS.MAX_FILENAME_LENGTH + 30);
  const sanitized = sanitizeFilename(longName, '');
  assert.equal(sanitized.length, LIMITS.MAX_FILENAME_LENGTH + '.bin'.length);
  assert.ok(sanitized.endsWith('.bin'));
});

test('deduplicateMedia preserves network stream metadata when DOM fallback shares URL', () => {
  const merged = deduplicateMedia([
    {
      url: 'https://cdn.example.com/live',
      type: MEDIA_TYPES.STREAM,
      ext: 'm3u8',
      isStream: true,
      source: MEDIA_SOURCES.NETWORK,
      mimeType: 'application/vnd.apple.mpegurl'
    },
    {
      url: 'https://cdn.example.com/live',
      type: MEDIA_TYPES.VIDEO,
      ext: '',
      isStream: false,
      source: MEDIA_SOURCES.DOM,
      width: 1280,
      height: 720
    }
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].type, MEDIA_TYPES.STREAM);
  assert.equal(merged[0].ext, 'm3u8');
  assert.equal(merged[0].isStream, true);
  assert.equal(merged[0].source, MEDIA_SOURCES.NETWORK);
  assert.equal(merged[0].width, 1280);
});

test('classifyMedia recognizes DASH .mpd streams with XML and dash+xml MIME types', () => {
  assert.deepEqual(
    classifyMedia('https://cdn.example.com/live/manifest.mpd', 'application/dash+xml'),
    { type: MEDIA_TYPES.STREAM, ext: 'mpd', isStream: true }
  );
  assert.deepEqual(
    classifyMedia('https://cdn.example.com/live/manifest.mpd', 'application/xml; charset=utf-8'),
    { type: MEDIA_TYPES.STREAM, ext: 'mpd', isStream: true }
  );
  assert.deepEqual(
    classifyMedia('https://cdn.example.com/stream', 'application/dash+xml'),
    { type: MEDIA_TYPES.STREAM, ext: 'mpd', isStream: true }
  );
  assert.equal(classifyMedia('https://cdn.example.com/feed.rss', 'application/xml'), null);
});

test('classifyMedia recognizes subtitles and sanitizeFilename supports optional safe folders', () => {
  assert.deepEqual(
    classifyMedia('https://cdn.example.com/subs/en.vtt', 'text/vtt; charset=utf-8'),
    { type: MEDIA_TYPES.SUBTITLE, ext: 'vtt', isStream: false }
  );
  assert.deepEqual(
    classifyMedia('https://cdn.example.com/subs/fr.srt', 'text/plain'),
    { type: MEDIA_TYPES.SUBTITLE, ext: 'srt', isStream: false }
  );
  assert.deepEqual(
    classifyMedia('https://cdn.example.com/track', 'application/x-subrip'),
    { type: MEDIA_TYPES.SUBTITLE, ext: 'srt', isStream: false }
  );

  assert.equal(
    sanitizeFilename('example.com/Video Clip', 'mp4', { allowFolders: true }),
    'example.com/Video_Clip.mp4'
  );
  assert.equal(
    sanitizeFilename('../../secret/clip', 'mp4', { allowFolders: true }),
    'secret/clip.mp4'
  );
  assert.equal(
    sanitizeFilename('example.com/Video Clip', 'mp4', { allowFolders: false }),
    'example.com_Video_Clip.mp4'
  );
});

test('isMseUrl, classifyMseMime, and deduplicateMedia preserve MSE and referer metadata', () => {
  assert.equal(isMseUrl('mse://mse_123'), true);
  assert.equal(isMseUrl('https://cdn.example.com/v.mp4'), false);
  assert.deepEqual(classifyMseMime('video/webm; codecs="vp9"'), {
    type: MEDIA_TYPES.VIDEO,
    ext: 'webm',
    isStream: false,
    isMse: true
  });
  assert.deepEqual(classifyMseMime('audio/mp4; codecs="mp4a.40.2"'), {
    type: MEDIA_TYPES.AUDIO,
    ext: 'm4a',
    isStream: false,
    isMse: true
  });
  assert.equal(deriveFilenameStem('mse://mse_123', 'Concert Clip', 'https://example.com/watch'), 'Concert Clip');

  const merged = deduplicateMedia([
    {
      url: 'https://cdn.example.com/clip.mp4',
      type: MEDIA_TYPES.VIDEO,
      ext: 'mp4',
      isStream: false,
      source: MEDIA_SOURCES.DOM,
      referer: 'https://example.com/embed'
    },
    {
      url: 'https://cdn.example.com/clip.mp4',
      type: MEDIA_TYPES.VIDEO,
      ext: 'mp4',
      isStream: false,
      source: MEDIA_SOURCES.NETWORK,
      isMse: true,
      mseId: 'mse_9'
    }
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].referer, 'https://example.com/embed');
  assert.equal(merged[0].isMse, true);
  assert.equal(merged[0].mseId, 'mse_9');
});
