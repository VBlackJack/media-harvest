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
import { MEDIA_TYPES } from '../src/config/constants.js';
import { attachVideoPreviews, extractMediaId } from '../src/shared/preview_matcher.js';

test('extractMediaId extracts X/Twitter media IDs from stream and thumb URLs', () => {
  assert.equal(
    extractMediaId('https://video.twimg.com/ext_tw_video/2121651904099078267/pu/pl/cat.m3u8?tag=12'),
    '2121651904099078267'
  );
  assert.equal(
    extractMediaId('https://pbs.twimg.com/ext_tw_video_thumb/2121651904099078267/pu/img/thumb.jpg'),
    '2121651904099078267'
  );
  assert.equal(extractMediaId('https://example.com/clip.mp4'), '');
});

test('attachVideoPreviews pairs multiple X streams with matching video posters', () => {
  const items = [
    { url: 'https://video.twimg.com/ext_tw_video/1111111111111111/pu/pl/a.m3u8', type: MEDIA_TYPES.STREAM },
    { url: 'https://video.twimg.com/ext_tw_video/2222222222222222/pu/pl/b.m3u8', type: MEDIA_TYPES.STREAM }
  ];
  const videoElements = [
    {
      src: 'blob:https://x.com/1',
      poster: 'https://pbs.twimg.com/ext_tw_video_thumb/2222222222222222/pu/img/b.jpg',
      frameDataUrl: '',
      width: 1280,
      height: 720,
      duration: 14
    },
    {
      src: 'blob:https://x.com/2',
      poster: 'https://pbs.twimg.com/ext_tw_video_thumb/1111111111111111/pu/img/a.jpg',
      frameDataUrl: '',
      width: 640,
      height: 360,
      duration: 7
    }
  ];

  const enriched = attachVideoPreviews(items, videoElements);
  assert.equal(enriched[0].poster, 'https://pbs.twimg.com/ext_tw_video_thumb/1111111111111111/pu/img/a.jpg');
  assert.equal(enriched[0].duration, 7);
  assert.equal(enriched[1].poster, 'https://pbs.twimg.com/ext_tw_video_thumb/2222222222222222/pu/img/b.jpg');
  assert.equal(enriched[1].width, 1280);
});

test('attachVideoPreviews falls back to single video frame when stream ID differs', () => {
  const items = [
    { url: 'https://cdn.example.com/hls/master.m3u8', type: MEDIA_TYPES.STREAM }
  ];
  const videoElements = [
    {
      src: 'blob:https://example.com/abc',
      poster: '',
      frameDataUrl: 'data:image/jpeg;base64,AAAA',
      width: 1920,
      height: 1080,
      duration: 30
    }
  ];

  const enriched = attachVideoPreviews(items, videoElements);
  assert.equal(enriched[0].poster, 'data:image/jpeg;base64,AAAA');
  assert.equal(enriched[0].duration, 30);
});

test('attachVideoPreviews pairs MSE items with matching blobUrl video frames and dimensions', () => {
  const items = [
    { url: 'mse://mse_1', blobUrl: 'blob:https://site.test/vid-1', isMse: true, type: MEDIA_TYPES.VIDEO },
    { url: 'mse://mse_2', blobUrl: 'blob:https://site.test/vid-2', isMse: true, type: MEDIA_TYPES.VIDEO }
  ];
  const videoElements = [
    {
      src: 'blob:https://site.test/vid-2',
      poster: '',
      frameDataUrl: 'data:image/jpeg;base64,VID2',
      width: 1080,
      height: 1920,
      duration: 22
    },
    {
      src: 'blob:https://site.test/vid-1',
      poster: '',
      frameDataUrl: 'data:image/jpeg;base64,VID1',
      width: 1280,
      height: 720,
      duration: 11
    }
  ];

  const enriched = attachVideoPreviews(items, videoElements);
  assert.equal(enriched[0].poster, 'data:image/jpeg;base64,VID1');
  assert.equal(enriched[0].width, 1280);
  assert.equal(enriched[0].duration, 11);
  assert.equal(enriched[1].poster, 'data:image/jpeg;base64,VID2');
  assert.equal(enriched[1].width, 1080);
  assert.equal(enriched[1].duration, 22);
});
