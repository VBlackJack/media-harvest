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
import { LIMITS, SORT_MODES, UNIT_CONVERSIONS } from '../src/config/constants.js';
import {
  formatBytes,
  formatDuration,
  getEstimatedStreamBytes,
  localizeError,
  matchesFilter,
  matchesImageQuickFilters,
  matchesSearch,
  runWithConcurrency,
  sortMediaItems
} from '../src/popup/popup_helpers.js';

test('formatBytes and formatDuration produce compact readable strings', () => {
  assert.equal(formatBytes(0), '');
  assert.equal(formatBytes(512), '1 KB');
  assert.equal(formatBytes(2048), '2 KB');
  assert.equal(formatBytes(3 * 1024 * 1024), '3.0 MB');

  assert.equal(formatDuration(0), '');
  assert.equal(formatDuration(9), '0:09');
  assert.equal(formatDuration(125), '2:05');
});

test('localizeError maps all known internal error codes cleanly', () => {
  const translate = (key, args = []) => (args.length ? `${key}:${args.join(',')}` : key);

  assert.equal(localizeError('ENCRYPTED_STREAM', translate), 'popup_error_encrypted_stream');
  assert.equal(localizeError('LIVE_STREAM', translate), 'popup_error_live_stream');
  assert.equal(localizeError('EMPTY_PLAYLIST', translate), 'popup_error_empty_playlist');
  assert.equal(localizeError('FETCH_TIMEOUT', translate), 'popup_error_fetch_timeout');
  assert.equal(localizeError('INVALID_URL', translate), 'popup_error_invalid_url');
  assert.equal(localizeError('INVALID_DASH_MANIFEST', translate), 'popup_error_invalid_manifest');
  assert.equal(localizeError('PLAY_FIRST', translate), 'popup_error_play_first');
  assert.equal(localizeError('CLEAR_FAILED', translate), 'popup_error_clear_failed');
  assert.equal(localizeError('INVALID_FMP4_INIT', translate), 'popup_error_invalid_fmp4');
  assert.equal(localizeError('MISSING_AUDIO_TRACK', translate), 'popup_error_missing_audio');
  assert.equal(localizeError('TRANSMUXER_UNAVAILABLE', translate), 'popup_error_transmux_failed');
  assert.equal(localizeError('TRANSMUX_EMPTY', translate), 'popup_error_transmux_failed');
  assert.equal(localizeError('BUILD_ABORTED', translate), 'popup_error_build_aborted');
  assert.equal(localizeError('IMAGE_CONVERT_FAILED', translate), 'popup_error_image_convert');
  assert.equal(localizeError('HLS_ERROR', translate), 'popup_error_stream_failed');
  assert.equal(localizeError('DOWNLOAD_FAILED', translate), 'popup_error_generic_download');
  const expectedMaxMb = String(Math.round(LIMITS.MAX_HLS_BUFFER_BYTES / UNIT_CONVERSIONS.BYTES_PER_MB));
  assert.equal(localizeError('STREAM_TOO_LARGE', translate), `popup_error_stream_too_large:${expectedMaxMb}`);
  assert.equal(localizeError('HTTP 404', translate), 'popup_error_download_failed:HTTP 404');
});

test('matchesFilter and getEstimatedStreamBytes handle media categories and variant selection', () => {
  assert.equal(matchesFilter({ type: 'stream' }, 'videos'), true);
  assert.equal(matchesFilter({ type: 'video' }, 'videos'), true);
  assert.equal(matchesFilter({ type: 'image' }, 'videos'), false);
  assert.equal(matchesFilter({ type: 'image' }, 'images'), true);
  assert.equal(matchesFilter({ type: 'image', ext: 'svg' }, 'svg'), true);
  assert.equal(matchesFilter({ type: 'image', ext: 'png' }, 'svg'), false);
  assert.equal(matchesSearch({ suggestedFilename: 'icon', ext: 'svg', url: 'data:image/svg+xml,' }, 'is:svg'), true);
  assert.equal(matchesSearch({ suggestedFilename: 'photo', ext: 'jpg', url: 'https://a.com/p.jpg' }, 'is:svg'), false);
  assert.equal(matchesFilter({ type: 'audio' }, 'audio'), true);

  const metaByUrl = new Map([
    [
      'https://example.com/master.m3u8',
      {
        variants: [
          { url: 'https://example.com/1080.m3u8', estimatedBytes: 5000 },
          { url: 'https://example.com/480.m3u8', estimatedBytes: 1200 }
        ]
      }
    ]
  ]);

  const entry = {
    item: { url: 'https://example.com/master.m3u8', estimatedBytes: 100 },
    qualitySelect: {
      value: 'https://example.com/480.m3u8',
      classList: { contains: () => false }
    }
  };
  assert.equal(getEstimatedStreamBytes(entry, metaByUrl), 1200);
});

