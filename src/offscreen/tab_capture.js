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

import { DEFAULT_FILENAMES, LIMITS } from '../config/constants.js';
import { clampInteger } from '../shared/settings.js';
import { createOpfsSpool } from './opfs_spool.js';

const CANCEL_REASON = 'DOWNLOAD_CANCELLED';
const BITS_PER_MEGABIT = 1000 * 1000;

/**
 * Selects the best supported MediaRecorder MIME type for tab capture.
 * @returns {string}
 */
export function selectTabCaptureMimeType() {
  if (typeof MediaRecorder !== 'function' || typeof MediaRecorder.isTypeSupported !== 'function') {
    return 'video/webm';
  }
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
    'video/mp4'
  ];
  for (const mime of candidates) {
    if (MediaRecorder.isTypeSupported(mime)) {
      return mime;
    }
  }
  return '';
}

/**
 * Stops all captured media tracks and closes any AudioContext attached to a tab capture session.
 * @param {{ stream?: MediaStream, audioCtx?: AudioContext }} session
 */
export function releaseTabCaptureMedia(session) {
  if (!session) {
    return;
  }
  if (session.stream && typeof session.stream.getTracks === 'function') {
    for (const track of session.stream.getTracks()) {
      try {
        track.stop();
      } catch {
        // Ignore already stopped track
      }
    }
  }
  if (session.audioCtx && typeof session.audioCtx.close === 'function') {
    session.audioCtx.close().catch(() => {});
  }
}

/**
 * Records a tab MediaStream obtained via tabCapture into an OPFS-backed (or RAM-fallback) Blob URL.
 * @param {{
 *   streamId: string,
 *   originalUrl?: string,
 *   tabCaptureBitrateMbps?: number,
 *   requestId: string
 * }} payload
 * @param {{
 *   activeTabCaptures: Map<string, object>,
 *   activeBuildControllers: Map<string, AbortController>,
 *   activeBlobUrls: Set<string>,
 *   blobCleanupByUrl: Map<string, () => Promise<void>>,
 *   notifyProgress: (requestId: string, itemUrl: string, done: number, total: number, extra?: object) => void
 * }} deps
 * @returns {Promise<{ blobUrl: string, outputExtension: string, byteLength: number }>}
 */
