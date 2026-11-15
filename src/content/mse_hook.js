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

(() => {
  const MSE_HOOK_CONFIG = Object.freeze({
    WINDOW_SOURCE: 'media-harvest-mse',
    URL_PREFIX: 'mse://',
    DEFAULT_BUFFER_CAP_BYTES: 150 * 1024 * 1024,
    DEFAULT_SLICE_BYTES: 2 * 1024 * 1024,
    NOTIFY_THROTTLE_MS: 600,
    MIN_NOTIFY_BYTES: 32 * 1024,
    EVENTS: Object.freeze({
      CONFIG: 'MSE_CONFIG',
      STREAM_UPDATED: 'MSE_STREAM_UPDATED',
      EXPORT_REQUEST: 'MSE_EXPORT_REQUEST',
      EXPORT_CHUNK: 'MSE_EXPORT_CHUNK',
      EXPORT_DONE: 'MSE_EXPORT_DONE'
    })
  });

  if (typeof window === 'undefined' || window.__mediaHarvestMseHookInstalled) {
    return;
  }

  const NativeMediaSource = typeof window.MediaSource === 'function' ? window.MediaSource : null;
  const NativeSourceBuffer = typeof window.SourceBuffer === 'function' ? window.SourceBuffer : null;
  if (!NativeMediaSource || !NativeSourceBuffer) {
    return;
  }

  window.__mediaHarvestMseHookInstalled = true;

  let captureEnabled = true;
  let bufferCapBytes = MSE_HOOK_CONFIG.DEFAULT_BUFFER_CAP_BYTES;
  let streamCounter = 0;

  const mediaSourceMap = new WeakMap();
  const sourceBufferMeta = new WeakMap();
  const streamsById = new Map();

  function getOrCreateStreamEntry(mediaSource) {
    let entry = mediaSourceMap.get(mediaSource);
    if (entry) {
      return entry;
    }
    streamCounter += 1;
    const randomPart = Math.random().toString(36).slice(2, 8);
    const mseId = `mse_${Date.now()}_${streamCounter}_${randomPart}`;
    entry = {
      mseId,
      mediaSource,
      blobUrl: '',
      videoMime: '',
      audioMime: '',
      videoChunks: [],
      audioChunks: [],
      videoBytes: 0,
      audioBytes: 0,
      totalBytes: 0,
      hasVideoFragment: false,
      hasAudioFragment: false,
      lastNotifiedBytes: 0,
      lastNotifiedAt: 0,
      notifyTimer: null,
      capped: false
    };
    mediaSourceMap.set(mediaSource, entry);
    streamsById.set(mseId, entry);
    return entry;
  }

  function postHookMessage(kind, payload) {
    try {
      window.postMessage({
        source: MSE_HOOK_CONFIG.WINDOW_SOURCE,
        kind,
        payload
      }, '*');
    } catch {
      // Ignore postMessage failures on restricted contexts
    }
  }

  function emitStreamSummary(entry, force = false) {
    if (!captureEnabled) {
      return;
    }
    if (!force && entry.totalBytes < MSE_HOOK_CONFIG.MIN_NOTIFY_BYTES) {
      return;
    }
    if (entry.totalBytes <= 0) {
      return;
    }
    entry.lastNotifiedBytes = entry.totalBytes;
    entry.lastNotifiedAt = Date.now();
    const rawDuration = entry.mediaSource && Number.isFinite(entry.mediaSource.duration)
      ? Math.round(entry.mediaSource.duration)
      : 0;
    const primaryMime = entry.videoMime || entry.audioMime || 'video/mp4';
    postHookMessage(MSE_HOOK_CONFIG.EVENTS.STREAM_UPDATED, {
      mseId: entry.mseId,
      url: `${MSE_HOOK_CONFIG.URL_PREFIX}${entry.mseId}`,
      mimeType: primaryMime,
      videoMime: entry.videoMime,
      audioMime: entry.audioMime,
      totalBytes: entry.totalBytes,
      duration: rawDuration > 0 ? rawDuration : 0,
      capped: entry.capped,
      blobUrl: entry.blobUrl,
      title: typeof document !== 'undefined' ? (document.title || '') : '',
      pageUrl: window.location ? (window.location.href || '') : ''
    });
  }

  function scheduleStreamNotify(entry) {
    const now = Date.now();
    if (now - entry.lastNotifiedAt >= MSE_HOOK_CONFIG.NOTIFY_THROTTLE_MS) {
      if (entry.notifyTimer) {
        clearTimeout(entry.notifyTimer);
        entry.notifyTimer = null;
      }
      emitStreamSummary(entry);
      return;
    }
    if (!entry.notifyTimer) {
      const delay = Math.max(50, MSE_HOOK_CONFIG.NOTIFY_THROTTLE_MS - (now - entry.lastNotifiedAt));
      entry.notifyTimer = setTimeout(() => {
        entry.notifyTimer = null;
        emitStreamSummary(entry);
      }, delay);
    }
  }

  function copyBufferSlice(data) {
    if (!data) {
      return null;
    }
    if (data instanceof ArrayBuffer) {
      return new Uint8Array(data.slice(0));
    }
    if (ArrayBuffer.isView(data)) {
      return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    }
    return null;
  }

  const origAddSourceBuffer = NativeMediaSource.prototype.addSourceBuffer;
  NativeMediaSource.prototype.addSourceBuffer = function wrappedAddSourceBuffer(mimeType) {
    const sb = origAddSourceBuffer.apply(this, arguments);
    if (captureEnabled && sb) {
      const entry = getOrCreateStreamEntry(this);
      const normalizedMime = typeof mimeType === 'string' ? mimeType.trim() : '';
      const isAudio = normalizedMime.toLowerCase().startsWith('audio/');
      if (isAudio) {
        if (!entry.audioMime) {
          entry.audioMime = normalizedMime;
        }
      } else if (!entry.videoMime) {
        entry.videoMime = normalizedMime;
      }
      sourceBufferMeta.set(sb, {
        entry,
        trackKind: isAudio ? 'audio' : 'video',
        mimeType: normalizedMime
      });
    }
    return sb;
  };

  function looksLikeInitHeader(bytes) {
    if (!bytes || bytes.byteLength < 8) {
      return false;
    }
    // ISO BMFF 'ftyp' box
    if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
      return true;
    }
    // WebM / Matroska EBML header
    return bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
  }

  function looksLikeMediaFragment(bytes) {
    if (!bytes || bytes.byteLength < 8) {
      return false;
    }
    // ISO BMFF 'moof' box
    if (bytes[4] === 0x6d && bytes[5] === 0x6f && bytes[6] === 0x6f && bytes[7] === 0x66) {
      return true;
    }
    // WebM Cluster element
    return bytes[0] === 0x1f && bytes[1] === 0x43 && bytes[2] === 0xb6 && bytes[3] === 0x75;
  }

  function resetTrackBuffer(entry, trackKind) {
    if (trackKind === 'audio') {
      entry.totalBytes = Math.max(0, entry.totalBytes - entry.audioBytes);
      entry.audioChunks.length = 0;
      entry.audioBytes = 0;
      entry.hasAudioFragment = false;
    } else {
      entry.totalBytes = Math.max(0, entry.totalBytes - entry.videoBytes);
      entry.videoChunks.length = 0;
      entry.videoBytes = 0;
      entry.hasVideoFragment = false;
    }
    entry.capped = false;
    entry.lastNotifiedBytes = 0;
  }

  const origAppendBuffer = NativeSourceBuffer.prototype.appendBuffer;
  NativeSourceBuffer.prototype.appendBuffer = function wrappedAppendBuffer(data) {
    if (captureEnabled) {
      const meta = sourceBufferMeta.get(this);
      if (meta) {
        const copy = copyBufferSlice(data);
        if (copy && copy.byteLength > 0) {
          const entry = meta.entry;
          const isAudio = meta.trackKind === 'audio';
          const hadFragment = isAudio ? entry.hasAudioFragment : entry.hasVideoFragment;
          if (hadFragment && looksLikeInitHeader(copy)) {
            resetTrackBuffer(entry, meta.trackKind);
          }
          if (!entry.capped) {
            if (entry.totalBytes + copy.byteLength <= bufferCapBytes) {
              if (isAudio) {
                entry.audioChunks.push(copy);
                entry.audioBytes += copy.byteLength;
                if (looksLikeMediaFragment(copy)) {
                  entry.hasAudioFragment = true;
                }
              } else {
                entry.videoChunks.push(copy);
                entry.videoBytes += copy.byteLength;
                if (looksLikeMediaFragment(copy)) {
                  entry.hasVideoFragment = true;
                }
              }
              entry.totalBytes += copy.byteLength;
              scheduleStreamNotify(entry);
            } else {
              entry.capped = true;
              emitStreamSummary(entry, true);
            }
          }
        }
      }
    }
    return origAppendBuffer.apply(this, arguments);
  };

  if (typeof NativeMediaSource.prototype.endOfStream === 'function') {
    const origEndOfStream = NativeMediaSource.prototype.endOfStream;
    NativeMediaSource.prototype.endOfStream = function wrappedEndOfStream() {
      const res = origEndOfStream.apply(this, arguments);
      if (captureEnabled) {
        const entry = mediaSourceMap.get(this);
        if (entry && entry.totalBytes > 0) {
          if (entry.notifyTimer) {
            clearTimeout(entry.notifyTimer);
            entry.notifyTimer = null;
          }
          emitStreamSummary(entry, true);
        }
      }
      return res;
    };
  }

  if (window.URL && typeof window.URL.createObjectURL === 'function') {
    const origCreateObjectUrl = window.URL.createObjectURL.bind(window.URL);
    window.URL.createObjectURL = function wrappedCreateObjectUrl(obj) {
      const resultUrl = origCreateObjectUrl(obj);
      if (captureEnabled && obj instanceof NativeMediaSource) {
        const entry = getOrCreateStreamEntry(obj);
        entry.blobUrl = resultUrl;
        if (entry.totalBytes > 0) {
          emitStreamSummary(entry, true);
        }
      }
      return resultUrl;
    };
  }

  function exportTrackChunks(requestId, track, chunks, sliceBytes) {
    for (const chunk of chunks) {
      let offset = 0;
      while (offset < chunk.byteLength) {
        const end = Math.min(offset + sliceBytes, chunk.byteLength);
        const sliceView = chunk.subarray(offset, end);
        const sliceCopy = sliceView.buffer.slice(sliceView.byteOffset, sliceView.byteOffset + sliceView.byteLength);
        postHookMessage(MSE_HOOK_CONFIG.EVENTS.EXPORT_CHUNK, {
          requestId,
          track,
          buffer: sliceCopy
        });
        offset = end;
      }
    }
  }

  window.addEventListener('message', (event) => {
    if (!event || event.source !== window || !event.data) {
      return;
    }
    const { source, kind, payload } = event.data;
    if (source !== MSE_HOOK_CONFIG.WINDOW_SOURCE || !payload) {
      return;
    }

    if (kind === MSE_HOOK_CONFIG.EVENTS.CONFIG) {
      if (typeof payload.enabled === 'boolean') {
        captureEnabled = payload.enabled;
        if (!captureEnabled) {
          for (const entry of streamsById.values()) {
            entry.videoChunks.length = 0;
            entry.audioChunks.length = 0;
            entry.totalBytes = 0;
          }
          streamsById.clear();
        }
      }
      if (Number.isFinite(payload.bufferCapBytes) && payload.bufferCapBytes > 0) {
        bufferCapBytes = payload.bufferCapBytes;
      }
      return;
    }

    if (kind === MSE_HOOK_CONFIG.EVENTS.EXPORT_REQUEST) {
      const { requestId, mseId, sliceBytes } = payload;
      const entry = streamsById.get(mseId);
      if (!entry || entry.totalBytes === 0) {
        postHookMessage(MSE_HOOK_CONFIG.EVENTS.EXPORT_DONE, {
          requestId,
          ok: false,
          error: 'MSE_NOT_FOUND'
        });
        return;
      }
      const chunkLimit = Number.isFinite(sliceBytes) && sliceBytes > 0
        ? sliceBytes
        : MSE_HOOK_CONFIG.DEFAULT_SLICE_BYTES;
      exportTrackChunks(requestId, 'video', entry.videoChunks, chunkLimit);
      exportTrackChunks(requestId, 'audio', entry.audioChunks, chunkLimit);
      postHookMessage(MSE_HOOK_CONFIG.EVENTS.EXPORT_DONE, {
        requestId,
        ok: true,
        videoMime: entry.videoMime,
        audioMime: entry.audioMime,
        videoBytes: entry.videoBytes,
        audioBytes: entry.audioBytes,
        totalBytes: entry.totalBytes,
        capped: entry.capped
      });
    }
  });
})();