test('runWithConcurrency bounds simultaneous workers and preserves output order', async () => {
  let active = 0;
  let maxActive = 0;

  const output = await runWithConcurrency([10, 20, 30, 40, 50], 2, async (item) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active -= 1;
    return item * 2;
  });

  assert.equal(maxActive, 2);
  assert.deepEqual(output, [20, 40, 60, 80, 100]);
});

test('matchesSearch and sortMediaItems filter and order media items deterministically', () => {
  const items = [
    { url: 'https://cdn.example.com/a.mp4', suggestedFilename: 'intro.mp4', sizeBytes: 100, width: 640, height: 360, duration: 15 },
    { url: 'https://cdn.example.com/b.m3u8', suggestedFilename: 'keynote.mp4', duration: 0 },
    { url: 'https://cdn.example.com/c.jpg', suggestedFilename: 'banner.jpg', sizeBytes: 500, width: 1920, height: 1080 }
  ];
  const metaByUrl = new Map([
    [
      'https://cdn.example.com/b.m3u8',
      {
        totalDurationSec: 120,
        variants: [{ width: 3840, height: 2160, estimatedBytes: 5000 }]
      }
    ]
  ]);

  assert.equal(matchesSearch(items[0], 'KEYNOTE'), false);
  assert.equal(matchesSearch(items[1], 'KEYNOTE'), true);
  assert.equal(matchesSearch(items[2], 'cdn.example.com/c'), true);
  assert.equal(matchesSearch(items[0], '   '), true);

  // Power search tokens: ext, is, size, resolution
  const richItems = [
    { url: 'https://cdn.example.com/video.mp4', suggestedFilename: 'video.mp4', ext: 'mp4', type: 'video', sizeBytes: 15 * 1024 * 1024, height: 1080, width: 1920 },
    { url: 'https://cdn.example.com/stream.m3u8', suggestedFilename: 'live.m3u8', ext: 'm3u8', isStream: true, type: 'stream', sizeBytes: 0, height: 720, width: 1280 },
    { url: 'https://cdn.example.com/photo.jpg', suggestedFilename: 'photo.jpg', ext: 'jpg', type: 'image', sizeBytes: 250 * 1024, height: 800, width: 600 }
  ];
  assert.equal(matchesSearch(richItems[0], 'ext:mp4 >10m 1080p'), true);
  assert.equal(matchesSearch(richItems[1], 'ext:mp4'), false);
  assert.equal(matchesSearch(richItems[1], 'is:stream 720p'), true);
  assert.equal(matchesSearch(richItems[2], 'is:image <500k'), true);
  assert.equal(matchesSearch(richItems[2], 'is:video'), false);

  assert.deepEqual(sortMediaItems(items, SORT_MODES.DEFAULT, metaByUrl).map((i) => i.suggestedFilename), [
    'intro.mp4',
    'keynote.mp4',
    'banner.jpg'
  ]);
  assert.deepEqual(sortMediaItems(items, SORT_MODES.SIZE_DESC, metaByUrl).map((i) => i.suggestedFilename), [
    'keynote.mp4',
    'banner.jpg',
    'intro.mp4'
  ]);
  assert.deepEqual(sortMediaItems(items, SORT_MODES.RESOLUTION_DESC, metaByUrl).map((i) => i.suggestedFilename), [
    'keynote.mp4',
    'banner.jpg',
    'intro.mp4'
  ]);
  assert.deepEqual(sortMediaItems(items, SORT_MODES.DURATION_DESC, metaByUrl).map((i) => i.suggestedFilename), [
    'keynote.mp4',
    'intro.mp4',
    'banner.jpg'
  ]);
});

test('matchesImageQuickFilters filters images by pixel size and extension while passing non-images through', () => {
  const thumb = { type: 'image', ext: 'png', width: 64, height: 64 };
  const photo = { type: 'image', ext: 'jpeg', width: 1200, height: 800 };
  const svg = { type: 'image', ext: 'svg', width: 48, height: 48 };
  const video = { type: 'video', ext: 'mp4', width: 0, height: 0 };

  assert.equal(matchesImageQuickFilters(thumb, { minImagePx: 300 }), false);
  assert.equal(matchesImageQuickFilters(photo, { minImagePx: 300 }), true);
  assert.equal(matchesImageQuickFilters(photo, { imageExt: 'jpg' }), true);
  assert.equal(matchesImageQuickFilters(thumb, { imageExt: 'jpg' }), false);
  assert.equal(matchesImageQuickFilters(svg, { imageExt: 'svg' }), true);
  assert.equal(matchesImageQuickFilters(video, { minImagePx: 800, imageExt: 'png' }), true);
});
