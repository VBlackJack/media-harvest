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

const AES_BLOCK_BYTES = 16;

/**
 * Parses an HLS hex IV attribute (e.g. "0x0000...0001") into a 16-byte Uint8Array.
 * Returns null if rawIvHex is empty or malformed.
 * @param {string} rawIvHex
 * @returns {Uint8Array | null}
 */
export function parseHlsIvHex(rawIvHex) {
  if (typeof rawIvHex !== 'string') {
    return null;
  }
  const trimmed = rawIvHex.trim();
  if (!trimmed) {
    return null;
  }
  const hex = trimmed.replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{1,32}$/.test(hex)) {
    return null;
  }
  const padded = hex.padStart(AES_BLOCK_BYTES * 2, '0');
  const iv = new Uint8Array(AES_BLOCK_BYTES);
  for (let i = 0; i < AES_BLOCK_BYTES; i += 1) {
    iv[i] = Number.parseInt(padded.slice(i * 2, i * 2 + 2), 16);
  }
  return iv;
}

/**
 * Builds the default RFC 8216 128-bit big-endian IV from an HLS media sequence number.
 * @param {number} sequenceNumber
 * @returns {Uint8Array}
 */
export function buildSequenceIv(sequenceNumber) {
  const iv = new Uint8Array(AES_BLOCK_BYTES);
  const seq = Number.isFinite(sequenceNumber) && sequenceNumber >= 0
    ? Math.floor(sequenceNumber)
    : 0;
  const high = Math.floor(seq / 0x100000000);
  const low = seq >>> 0;
  const view = new DataView(iv.buffer);
  view.setUint32(8, high >>> 0, false);
  view.setUint32(12, low, false);
  return iv;
}

/**
 * Resolves the 16-byte IV for a specific HLS segment from explicit IV or sequence number.
 * @param {string} ivHex
 * @param {number} sequenceNumber
 * @returns {Uint8Array}
 */
export function resolveSegmentIv(ivHex, sequenceNumber) {
  return parseHlsIvHex(ivHex) || buildSequenceIv(sequenceNumber);
}

/**
 * Checks whether a URI is a base64-encoded data URI carrying raw key bytes.
 * @param {string} uri
 * @returns {boolean}
 */
export function isBase64DataUri(uri) {
  return typeof uri === 'string' && /^data:[^,]*;base64,[A-Za-z0-9+/=\s]+$/i.test(uri.trim());
}

/**
 * Decodes raw AES-128 key bytes from a base64 data URI.
 * @param {string} dataUri
 * @returns {Uint8Array}
 */
export function decodeBase64DataUri(dataUri) {
  if (!isBase64DataUri(dataUri)) {
    throw new Error('INVALID_KEY');
  }
  const commaIdx = dataUri.indexOf(',');
  const b64 = dataUri.slice(commaIdx + 1).replace(/\s+/g, '');
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  if (bytes.byteLength !== AES_BLOCK_BYTES) {
    throw new Error('INVALID_KEY');
  }
  return bytes;
}

/**
 * Imports a 16-byte raw AES-128 key into a reusable Web Crypto AES-CBC CryptoKey.
 * @param {ArrayBuffer | Uint8Array} keyBuffer
 * @returns {Promise<CryptoKey>}
 */
export async function importAes128Key(keyBuffer) {
  const bytes = keyBuffer instanceof Uint8Array ? keyBuffer : new Uint8Array(keyBuffer);
  if (bytes.byteLength !== AES_BLOCK_BYTES) {
    throw new Error('INVALID_KEY');
  }
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (!subtle) {
    throw new Error('ENCRYPTED_STREAM');
  }
  return subtle.importKey(
    'raw',
    bytes,
    { name: 'AES-CBC' },
    false,
    ['decrypt']
  );
}

/**
 * Decrypts an AES-128-CBC encrypted HLS segment buffer using Web Crypto.
 * @param {ArrayBuffer | Uint8Array} encryptedBuffer
 * @param {CryptoKey | ArrayBuffer | Uint8Array} keyOrBytes
 * @param {Uint8Array} ivBytes
 * @returns {Promise<ArrayBuffer>}
 */
export async function decryptAes128Segment(encryptedBuffer, keyOrBytes, ivBytes) {
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (!subtle) {
    throw new Error('ENCRYPTED_STREAM');
  }
  const cryptoKey = keyOrBytes && keyOrBytes.type === 'secret'
    ? keyOrBytes
    : await importAes128Key(keyOrBytes);
  return subtle.decrypt(
    { name: 'AES-CBC', iv: ivBytes },
    cryptoKey,
    encryptedBuffer
  );
}
