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
import { encodePcmWav } from '../src/shared/wav_encoder.js';

function readAscii(bytes, start, length) {
  return Buffer.from(bytes.buffer, bytes.byteOffset + start, length).toString('ascii');
}

test('encodePcmWav writes valid 44-byte RIFF/WAVE header and interleaved 16-bit PCM samples', () => {
  const left = new Float32Array([0, 0.5, -1, 1.5]);
  const right = new Float32Array([0, -0.5, 1, -1.5]);
  const mockAudioBuffer = {
    numberOfChannels: 2,
    length: 4,
    sampleRate: 48000,
    getChannelData: (ch) => (ch === 0 ? left : right)
  };

  const wav = encodePcmWav(mockAudioBuffer);
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);

  // 4 frames * 2 channels * 2 bytes = 16 data bytes + 44 header bytes = 60 bytes
  assert.equal(wav.byteLength, 60);
  assert.equal(readAscii(wav, 0, 4), 'RIFF');
  assert.equal(view.getUint32(4, true), 52);
  assert.equal(readAscii(wav, 8, 4), 'WAVE');
  assert.equal(readAscii(wav, 12, 4), 'fmt ');
  assert.equal(view.getUint32(16, true), 16);
  assert.equal(view.getUint16(20, true), 1); // PCM
  assert.equal(view.getUint16(22, true), 2); // Stereo
  assert.equal(view.getUint32(24, true), 48000);
  assert.equal(view.getUint32(28, true), 48000 * 4);
  assert.equal(view.getUint16(32, true), 4);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(readAscii(wav, 36, 4), 'data');
  assert.equal(view.getUint32(40, true), 16);

  // Verify clamped interleaved frames
  assert.equal(view.getInt16(44, true), 0);
  assert.equal(view.getInt16(46, true), 0);
  assert.equal(view.getInt16(52, true), -32768);
  assert.equal(view.getInt16(54, true), 32767);
  assert.equal(view.getInt16(56, true), 32767);
  assert.equal(view.getInt16(58, true), -32768);
});

test('encodePcmWav accepts Float32Array array with explicit sampleRate and rejects empty input', () => {
  const mono = [new Float32Array([0.25, -0.25])];
  const wav = encodePcmWav(mono, 22050);
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  assert.equal(wav.byteLength, 48);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 22050);

  assert.throws(() => encodePcmWav([], 44100), /INVALID_AUDIO_BUFFER/);
  assert.throws(() => encodePcmWav([new Float32Array(0)], 44100), /NO_AUDIO_TRACK/);
});
