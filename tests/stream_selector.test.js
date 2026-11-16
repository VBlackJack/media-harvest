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
import {
  findCompanionAudioUrl,
  findMatchingStreamForDirectUrl,
  findSiblingStreamAudioUrl,
  mergeCapturedMediaEntry,
  rankVideoCandidates
} from '../src/shared/stream_selector.js';

test('mergeCapturedMediaEntry preserves master playlists when cap triggers eviction of older sub-assets', () => {
  const olderMaster = {
    url: 'https://video.twimg.com/amplify_video/999/pl/master.m3u8',
    type: MEDIA_TYPES.STREAM,
    isStream: true
  };
  let list = [olderMaster];
  for (let i = 0; i < 6; i += 1) {
    list = mergeCapturedMediaEntry(list, {
      url: `https://pbs.twimg.com/media/img_${i}.jpg`,
      type: MEDIA_TYPES.IMAGE,
      isStream: false
    }, 4);
  }
  assert.equal(list.length, 4);
  assert.equal(list.some((item) => item.url === olderMaster.url), true);

  const subPlaylist = {
    url: 'https://video.twimg.com/amplify_video/888/pl/avc1/720x1280/playlist.m3u8',
    type: MEDIA_TYPES.STREAM,
    isStream: true
  };
  list = mergeCapturedMediaEntry([subPlaylist, olderMaster], {
    url: 'https://video.twimg.com/amplify_video/777/pl/master_2.m3u8',
    type: MEDIA_TYPES.STREAM,
    isStream: true
  }, 2);
  assert.deepEqual(
    list.map((i) => i.url),
    [
      'https://video.twimg.com/amplify_video/777/pl/master_2.m3u8',
      'https://video.twimg.com/amplify_video/999/pl/master.m3u8'
    ]
  );
});

test('rankVideoCandidates, findMatchingStreamForDirectUrl, findSiblingStreamAudioUrl, and findCompanionAudioUrl select clean video/audio pairs', () => {
  const ranked = rankVideoCandidates([
    { url: 'https://video.twimg.com/ext_tw_video/1/pl/720x1280/vid.m3u8', isStream: true },
    { url: 'https://video.twimg.com/ext_tw_video/1/pl/master.m3u8', isStream: true },
    { url: 'https://cdn.example.com/clip.mp4', isStream: false }
  ]);
  assert.equal(ranked[0].url, 'https://video.twimg.com/ext_tw_video/1/pl/master.m3u8');

  const items = [
    { url: 'https://video.twimg.com/ext_tw_video/42/pl/mp4a/128000/aud.m3u8', type: MEDIA_TYPES.STREAM, isStream: true },
    { url: 'https://video.twimg.com/ext_tw_video/42/pl/avc1/1280x720/vid.m3u8', type: MEDIA_TYPES.STREAM, isStream: true },
    { url: 'https://cdn.example.com/reel/clip.mp4?vid=vid99123&mime=video_dash', type: MEDIA_TYPES.VIDEO, isStream: false },
    { url: 'https://other-cdn.example.net/audio_edge/file.m4a?vid=vid99123', type: MEDIA_TYPES.AUDIO, isStream: false }
  ];
  const matched = findMatchingStreamForDirectUrl('https://video.twimg.com/ext_tw_video/42/pu/vid/v.mp4', items);
  assert.ok(matched);
  assert.equal(
    findSiblingStreamAudioUrl(matched, items),
    'https://video.twimg.com/ext_tw_video/42/pl/mp4a/128000/aud.m3u8'
  );
  assert.equal(
    findCompanionAudioUrl('https://cdn.example.com/reel/clip.mp4?vid=vid99123&mime=video_dash', items),
    'https://other-cdn.example.net/audio_edge/file.m4a?vid=vid99123'
  );
});
