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
  AUDIO: 'audio',
  SUBTITLE: 'subtitle'
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

export const SUBTITLE_EXTENSIONS = Object.freeze([
  'vtt',
  'srt',
  'ttml',
  'ass',
  'ssa'
]);

export const SUBTITLE_MIME_TYPES = Object.freeze([
  'text/vtt',
  'application/x-subrip',
  'text/srt',
  'application/ttml+xml'
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
  'text/vtt': 'vtt',
  'application/x-subrip': 'srt',
  'text/srt': 'srt',
  'application/ttml+xml': 'ttml',
  'application/vnd.apple.mpegurl': 'm3u8',
  'application/x-mpegurl': 'm3u8',
  'application/dash+xml': 'mpd'
});

export const HLS_TAGS = Object.freeze({
  STREAM_INF: '#EXT-X-STREAM-INF:',
  MEDIA: '#EXT-X-MEDIA:',
  MEDIA_SEQUENCE: '#EXT-X-MEDIA-SEQUENCE:',
  KEY: '#EXT-X-KEY:',
  SESSION_KEY: '#EXT-X-SESSION-KEY:',
  MAP: '#EXT-X-MAP:',
  BYTERANGE: '#EXT-X-BYTERANGE:',
  TARGET_DURATION: '#EXT-X-TARGETDURATION:',
  EXTINF: '#EXTINF:',
  PLAYLIST_TYPE: '#EXT-X-PLAYLIST-TYPE:',
  ENDLIST: '#EXT-X-ENDLIST'
});

export const HLS_ENCRYPTION_METHODS = Object.freeze({
  NONE: 'NONE',
  AES_128: 'AES-128'
});

export const COMPANION_AUDIO_FORMATS = Object.freeze([
  'mp3',
  'm4a',
  'opus',
  'wav'
]);

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
  MIN_IMAGE_DIMENSION_MIN_PX: 0,
  MIN_IMAGE_DIMENSION_MAX_PX: 2000,
  MIN_IMAGE_BYTES: 1024,
  MIN_VIDEO_BYTES: 1024,
  MAX_FILENAME_LENGTH: 96,
  HLS_FETCH_CONCURRENCY: 4,
  MIN_HLS_CONCURRENCY: 1,
  MAX_HLS_CONCURRENCY: 8,
  INSPECT_CONCURRENCY: 3,
  MAX_HLS_BUFFER_BYTES: 512 * 1024 * 1024,
  DEFAULT_LARGE_STREAM_WARNING_MB: 250,
  LARGE_STREAM_WARNING_MIN_MB: 0,
  LARGE_STREAM_WARNING_MAX_MB: 512,
  BATCH_CONFIRM_THRESHOLD: 10,
  FETCH_TIMEOUT_MS: 20000,
  RELOAD_TIMEOUT_MS: 15000,
  BATCH_DOWNLOAD_DELAY_MS: 180,
  COPY_FEEDBACK_MS: 1500,
  PREVIEW_MAX_WIDTH_PX: 240,
  PREVIEW_FRAME_QUALITY: 0.7,
  PREVIEW_HLS_SEGMENTS: 1,
  MEDIA_UPDATE_DEBOUNCE_MS: 250,
  MAX_JSON_LD_NODES: 200,
  MAX_SVG_ITEMS: 80,
  MIN_SVG_DIMENSION_PX: 12,
  DEFAULT_SVG_RASTER_SIZE_PX: 512,
  SVG_RASTER_SIZES: Object.freeze([256, 512, 1024, 2048]),
  QUICK_MIN_IMAGE_PX_OPTIONS: Object.freeze([0, 100, 300, 800]),
  SEGMENT_FETCH_RETRIES: 2,
  SEGMENT_RETRY_DELAY_MS: 250,
  MAX_ZIP_ITEMS: 150,
  JPEG_EXPORT_QUALITY: 0.92,
  LIVE_RECORD_POLL_MIN_MS: 1500,
  LIVE_RECORD_POLL_MAX_MS: 5000,
  MSE_BUFFER_CAP_BYTES: 150 * 1024 * 1024,
  MSE_CHUNK_SLICE_BYTES: 2 * 1024 * 1024,
  DNR_RULE_BASE_ID: 9000
});

export const STORAGE_KEYS = Object.freeze({
  TAB_MEDIA_PREFIX: 'tab_media_',
  TAB_ROUTE_PREFIX: 'tab_route_',
  TAB_MSE_PREFIX: 'tab_mse_',
  TAB_REFERER_PREFIX: 'tab_referer_',
  DOWNLOAD_BLOB_PREFIX: 'download_blob_',
  USER_SETTINGS: 'user_settings',
  POPUP_UI_STATE: 'popup_ui_state'
});

export const OFFSCREEN_DOCUMENT_PATH = 'src/offscreen/offscreen.html';

