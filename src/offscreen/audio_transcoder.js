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

import { AUDIO_EXPORT_FORMATS, DEFAULT_FILENAMES } from '../config/constants.js';
import { muxOpusPacketsToOgg } from '../shared/ogg_opus_muxer.js';
import { encodePcmWav } from '../shared/wav_encoder.js';

const OPUS_SAMPLE_RATE_HZ = 48000;
const OPUS_DEFAULT_BITRATE_BPS = 128000;
const OPUS_CHUNK_FRAMES = 4800;
const OPUS_DEFAULT_FRAME_DURATION_US = 20000;
const MICROSECONDS_PER_SECOND = 1000000;

/**
 * Resamples a decoded AudioBuffer to 48 kHz when needed for Opus WebCodecs encoding.
 * @param {AudioBuffer} audioBuffer
 * @returns {Promise<AudioBuffer>}
 */
async function resampleAudioBufferTo48k(audioBuffer) {
  if (audioBuffer.sampleRate === OPUS_SAMPLE_RATE_HZ || typeof OfflineAudioContext !== 'function') {
    return audioBuffer;
  }
  const targetLength = Math.max(1, Math.ceil((audioBuffer.length * OPUS_SAMPLE_RATE_HZ) / audioBuffer.sampleRate));
  const offline = new OfflineAudioContext(audioBuffer.numberOfChannels, targetLength, OPUS_SAMPLE_RATE_HZ);
  const source = offline.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(offline.destination);
  source.start(0);
  return offline.startRendering();
}

/**
 * Encodes a decoded AudioBuffer into compressed Ogg/Opus via WebCodecs AudioEncoder.
 * @param {AudioBuffer} audioBuffer
 * @returns {Promise<Blob>}
 */
export async function encodeDecodedAudioToOpusBlob(audioBuffer) {
  if (typeof AudioEncoder !== 'function' || typeof AudioData !== 'function') {
    throw new Error('OPUS_ENCODER_UNAVAILABLE');
  }
  const prepared = await resampleAudioBufferTo48k(audioBuffer);
  const channels = Math.min(2, Math.max(1, prepared.numberOfChannels || 2));
  const totalFrames = prepared.length;
  const sampleRate = prepared.sampleRate || OPUS_SAMPLE_RATE_HZ;
  const packets = [];
  let encodeError = null;

  const encoder = new AudioEncoder({
    output: (chunk) => {
      const bytes = new Uint8Array(chunk.byteLength);
      chunk.copyTo(bytes);
      packets.push({
        data: bytes,
        durationUs: chunk.duration || OPUS_DEFAULT_FRAME_DURATION_US,
        timestampUs: chunk.timestamp || 0
      });
    },
    error: (err) => {
      encodeError = err || new Error('OPUS_ENCODE_FAILED');
    }
  });

  encoder.configure({
    codec: 'opus',
    sampleRate,
    numberOfChannels: channels,
    bitrate: OPUS_DEFAULT_BITRATE_BPS
  });

  const channelArrays = Array.from({ length: channels }, (_, ch) => prepared.getChannelData(ch));
  for (let offset = 0; offset < totalFrames; offset += OPUS_CHUNK_FRAMES) {
    if (encodeError) {
      break;
    }
    const count = Math.min(OPUS_CHUNK_FRAMES, totalFrames - offset);
    const planar = new Float32Array(count * channels);
    for (let ch = 0; ch < channels; ch += 1) {
      planar.set(channelArrays[ch].subarray(offset, offset + count), ch * count);
    }
    const audioData = new AudioData({
      format: 'f32-planar',
      sampleRate,
      numberOfFrames: count,
      numberOfChannels: channels,
      timestamp: Math.round((offset * MICROSECONDS_PER_SECOND) / sampleRate),
      data: planar
    });
    encoder.encode(audioData);
    audioData.close();
  }

  await encoder.flush();
  encoder.close();
  if (encodeError || packets.length === 0) {
    throw encodeError || new Error('OPUS_EMPTY_FRAMES');
  }

  const oggBytes = muxOpusPacketsToOgg(packets, { channels, sampleRate });
  return new Blob([oggBytes], { type: 'audio/ogg;codecs=opus' });
}

/**
 * Decodes assembled or fetched media bytes via Web Audio into either Ogg/Opus or PCM 16-bit WAV.
 * Falls back transparently to PCM WAV if Opus WebCodecs encoding is unavailable.
 * @param {Array<ArrayBuffer | Uint8Array>} mediaParts
 * @param {string} [targetFormat='wav']
 * @returns {Promise<{ blob: Blob, extension: string }>}
 */
export async function decodeMediaPartsToAudioBlob(mediaParts, targetFormat = AUDIO_EXPORT_FORMATS.WAV) {
  const AudioCtx = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (typeof AudioCtx !== 'function') {
    throw new Error('NO_AUDIO_TRACK');
  }
  const sourceBlob = new Blob(mediaParts);
  const rawBuffer = await sourceBlob.arrayBuffer();
  const audioCtx = new AudioCtx();
  try {
    const decoded = await audioCtx.decodeAudioData(rawBuffer);
    if (targetFormat === AUDIO_EXPORT_FORMATS.OPUS) {
      try {
        const opusBlob = await encodeDecodedAudioToOpusBlob(decoded);
        return { blob: opusBlob, extension: DEFAULT_FILENAMES.AUDIO_OPUS_EXT };
      } catch {
        // Fallback to PCM WAV when AudioEncoder/Opus is unavailable
      }
    }
    const wavBytes = encodePcmWav(decoded);
    return { blob: new Blob([wavBytes], { type: 'audio/wav' }), extension: DEFAULT_FILENAMES.AUDIO_WAV_EXT };
  } catch {
    throw new Error('NO_AUDIO_TRACK');
  } finally {
    if (typeof audioCtx.close === 'function') {
      audioCtx.close().catch(() => {});
    }
  }
}
