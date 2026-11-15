[Version française](fr/ARCHITECTURE.md)

# Media Harvest - Architecture

## Overview

Media Harvest is a Manifest V3 Chrome extension built with pure browser ES modules (zero runtime npm dependencies) and one vendored UMD dependency (`src/vendor/mux-mp4.min.js`).

## Runtime Components

| Component | Entry point | Responsibility |
|---|---|---|
| Service Worker | `src/background/service_worker.js`, `src/background/dnr_manager.js` | `webRequest` capture, tab route reset, temporary `declarativeNetRequest` `Referer`/`Origin` rules, MSE stream tracking, `chrome.tabCapture` orchestration, `nativeMessaging` companion bridge, session state, toolbar badge, offscreen lifecycle, download and cancel orchestration |
| Offscreen Document | `src/offscreen/offscreen.js` | Stream manifest resolution, live HLS/DASH DVR recording, `MediaRecorder` tab capture (`startTabCaptureRecording`), byte-range / parallel segment fetch, WebVTT subtitle merging, chunked MSE fMP4/WebM muxing (`OFFSCREEN_BUILD_MSE_BLOB`), autonomous `.m4a` extraction, selective DEFLATE ZIP assembly, 512 MB cap enforcement, fMP4 muxing, TS/ADTS transmuxing, Blob URL lifecycle |
| Popup / Side Panel UI | `src/popup/popup.html`, `src/popup/popup.js`, `src/popup/media_card.js`, `src/popup/preview_player.js`, `src/popup/batch_runner.js`, `src/popup/popup_helpers.js` | Reconciled media card list, Chrome Side Panel detach, category filters (including subtitles/SVG), quick image filters, Lightbox Pro (`checker`/`light`/`dark` + Copy + Download), tab capture `REC` controls, persisted filter/sort state, search/sort controls, bounded manifest inspection queue with retry, quality/audio/subtitle selectors, MSE badges, companion `yt-dlp` delegation buttons, inline video/audio previews, multi-select batch download/ZIP/cancel controls, >512 MB cap warnings |
| Options Page | `src/options/options.html`, `src/options/options.js` | Synced user settings editor (`chrome.storage.sync`) with validation, social/MSE toggles, Save As toggle, folder filename templates, companion status check, and defaults reset |
| Content Scripts | `src/content/dom_scanner.js`, `src/content/x_overlay.js`, `src/content/site_overlay.js`, `src/content/mse_hook.js`, `src/content/mse_bridge.js` | Multi-frame DOM scan (Shadow DOM, meta tags, JSON-LD, non-tainted `<canvas>`, inline `<svg>` + external `<use>` sprites, CSS backgrounds/masks, `srcset`/`<picture>`, `<track>`), X/Twitter overlay, modular social platform overlay adapters, MAIN-world `MediaSource` hook + ISOLATED-world chunk bridge |
| Local Companion (Optional) | `companion/media_harvest_host.py`, `companion/install_companion.ps1`, `companion/install_companion.sh` | Windows, Linux, and macOS Chrome Native Messaging host wrapping `yt-dlp` and `ffmpeg` cleanly with length-prefixed JSON stdio framing and `shell=False` execution |

## Shared Modules (`src/shared/`)

- `media_classifier.js` - URL/MIME classification (including `data:image/*` raster URIs), safe HTTP(S) check, filename sanitization, X status stem extraction, deduplication.
- `fetch_utils.js` - Shared managed timeout, cancellation signal, streaming/Content-Length byte-cap reservation, and DASH descriptor/XML helpers (`fetchWithManagedTimeout`, `isDashDescriptor`, `looksLikeDashXml`).
- `hls_parser.js` - Master/media `#EXTM3U` parser, resolution/bandwidth variant sorting, `#EXT-X-KEY` / `#EXT-X-SESSION-KEY` DRM detection, `#EXT-X-DISCONTINUITY` tracking, `#EXT-X-MAP` and `#EXT-X-BYTERANGE` per-URL offset tracking.
- `dash_parser.js` - Pure-JS XML parser for static and live dynamic non-DRM DASH `.mpd` manifests (`BaseURL`, `SegmentTemplate` with `SegmentTimeline` or `duration`, `SegmentList`, progressive fallback, `ContentProtection` DRM detection).
- `fmp4_muxer.js` - ISO BMFF box parser, part-based video/audio init+fragment muxer (`mergeFmp4VideoAndAudioParts`, `splitFmp4InitAndFragments`, `countTracksInInit`), and `'soun'` audio-only track extractor (`extractAudioOnlyFromFmp4Parts`).
- `ts_transmuxer.js` - Adapter around `muxjs.Transmuxer` producing zero-copy `Uint8Array` parts (`transmuxTsSegmentsToMp4Parts`) with discontinuity timeline flushing (`discontinuityIndices`) for MPEG-TS and ADTS streams.
- `zip_builder.js` - CRC-32 and ZIP archive builder (`buildZipUint8Array`, `buildZipBlob`, `buildZipUint8ArrayAsync`, `buildZipBlobAsync`) with selective `CompressionStream('deflate-raw')` compression for compressible text/vector assets (`ZIP_COMPRESSIBLE_EXTENSIONS`).
- `preview_matcher.js` - Matches X/Twitter stream IDs (`ext_tw_video`, `amplify_video`, `tweet_video`) against captured `<video>` poster frames.
- `settings.js` - Bounds-checked normalizer (`normalizeSettings`, `clampInteger`), filename template expansion (`default`, `host_stem`, `date_stem`), and `chrome.storage.sync` persistence.
- `i18n.js` - Chrome i18n helper with key fallback and DOM translation walker (`data-i18n`, `data-i18n-title`, `data-i18n-aria`, `data-i18n-placeholder`).

