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

const OPFS_SPOOL_DIR = 'media-harvest-spool';

/**
 * Creates a streaming chunk spool backed by the Origin Private File System (OPFS)
 * when available, falling back transparently to in-memory chunk accumulation.
 * Keeps long Tab Capture and Live DVR recordings off the JS heap.
 * @param {string} requestId
 * @param {string} [mimeType='video/webm']
 * @param {{ storageApi?: { getDirectory?: () => Promise<any> } }} [options={}]
 * @returns {Promise<{
 *   isDiskBacked: boolean,
 *   append: (chunk: Blob | Uint8Array | ArrayBuffer) => Promise<number>,
 *   finalize: () => Promise<{ blob: Blob, byteLength: number, cleanup: () => Promise<void> }>,
 *   abort: () => Promise<void>,
 *   getBytesWritten: () => number
 * }>}
 */
export async function createOpfsSpool(requestId, mimeType = 'video/webm', options = {}) {
  const safeId = String(requestId || `spool_${Date.now()}`).replace(/[^a-zA-Z0-9_-]/g, '_');
  const fileName = `${safeId}_${Date.now()}.bin`;
  const storageApi = options.storageApi
    || (typeof navigator !== 'undefined' && navigator.storage ? navigator.storage : null);

  let dirHandle = null;
  let fileHandle = null;
  let writable = null;
  let isDiskBacked = false;

  if (storageApi && typeof storageApi.getDirectory === 'function') {
    try {
      const rootDir = await storageApi.getDirectory();
      dirHandle = await rootDir.getDirectoryHandle(OPFS_SPOOL_DIR, { create: true });
      fileHandle = await dirHandle.getFileHandle(fileName, { create: true });
      writable = await fileHandle.createWritable();
      isDiskBacked = true;
    } catch {
      dirHandle = null;
      fileHandle = null;
      writable = null;
      isDiskBacked = false;
    }
  }

  const memoryChunks = [];
  let bytesWritten = 0;
  let writeChain = Promise.resolve();
  let closed = false;

  const removeTempFile = async () => {
    if (dirHandle && typeof dirHandle.removeEntry === 'function') {
      await dirHandle.removeEntry(fileName).catch(() => {});
    }
  };

  function resolveChunkSize(chunk) {
    if (!chunk) {
      return 0;
    }
    if (typeof chunk.size === 'number') {
      return chunk.size;
    }
    if (typeof chunk.byteLength === 'number') {
      return chunk.byteLength;
    }
    return 0;
  }

  function append(chunk) {
    const size = resolveChunkSize(chunk);
    if (closed || size === 0) {
      return Promise.resolve(bytesWritten);
    }
    bytesWritten += size;
    if (!isDiskBacked) {
      memoryChunks.push(chunk);
      return Promise.resolve(bytesWritten);
    }
    writeChain = writeChain.then(async () => {
      if (closed || !writable) {
        return;
      }
      await writable.write(chunk);
    });
    return writeChain.then(() => bytesWritten);
  }

  async function finalize() {
    if (closed) {
      return {
        blob: new Blob([], { type: mimeType }),
        byteLength: 0,
        cleanup: async () => {}
      };
    }
    await writeChain;
    closed = true;
    if (isDiskBacked && writable && fileHandle) {
      await writable.close();
      writable = null;
      const diskFile = await fileHandle.getFile();
      const typedBlob = diskFile.type === mimeType
        ? diskFile
        : diskFile.slice(0, diskFile.size, mimeType);
      return {
        blob: typedBlob,
        byteLength: typedBlob.size,
        cleanup: removeTempFile
      };
    }
    const blob = new Blob(memoryChunks, { type: mimeType });
    memoryChunks.length = 0;
    return {
      blob,
      byteLength: blob.size,
      cleanup: async () => {}
    };
  }

  async function abort() {
    if (closed) {
      return;
    }
    closed = true;
    memoryChunks.length = 0;
    await writeChain.catch(() => {});
    if (writable) {
      if (typeof writable.abort === 'function') {
        await writable.abort().catch(() => {});
      } else if (typeof writable.close === 'function') {
        await writable.close().catch(() => {});
      }
      writable = null;
    }
    await removeTempFile();
  }

  return {
    isDiskBacked,
    append,
    finalize,
    abort,
    getBytesWritten: () => bytesWritten
  };
}
