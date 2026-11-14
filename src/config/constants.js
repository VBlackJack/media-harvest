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
  'm3u8',
  'mpd'
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
  'audio/x-mpegurl',
  'application/dash+xml'
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
  'application/x-mpegurl': 'm3u8',
  'application/dash+xml': 'mpd'
});

export const HLS_TAGS = Object.freeze({
  STREAM_INF: '#EXT-X-STREAM-INF:',
  MEDIA: '#EXT-X-MEDIA:',
  KEY: '#EXT-X-KEY:',
  SESSION_KEY: '#EXT-X-SESSION-KEY:',
  MAP: '#EXT-X-MAP:',
  BYTERANGE: '#EXT-X-BYTERANGE:',
  EXTINF: '#EXTINF:'
});

export const NON_MEDIA_MIME_TYPES = Object.freeze([
  'text/html',
  'application/xhtml+xml',
  'application/json',
  'application/xml',
  'text/xml',
  'text/css',
  'application/javascript',
  'text/javascript'
]);

export const LIMITS = Object.freeze({
  MAX_CAPTURED_PER_TAB: 120,
  MIN_IMAGE_DIMENSION_PX: 64,
  MIN_IMAGE_BYTES: 1024,
  MIN_VIDEO_BYTES: 1024,
  MAX_FILENAME_LENGTH: 96,
  HLS_FETCH_CONCURRENCY: 4,
  MIN_HLS_CONCURRENCY: 1,
  MAX_HLS_CONCURRENCY: 8,
  MAX_HLS_BUFFER_BYTES: 512 * 1024 * 1024,
  DEFAULT_LARGE_STREAM_WARNING_MB: 250,
  FETCH_TIMEOUT_MS: 20000,
  RELOAD_TIMEOUT_MS: 15000,
  BATCH_DOWNLOAD_DELAY_MS: 180,
  COPY_FEEDBACK_MS: 1500,
  PREVIEW_MAX_WIDTH_PX: 240,
  PREVIEW_FRAME_QUALITY: 0.7,
  PREVIEW_HLS_SEGMENTS: 1,
  MEDIA_UPDATE_DEBOUNCE_MS: 250
});

export const STORAGE_KEYS = Object.freeze({
  TAB_MEDIA_PREFIX: 'tab_media_',
  TAB_ROUTE_PREFIX: 'tab_route_',
  DOWNLOAD_BLOB_PREFIX: 'download_blob_',
  USER_SETTINGS: 'user_settings'
});

export const OFFSCREEN_DOCUMENT_PATH = 'src/offscreen/offscreen.html';

export const MESSAGE_TYPES = Object.freeze({
  GET_MEDIA_FOR_TAB: 'GET_MEDIA_FOR_TAB',
  CLEAR_MEDIA_FOR_TAB: 'CLEAR_MEDIA_FOR_TAB',
  DOWNLOAD_MEDIA: 'DOWNLOAD_MEDIA',
  DOWNLOAD_BATCH: 'DOWNLOAD_BATCH',
  DOWNLOAD_TWEET_VIDEO: 'DOWNLOAD_TWEET_VIDEO',
  CANCEL_DOWNLOAD: 'CANCEL_DOWNLOAD',
  INSPECT_HLS: 'INSPECT_HLS',
  OFFSCREEN_BUILD_HLS_BLOB: 'OFFSCREEN_BUILD_HLS_BLOB',
  OFFSCREEN_CANCEL_BUILD: 'OFFSCREEN_CANCEL_BUILD',
  OFFSCREEN_REVOKE_BLOB: 'OFFSCREEN_REVOKE_BLOB',
  DOWNLOAD_PROGRESS: 'DOWNLOAD_PROGRESS',
  MEDIA_UPDATED: 'MEDIA_UPDATED'
});

export const QUALITY_PREFERENCES = Object.freeze({
  BEST: 'best',
  LOWEST: 'lowest'
});

export const FILENAME_TEMPLATES = Object.freeze({
  DEFAULT: 'default',
  HOST_STEM: 'host_stem',
  DATE_STEM: 'date_stem'
});

export const DEFAULT_SETTINGS = Object.freeze({
  defaultQuality: QUALITY_PREFERENCES.BEST,
  filenameTemplate: FILENAME_TEMPLATES.DEFAULT,
  minImageDimensionPx: LIMITS.MIN_IMAGE_DIMENSION_PX,
  hlsFetchConcurrency: LIMITS.HLS_FETCH_CONCURRENCY,
  largeStreamWarningMb: LIMITS.DEFAULT_LARGE_STREAM_WARNING_MB,
  enableXOverlay: true
});

export const BADGE_CONFIG = Object.freeze({
  BACKGROUND_COLOR: '#0369a1'
});

export const X_INTEGRATION = Object.freeze({
  HOSTNAMES: ['x.com', 'twitter.com', 'www.x.com', 'www.twitter.com'],
  TWEET_PATH_PATTERN: /^\/([A-Za-z0-9_]+)\/status\/(\d+)/,
  DEBOUNCE_MS: 300,
  BUTTON_ATTR: 'data-media-harvest-attached',
  STATUS_RESET_MS: 3000
});

export const DEFAULT_FILENAMES = Object.freeze({
  BASE: 'media',
  FALLBACK_EXT: 'bin',
  HLS_FMP4_EXT: 'mp4',
  HLS_TS_EXT: 'ts'
});

export const UNIT_CONVERSIONS = Object.freeze({
  BYTES_PER_KB: 1024,
  BYTES_PER_MB: 1024 * 1024,
  BITS_PER_KBPS: 1000,
  SECONDS_PER_MINUTE: 60
});