## Storage & Concurrency Model

- `chrome.storage.session`:
  - `tab_media_<tabId>` - Captured network media array per tab (capped at `120` items).
  - `tab_route_<tabId>` - Normalized route key (`origin + pathname`) used to clear stale captures across SPA/navigation changes.
  - `download_blob_<downloadId>` - Maps active Chrome download IDs to offscreen Blob URLs so `chrome.downloads.onChanged` reliably revokes Blob URLs even if the MV3 service worker restarts.
- `chrome.storage.sync`:
  - `user_settings` - User configuration (`DEFAULT_SETTINGS`).
- Serialization queues in `service_worker.js`:
  - `tabWriteQueues` serializes per-tab session read-modify-write operations.
  - `offscreenLifecycleQueue` serializes `createDocument` / `closeDocument` against `activeOffscreenBuilds`.
  - `activeBuilds` maps `requestId` -> `{ cancelled, downloadId }` so cancellations race-safely abort offscreen builds or already-started Chrome downloads.

## Message Contracts

All message type constants are defined in `src/config/constants.js` (`MESSAGE_TYPES`):

- Popup -> Service Worker: `GET_MEDIA_FOR_TAB`, `CLEAR_MEDIA_FOR_TAB`, `INSPECT_HLS`, `DOWNLOAD_MEDIA`, `DOWNLOAD_HLS_SUBTITLE`, `EXPORT_BATCH_ZIP`, `START_TAB_CAPTURE`, `STOP_TAB_CAPTURE`, `STOP_LIVE_RECORD`, `CANCEL_DOWNLOAD`, `GET_ACTIVE_BUILDS`, `CHECK_COMPANION`, `DOWNLOAD_WITH_COMPANION`.
- Content Script -> Service Worker: `DOWNLOAD_TWEET_VIDEO`, `DOWNLOAD_SITE_VIDEO`, `MSE_STREAM_UPDATED`, `CANCEL_DOWNLOAD`.
- Service Worker <-> Content Bridge: `EXPORT_MSE_STREAM` (tab frame export trigger).
- Service Worker / Content Bridge -> Offscreen (`target: 'offscreen'`): `OFFSCREEN_BUILD_HLS_BLOB`, `OFFSCREEN_BUILD_SUBTITLE_BLOB`, `OFFSCREEN_BUILD_MSE_BLOB`, `OFFSCREEN_CONVERT_IMAGE`, `OFFSCREEN_BUILD_ZIP_BLOB`, `OFFSCREEN_RECORD_HLS_LIVE`, `OFFSCREEN_STOP_LIVE_RECORD`, `OFFSCREEN_START_TAB_CAPTURE`, `OFFSCREEN_STOP_TAB_CAPTURE`, `OFFSCREEN_CANCEL_BUILD`, `OFFSCREEN_REVOKE_BLOB`.
- Offscreen / Service Worker -> Popup / Content Script: `DOWNLOAD_PROGRESS` (matched by `requestId` or URL), `DOWNLOAD_FINISHED`, `MEDIA_UPDATED` (debounced per tab).

## Stream Assembly & Safety Limits

- Encrypted streams (`#EXT-X-KEY` other than `METHOD=NONE`, `#EXT-X-SESSION-KEY`, or DASH `ContentProtection`) and dynamic live DASH manifests (`type="dynamic"`) are refused explicitly.
- Only `http:` and `https:` URLs are accepted for manifest/segment fetches.
- In-memory segment assembly in `offscreen.js` checks both declared `Content-Length` headers and running accumulated byte counts against `LIMITS.MAX_HLS_BUFFER_BYTES` (`512` MB), aborting sibling requests cleanly on overflow.
- When an `#EXT-X-BYTERANGE` server ignores `Range` headers and returns HTTP `200`, concurrent segment probes coalesce on a single full-buffer cache entry per URL within that build instead of re-downloading the file per segment.
- `mergeFmp4VideoAndAudioParts` and `transmuxTsSegmentsToMp4Parts` pass an ordered array of `Uint8Array` parts straight into `new Blob(outputParts)` and clear buffer references immediately afterward.
