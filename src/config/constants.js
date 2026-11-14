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

export const MEDIA_TYPES = Object.freeze({
  VIDEO: 'video',
  STREAM: 'stream',
  IMAGE: 'image',
  AUDIO: 'audio'
});

export const MEDIA_SOURCES = Object.freeze({
  NETWORK: 'network',
  DOM: 'dom'
});

export const VIDEO_EXTENSIONS = Object.freeze([
  'mp4',
  'webm',
  'm4v',
  'mov',
  'mkv',
  'ogv'
]);

export const STREAM_EXTENSIONS = Object.freeze([
  'm3u8'
]);

export const IMAGE_EXTENSIONS = Object.freeze([
  'jpg',
  'jpeg',
  'png',
  'webp',
  'gif',
  'avif',
  'svg'
]);

export const AUDIO_EXTENSIONS = Object.freeze([
  'mp3',
  'm4a',
  'aac',
  'ogg',
  'opus',
  'wav',
  'flac'
]);

export const SEGMENT_EXTENSIONS = Object.freeze([
  'ts',
  'm4s',
  'cmfv',
  'cmfa'
]);

export const STREAM_MIME_TYPES = Object.freeze([
  'application/vnd.apple.mpegurl',
  'application/x-mpegurl',
  'audio/mpegurl',
  'audio/x-mpegurl'
]);

export const MIME_PREFIX_MAP = Object.freeze({
  'video/': MEDIA_TYPES.VIDEO,
  'image/': MEDIA_TYPES.IMAGE,
  'audio/': MEDIA_TYPES.AUDIO
});

export const MIME_EXTENSION_MAP = Object.freeze({
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/x-m4v': 'm4v',
  'video/ogg': 'ogv',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/flac': 'flac',
  'application/vnd.apple.mpegurl': 'm3u8',
  'application/x-mpegurl': 'm3u8'
});

export const HLS_TAGS = Object.freeze({
  STREAM_INF: '#EXT-X-STREAM-INF:',
  MEDIA: '#EXT-X-MEDIA:',
  KEY: '#EXT-X-KEY:',
  MAP: '#EXT-X-MAP:',
  EXTINF: '#EXTINF:'
});

export const LIMITS = Object.freeze({
  MAX_CAPTURED_PER_TAB: 120,
  MIN_IMAGE_DIMENSION_PX: 64,
  MIN_VIDEO_BYTES: 1024,
  MAX_FILENAME_LENGTH: 96,
  HLS_FETCH_CONCURRENCY: 4,
  FETCH_TIMEOUT_MS: 20000,
  BATCH_DOWNLOAD_DELAY_MS: 180
});

export const STORAGE_KEYS = Object.freeze({
  TAB_MEDIA_PREFIX: 'tab_media_'
});

export const OFFSCREEN_DOCUMENT_PATH = 'src/offscreen/offscreen.html';

export const MESSAGE_TYPES = Object.freeze({
  GET_MEDIA_FOR_TAB: 'GET_MEDIA_FOR_TAB',
  CLEAR_MEDIA_FOR_TAB: 'CLEAR_MEDIA_FOR_TAB',
  DOWNLOAD_MEDIA: 'DOWNLOAD_MEDIA',
  DOWNLOAD_BATCH: 'DOWNLOAD_BATCH',
  INSPECT_HLS: 'INSPECT_HLS',
  OFFSCREEN_BUILD_HLS_BLOB: 'OFFSCREEN_BUILD_HLS_BLOB',
  OFFSCREEN_REVOKE_BLOB: 'OFFSCREEN_REVOKE_BLOB',
  DOWNLOAD_PROGRESS: 'DOWNLOAD_PROGRESS'
});

export const DEFAULT_FILENAMES = Object.freeze({
  BASE: 'media',
  FALLBACK_EXT: 'bin',
  HLS_FMP4_EXT: 'mp4',
  HLS_TS_EXT: 'ts'
});
