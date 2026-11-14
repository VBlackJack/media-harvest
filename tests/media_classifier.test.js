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
  deduplicateMedia,
  deriveFilenameStem,
  extractUrlExtension,
  sanitizeFilename
} from '../src/shared/media_classifier.js';
import { MEDIA_TYPES } from '../src/config/constants.js';

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