export const MESSAGE_TYPES = Object.freeze({
  GET_MEDIA_FOR_TAB: 'GET_MEDIA_FOR_TAB',
  CLEAR_MEDIA_FOR_TAB: 'CLEAR_MEDIA_FOR_TAB',
  DOWNLOAD_MEDIA: 'DOWNLOAD_MEDIA',
  DOWNLOAD_TWEET_VIDEO: 'DOWNLOAD_TWEET_VIDEO',
  DOWNLOAD_SITE_VIDEO: 'DOWNLOAD_SITE_VIDEO',
  DOWNLOAD_HLS_SUBTITLE: 'DOWNLOAD_HLS_SUBTITLE',
  CANCEL_DOWNLOAD: 'CANCEL_DOWNLOAD',
  STOP_LIVE_RECORD: 'STOP_LIVE_RECORD',
  INSPECT_HLS: 'INSPECT_HLS',
  MSE_STREAM_UPDATED: 'MSE_STREAM_UPDATED',
  EXPORT_MSE_STREAM: 'EXPORT_MSE_STREAM',
  OFFSCREEN_BUILD_HLS_BLOB: 'OFFSCREEN_BUILD_HLS_BLOB',
  OFFSCREEN_RECORD_HLS_LIVE: 'OFFSCREEN_RECORD_HLS_LIVE',
  OFFSCREEN_STOP_LIVE_RECORD: 'OFFSCREEN_STOP_LIVE_RECORD',
  OFFSCREEN_BUILD_SUBTITLE_BLOB: 'OFFSCREEN_BUILD_SUBTITLE_BLOB',
  OFFSCREEN_BUILD_MSE_BLOB: 'OFFSCREEN_BUILD_MSE_BLOB',
  OFFSCREEN_CONVERT_IMAGE: 'OFFSCREEN_CONVERT_IMAGE',
  OFFSCREEN_BUILD_ZIP_BLOB: 'OFFSCREEN_BUILD_ZIP_BLOB',
  EXPORT_BATCH_ZIP: 'EXPORT_BATCH_ZIP',
  OFFSCREEN_CANCEL_BUILD: 'OFFSCREEN_CANCEL_BUILD',
  OFFSCREEN_REVOKE_BLOB: 'OFFSCREEN_REVOKE_BLOB',
  DOWNLOAD_PROGRESS: 'DOWNLOAD_PROGRESS',
  DOWNLOAD_FINISHED: 'DOWNLOAD_FINISHED',
  GET_ACTIVE_BUILDS: 'GET_ACTIVE_BUILDS',
  MEDIA_UPDATED: 'MEDIA_UPDATED',
  CHECK_COMPANION: 'CHECK_COMPANION',
  DOWNLOAD_WITH_COMPANION: 'DOWNLOAD_WITH_COMPANION',
  COMPANION_PROGRESS: 'COMPANION_PROGRESS'
});

export const QUALITY_PREFERENCES = Object.freeze({
  BEST: 'best',
  LOWEST: 'lowest'
});

export const SORT_MODES = Object.freeze({
  DEFAULT: 'default',
  SIZE_DESC: 'size_desc',
  RESOLUTION_DESC: 'resolution_desc',
  DURATION_DESC: 'duration_desc'
});

export const POPUP_VIEW_MODES = Object.freeze({
  LIST: 'list',
  GRID: 'grid'
});

export const IMAGE_CONVERT_FORMATS = Object.freeze({
  ORIGINAL: 'original',
  PNG: 'png',
  JPG: 'jpg'
});

export const FILENAME_TEMPLATES = Object.freeze({
  DEFAULT: 'default',
  HOST_STEM: 'host_stem',
  DATE_STEM: 'date_stem',
  HOST_FOLDER: 'host_folder',
  DATE_FOLDER: 'date_folder'
});

export const DEFAULT_SETTINGS = Object.freeze({
  defaultQuality: QUALITY_PREFERENCES.BEST,
  filenameTemplate: FILENAME_TEMPLATES.DEFAULT,
  minImageDimensionPx: LIMITS.MIN_IMAGE_DIMENSION_PX,
  hlsFetchConcurrency: LIMITS.HLS_FETCH_CONCURRENCY,
  largeStreamWarningMb: LIMITS.DEFAULT_LARGE_STREAM_WARNING_MB,
  enableXOverlay: true,
  enableSocialOverlay: true,
  enableGenericVideoOverlay: true,
  enableMseCapture: true,
  enableCompanionCookies: false,
  promptSaveAs: false
});

export const MSE_CONSTANTS = Object.freeze({
  URL_PREFIX: 'mse://',
  WINDOW_SOURCE: 'media-harvest-mse'
});

export const NATIVE_HOST = Object.freeze({
  NAME: 'com.mediaharvest.companion',
  ACTION_PING: 'ping',
  ACTION_DOWNLOAD: 'download',
  EVENT_PROGRESS: 'progress',
  EVENT_DONE: 'done'
});

export const BADGE_CONFIG = Object.freeze({
  BACKGROUND_COLOR: '#0369a1',
  REC_COLOR: '#dc2626',
  REC_TEXT: 'REC'
});

export const X_INTEGRATION = Object.freeze({
  HOSTNAMES: ['x.com', 'twitter.com', 'www.x.com', 'www.twitter.com'],
  TWEET_PATH_PATTERN: /^\/([A-Za-z0-9_]+)\/status\/(\d+)/,
  DEBOUNCE_MS: 300,
  BUTTON_ATTR: 'data-media-harvest-attached'
});

export const DEFAULT_FILENAMES = Object.freeze({
  BASE: 'media',
  FALLBACK_EXT: 'bin',
  HLS_FMP4_EXT: 'mp4',
  HLS_TS_EXT: 'ts',
  AUDIO_M4A_EXT: 'm4a',
  AUDIO_MP3_EXT: 'mp3',
  SUBTITLE_EXT: 'vtt',
  SVG_EXT: 'svg',
  ZIP_EXT: 'zip'
});

export const HLS_PLAYLIST_TYPES = Object.freeze({
  VOD: 'VOD',
  EVENT: 'EVENT'
});

export const HLS_SUBTITLE_CONSTANTS = Object.freeze({
  WEBVTT_HEADER: 'WEBVTT'
});

export const UNIT_CONVERSIONS = Object.freeze({
  BYTES_PER_KB: 1024,
  BYTES_PER_MB: 1024 * 1024,
  BITS_PER_KBPS: 1000,
  SECONDS_PER_MINUTE: 60
});
