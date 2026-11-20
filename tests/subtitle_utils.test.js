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
import { convertWebVttToSrt } from '../src/shared/subtitle_utils.js';

test('convertWebVttToSrt converts WebVTT headers, notes, short/long timestamps, and cue settings into SRT', () => {
  const vtt = [
    '\uFEFFWEBVTT - Demo',
    '',
    'NOTE ignore this comment',
    '',
    '00:01.250 --> 00:04.500 align:start position:10%',
    'Hello world!',
    '',
    'cue-2',
    '01:02:03.040 --> 01:02:05.999',
    'Line one',
    'Line two',
    ''
  ].join('\n');

  const srt = convertWebVttToSrt(vtt);
  assert.equal(
    srt,
    [
      '1',
      '00:00:01,250 --> 00:00:04,500',
      'Hello world!',
      '',
      '2',
      '01:02:03,040 --> 01:02:05,999',
      'Line one',
      'Line two',
      ''
    ].join('\n')
  );
  assert.equal(convertWebVttToSrt(''), '');
});
