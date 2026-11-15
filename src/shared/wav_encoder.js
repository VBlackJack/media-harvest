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

const WAV_HEADER_SIZE_BYTES = 44;
const WAV_FMT_CHUNK_SIZE = 16;
const WAV_RIFF_FIXED_OFFSET = 36;
const PCM_AUDIO_FORMAT = 1;
const PCM_BITS_PER_SAMPLE = 16;
const PCM_BYTES_PER_SAMPLE = PCM_BITS_PER_SAMPLE / 8;
const DEFAULT_SAMPLE_RATE_HZ = 44100;

/**
 * Writes a 4-character ASCII FourCC signature into a DataView.
 * @param {DataView} view
 * @param {number} offset
 * @param {string} label
 */
function writeFourCc(view, offset, label) {
  for (let i = 0; i < label.length; i += 1) {
    view.setUint8(offset + i, label.charCodeAt(i));
  }
}

/**
 * Normalizes an AudioBuffer-like object or an array of Float32Array channel buffers.
 * @param {object | Array<Float32Array>} audioInput
 * @param {number} [sampleRateOverride]
 * @returns {{ channels: Array<Float32Array>, sampleRate: number, frameCount: number }}
 */
function normalizeChannelInput(audioInput, sampleRateOverride) {
  if (audioInput && typeof audioInput.getChannelData === 'function' && Number.isFinite(audioInput.numberOfChannels)) {
    const channelCount = Math.max(1, audioInput.numberOfChannels);
    const channels = [];
    for (let ch = 0; ch < channelCount; ch += 1) {
      channels.push(audioInput.getChannelData(ch));
    }
    const sampleRate = Number.isFinite(audioInput.sampleRate) && audioInput.sampleRate > 0
      ? Math.round(audioInput.sampleRate)
      : DEFAULT_SAMPLE_RATE_HZ;
    const frameCount = Number.isFinite(audioInput.length) ? audioInput.length : channels[0].length;
    return { channels, sampleRate, frameCount };
  }

  if (Array.isArray(audioInput) && audioInput.length > 0) {
    const sampleRate = Number.isFinite(sampleRateOverride) && sampleRateOverride > 0
      ? Math.round(sampleRateOverride)
      : DEFAULT_SAMPLE_RATE_HZ;
    const frameCount = audioInput[0] ? audioInput[0].length : 0;
    return { channels: audioInput, sampleRate, frameCount };
  }

  throw new Error('INVALID_AUDIO_BUFFER');
}

/**
 * Encodes multi-channel floating-point PCM audio samples into a standard 16-bit RIFF/WAVE binary.
 * @param {object | Array<Float32Array>} audioInput
 * @param {number} [sampleRateOverride]
 * @returns {Uint8Array}
 */
export function encodePcmWav(audioInput, sampleRateOverride) {
  const { channels, sampleRate, frameCount } = normalizeChannelInput(audioInput, sampleRateOverride);
  const numChannels = channels.length;
  if (numChannels <= 0 || frameCount <= 0) {
    throw new Error('NO_AUDIO_TRACK');
  }

  const blockAlign = numChannels * PCM_BYTES_PER_SAMPLE;
  const byteRate = sampleRate * blockAlign;
  const dataByteLength = frameCount * blockAlign;
  const totalBytes = WAV_HEADER_SIZE_BYTES + dataByteLength;

  const buffer = new ArrayBuffer(totalBytes);
  const view = new DataView(buffer);

  writeFourCc(view, 0, 'RIFF');
  view.setUint32(4, WAV_RIFF_FIXED_OFFSET + dataByteLength, true);
  writeFourCc(view, 8, 'WAVE');

  writeFourCc(view, 12, 'fmt ');
  view.setUint32(16, WAV_FMT_CHUNK_SIZE, true);
  view.setUint16(20, PCM_AUDIO_FORMAT, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, PCM_BITS_PER_SAMPLE, true);

  writeFourCc(view, 36, 'data');
  view.setUint32(40, dataByteLength, true);

  let writeOffset = WAV_HEADER_SIZE_BYTES;
  for (let frame = 0; frame < frameCount; frame += 1) {
    for (let ch = 0; ch < numChannels; ch += 1) {
      const rawSample = channels[ch][frame] || 0;
      const clamped = Math.max(-1, Math.min(1, rawSample));
      const int16 = clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
      view.setInt16(writeOffset, int16, true);
      writeOffset += PCM_BYTES_PER_SAMPLE;
    }
  }

  return new Uint8Array(buffer);
}
