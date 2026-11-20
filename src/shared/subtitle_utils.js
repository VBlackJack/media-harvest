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

const VTT_CUE_TIMING_RE = /^((?:\d{2,}:)?\d{2}:\d{2}\.\d{3})\s*-->\s*((?:\d{2,}:)?\d{2}:\d{2}\.\d{3})/;

/**
 * Normalizes a WebVTT timestamp (`MM:SS.mmm` or `HH:MM:SS.mmm`) to SubRip (`HH:MM:SS,mmm`).
 * @param {string} rawTs
 * @returns {string}
 */
function formatVttTimestampAsSrt(rawTs) {
  const trimmed = String(rawTs || '').trim();
  const parts = trimmed.split(':');
  const full = parts.length === 2 ? `00:${trimmed}` : trimmed;
  return full.replace('.', ',');
}

/**
 * Converts WebVTT subtitle text into standard SubRip (.srt) format.
 * Strips WEBVTT header, NOTE/STYLE/REGION blocks, cue settings, and renumbers cues sequentially.
 * @param {string} vttText
 * @returns {string}
 */
export function convertWebVttToSrt(vttText) {
  if (typeof vttText !== 'string' || !vttText.trim()) {
    return '';
  }
  const normalized = vttText.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const blocks = normalized.split(/\n{2,}/);
  const srtBlocks = [];
  let cueIndex = 0;

  for (const rawBlock of blocks) {
    const lines = rawBlock.split('\n').map((line) => line.trimEnd());
    while (lines.length > 0 && !lines[0].trim()) {
      lines.shift();
    }
    if (lines.length === 0) {
      continue;
    }
    const first = lines[0].trim();
    if (
      first.startsWith('WEBVTT') ||
      first.startsWith('NOTE') ||
      first.startsWith('STYLE') ||
      first.startsWith('REGION')
    ) {
      continue;
    }

    let timingLineIdx = 0;
    let timingMatch = VTT_CUE_TIMING_RE.exec(lines[0].trim());
    if (!timingMatch && lines.length > 1) {
      timingMatch = VTT_CUE_TIMING_RE.exec(lines[1].trim());
      if (timingMatch) {
        timingLineIdx = 1;
      }
    }
    if (!timingMatch) {
      continue;
    }

    const payloadLines = lines.slice(timingLineIdx + 1).filter((line) => line.trim().length > 0);
    if (payloadLines.length === 0) {
      continue;
    }
    cueIndex += 1;
    const startTs = formatVttTimestampAsSrt(timingMatch[1]);
    const endTs = formatVttTimestampAsSrt(timingMatch[2]);
    srtBlocks.push(`${cueIndex}\n${startTs} --> ${endTs}\n${payloadLines.join('\n')}`);
  }

  return srtBlocks.length > 0 ? `${srtBlocks.join('\n\n')}\n` : '';
}