export async function startTabCaptureRecording(payload, deps) {
  const { streamId, originalUrl = '', tabCaptureBitrateMbps, requestId } = payload;
  const {
    activeTabCaptures,
    activeBuildControllers,
    activeBlobUrls,
    blobCleanupByUrl,
    notifyProgress
  } = deps;

  if (!streamId || typeof streamId !== 'string') {
    throw new Error('TAB_CAPTURE_FAILED');
  }
  if (
    typeof navigator === 'undefined' ||
    !navigator.mediaDevices ||
    typeof navigator.mediaDevices.getUserMedia !== 'function' ||
    typeof MediaRecorder !== 'function'
  ) {
    throw new Error('TAB_CAPTURE_UNAVAILABLE');
  }

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId
        }
      },
      video: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId
        }
      }
    });
  } catch {
    throw new Error('TAB_CAPTURE_FAILED');
  }

  let audioCtx = null;
  if (typeof AudioContext === 'function' && typeof stream.getAudioTracks === 'function' && stream.getAudioTracks().length > 0) {
    try {
      audioCtx = new AudioContext();
      const source = audioCtx.createMediaStreamSource(stream);
      source.connect(audioCtx.destination);
    } catch {
      audioCtx = null;
    }
  }

  const mimeType = selectTabCaptureMimeType();
  const bitrateMbps = clampInteger(
    tabCaptureBitrateMbps,
    LIMITS.DEFAULT_TAB_CAPTURE_BITRATE_MBPS,
    LIMITS.TAB_CAPTURE_BITRATE_MIN_MBPS,
    LIMITS.TAB_CAPTURE_BITRATE_MAX_MBPS
  );
  const recorderOptions = {
    ...(mimeType ? { mimeType } : {}),
    videoBitsPerSecond: bitrateMbps * BITS_PER_MEGABIT
  };
  const outputExtension = mimeType.includes('mp4')
    ? DEFAULT_FILENAMES.HLS_FMP4_EXT
    : DEFAULT_FILENAMES.WEBM_EXT;

  let recorder;
  try {
    recorder = new MediaRecorder(stream, recorderOptions);
  } catch {
    releaseTabCaptureMedia({ stream, audioCtx });
    throw new Error('TAB_CAPTURE_FAILED');
  }

  const spool = await createOpfsSpool(requestId, mimeType || 'video/webm');
  let totalBytes = 0;
  let chunkCount = 0;
  const startedAt = Date.now();
  const session = {
    requestId,
    recorder,
    stream,
    audioCtx,
    cancelled: false
  };
  activeTabCaptures.set(requestId, session);

  const buildController = new AbortController();
  buildController.signal.addEventListener('abort', () => {
    session.cancelled = buildController.signal.reason === CANCEL_REASON;
    if (recorder.state !== 'inactive') {
      try {
        recorder.stop();
      } catch {
        // Ignore stop race
      }
    }
  }, { once: true });
  activeBuildControllers.set(requestId, buildController);

  notifyProgress(requestId, originalUrl, 0, 0, {
    isLiveRecord: true,
    isTabCapture: true,
    bytes: 0
  });

  return new Promise((resolve, reject) => {
    const finalizeError = (code) => {
      activeTabCaptures.delete(requestId);
      activeBuildControllers.delete(requestId);
      releaseTabCaptureMedia(session);
      spool.abort().catch(() => {});
      reject(new Error(code));
    };

    recorder.ondataavailable = (event) => {
      if (!event || !event.data || event.data.size === 0) {
        return;
      }
      // Enforce the 512 MB cap only when falling back to in-memory chunks; OPFS disk spools can exceed RAM
      if (!spool.isDiskBacked && totalBytes + event.data.size > LIMITS.MAX_HLS_BUFFER_BYTES) {
        if (recorder.state !== 'inactive') {
          try {
            recorder.stop();
          } catch {
            // Stop at max buffer ceiling
          }
        }
        return;
      }
      chunkCount += 1;
      totalBytes += event.data.size;
      spool.append(event.data).catch(() => {});
      const elapsedSec = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
      notifyProgress(requestId, originalUrl, elapsedSec, 0, {
        isLiveRecord: true,
        isTabCapture: true,
        bytes: totalBytes
      });
    };

    recorder.onerror = () => finalizeError('TAB_CAPTURE_FAILED');

    recorder.onstop = () => {
      activeTabCaptures.delete(requestId);
      activeBuildControllers.delete(requestId);
      releaseTabCaptureMedia(session);
      if (session.cancelled) {
        spool.abort().catch(() => {});
        reject(new Error(CANCEL_REASON));
        return;
      }
      if (chunkCount === 0) {
        spool.abort().catch(() => {});
        reject(new Error('TAB_CAPTURE_FAILED'));
        return;
      }
      spool.finalize()
        .then(({ blob, byteLength, cleanup }) => {
          const blobUrl = URL.createObjectURL(blob);
          activeBlobUrls.add(blobUrl);
          if (typeof cleanup === 'function') {
            blobCleanupByUrl.set(blobUrl, cleanup);
          }
          resolve({
            blobUrl,
            outputExtension,
            byteLength
          });
        })
        .catch(() => reject(new Error('TAB_CAPTURE_FAILED')));
    };

    if (typeof stream.getVideoTracks === 'function') {
      for (const track of stream.getVideoTracks()) {
        track.addEventListener('ended', () => {
          if (recorder.state !== 'inactive') {
            try {
              recorder.stop();
            } catch {
              // Ignore track ended stop error
            }
          }
        }, { once: true });
      }
    }

    try {
      recorder.start(LIMITS.TAB_CAPTURE_TIMESLICE_MS);
    } catch {
      finalizeError('TAB_CAPTURE_FAILED');
    }
  });
}

/**
 * Stops one or all active MediaRecorder tab capture sessions cleanly.
 * @param {Map<string, object>} activeTabCaptures
 * @param {string} [requestId='']
 */
export function stopTabCaptureSessions(activeTabCaptures, requestId = '') {
  const targets = requestId
    ? [activeTabCaptures.get(requestId)].filter(Boolean)
    : Array.from(activeTabCaptures.values());
  for (const session of targets) {
    if (session.recorder && session.recorder.state !== 'inactive') {
      try {
        session.recorder.stop();
      } catch {
        // Ignore already stopped recorder
      }
    }
  }
}
