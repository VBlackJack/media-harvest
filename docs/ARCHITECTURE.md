[Version française](fr/ARCHITECTURE.md)

# Media Harvest - Architecture

## Overview

Media Harvest is a Manifest V3 Chrome & Firefox extension built with pure browser ES modules (zero runtime npm dependencies) and one vendored UMD dependency (`src/vendor/mux-mp4.min.js`).

## Runtime Components

| Component | Entry point | Responsibility |
|---|---|---|
| Service Worker | `src/background/service_worker.js`, `src/background/dnr_manager.js`, `src/background/companion_client.js`, `src/background/download_history.js`, `src/background/batch_queue.js` | `webRequest` capture, master-preserving eviction, overlay quality/audio forwarding, tab route reset, session-persisted temporary `declarativeNetRequest` `Referer`/`Origin` rules (`downloadId` and Stream Saver `tabIds` scope with startup orphan pruning), MSE stream tracking, `chrome.tabCapture` orchestration, `nativeMessaging` companion bridge with live cancellation, resilient background batch queue (`START_BATCH_QUEUE` / `CANCEL_BATCH_QUEUE`), `OPEN_STREAM_SAVER` disk job handoff, download history persistence, session state, toolbar badge, offscreen lifecycle (`OFFSCREEN_GET_ACTIVE_BUILDS` keep-alive), sender isolation (`isExtensionSender`), download and cancel orchestration |
| Offscreen Document | `src/offscreen/offscreen.js`, `src/offscreen/opfs_spool.js`, `src/offscreen/tab_capture.js`, `src/offscreen/audio_transcoder.js`, `src/offscreen/image_processor.js` | Stream manifest resolution (via shared `stream_planner.js`), live HLS/DASH DVR recording and `MediaRecorder` tab capture (`startTabCaptureRecording` with configurable `tabCaptureBitrateMbps`) backed by OPFS disk chunk spooling (`createOpfsSpool` with automatic cleanup on Blob revocation), byte-range / parallel segment fetch, WebVTT subtitle merging and `.srt` conversion, chunked MSE fMP4/WebM/mixed muxing with ABR temporal alignment (`OFFSCREEN_BUILD_MSE_BLOB`), autonomous `.m4a`, WebCodecs Ogg/Opus `.opus`, and 16-bit PCM `.wav` Web Audio extraction (`OFFSCREEN_DECODE_WAV`), external SVG sprite symbol extraction (`OFFSCREEN_EXTRACT_SVG_SYMBOL`), configurable-quality and `maxImageResizePx` raster/SVG conversion, selective DEFLATE zero-copy part-based ZIP assembly, 512 MB cap enforcement, fMP4 muxing, TS/ADTS transmuxing, Blob URL lifecycle |
| Stream Saver Tab | `src/saver/stream_saver.html`, `src/saver/stream_saver.js` | Dedicated File System Access API (`window.showSaveFilePicker`) disk streamer writing bounded progressive HTTP and non-DRM HLS/DASH streams (`>512` MB) with managed fetch timeouts, exponential backoff retries, dual-track fMP4/WebM/mixed streaming with continuous `baseMediaDecodeTime` / `startSequenceNumber` audio tracking, and incremental MPEG-TS to MP4 transmuxing via `mux-mp4.min.js` |
| Popup / Side Panel UI | `src/popup/popup.html`, `src/popup/popup.js`, `src/popup/lightbox_controller.js`, `src/popup/history_controller.js`, `src/popup/media_card.js`, `src/popup/preview_player.js`, `src/popup/batch_runner.js`, `src/popup/popup_helpers.js` | Reconciled media card list with incremental 40-card pagination and debounced search (`120` ms), collapsible recent download history drawer with retry/clear, Chrome Side Panel detach, category filters (including subtitles/SVG), quick image size/extension/orientation filters, Lightbox Pro (`checker`/`light`/`dark`, `ArrowLeft`/`ArrowRight` gallery navigation, focus trap/restoration, SVG palette extraction, live recolor, color reset, `currentColor` toggle, Copy SVG/URL, and Download), tab capture `REC` controls, persisted filter/sort state, bounded manifest inspection queue with retry, quality/audio/subtitle selectors, one-click `SRT` subtitle buttons, MSE badges, companion `yt-dlp` (with live cancel) and `Save large` disk-streamer buttons (both streams and progressive HTTP `>512` MB videos), inline video/audio previews, multi-select background batch queue / ZIP (original or sequential naming) / cancel controls, >512 MB cap warnings |
| Options Page | `src/options/options.html`, `src/options/options.js` | Synced user settings editor (`chrome.storage.sync`) with validation, JPG quality %, max image resize width (`0`-`3840` px), audio export format (`m4a`/`opus`/`wav`), tab capture bitrate (`1`-`16` Mbps), social/MSE toggles, per-domain overlay exclusion list (`disabledOverlayHosts`), Save As toggle, folder filename templates, companion status check, and defaults reset |
| Content Scripts | `src/content/dom_scanner.js`, `src/content/overlay_common.js`, `src/content/overlay_common.css`, `src/content/x_overlay.js`, `src/content/site_overlay.js`, `src/content/mse_hook.js`, `src/content/mse_bridge.js` | Multi-frame DOM scan (Shadow DOM, meta tags, JSON-LD, non-tainted `<canvas>`, inline `<svg>` + external `.svg#id` `<use>` symbols, CSS backgrounds/masks, `srcset`/`<picture>`, `<track>`), shared X/Twitter and modular social overlays with keyboard-navigable quality/audio selector menus and per-domain exclusion filtering, MAIN-world `MediaSource` hook + ISOLATED-world chunk bridge over a private `MessageChannel` handshake with schema/byte-cap validation and SPA LRU eviction |
| Local Companion (Optional) | `companion/media_harvest_host.py`, `companion/install_companion.ps1`, `companion/install_companion.sh` | Windows, Linux, and macOS Chrome Native Messaging host wrapping `yt-dlp` and `ffmpeg` cleanly with length-prefixed JSON stdio framing, `shell=False` execution, real wall-clock timeout, and live `cancel` process-tree termination |

## Shared Modules (`src/shared/`)

- `media_classifier.js` - URL/MIME classification (including `data:image/*` raster URIs), safe HTTP(S) check, filename sanitization, X status stem extraction, deduplication.
- `fetch_utils.js` - Shared managed timeout, cancellation signal, streaming/Content-Length byte-cap reservation, and DASH descriptor/XML helpers (`fetchWithManagedTimeout`, `isDashDescriptor`, `looksLikeDashXml`).
- `hls_parser.js` - Master/media `#EXTM3U` parser, resolution/bandwidth variant sorting, `#EXT-X-KEY` / `#EXT-X-SESSION-KEY` DRM detection, `#EXT-X-DISCONTINUITY` tracking, per-segment `#EXT-X-MAP`, LL-HLS `#EXT-X-PART`, and `#EXT-X-BYTERANGE` per-URL offset tracking.
- `hls_crypto.js` - Web Crypto AES-128-CBC HLS segment decryption with explicit IV / media-sequence IV derivation.
- `dash_parser.js` - Pure-JS XML parser for static and live dynamic non-DRM DASH `.mpd` manifests (multi-Period concatenation, `BaseURL`, `SegmentTemplate` with `SegmentTimeline` or `duration`, `SegmentList`, `SegmentBase`, progressive fallback, `ContentProtection` DRM detection).
- `stream_planner.js` - Shared HLS/DASH manifest planning and variant/audio/subtitle resolution used by both `offscreen.js` and `stream_saver.js`.
- `subtitle_utils.js` - WebVTT cue merging and client-side WebVTT to SubRip (`.srt`) subtitle conversion (`convertWebVttToSrt`).
- `fmp4_muxer.js` - ISO BMFF box parser, part-based video/audio init+fragment muxer (`mergeFmp4InitSegments`, `mergeFmp4VideoAndAudioParts`, `normalizeFmp4Fragment`, `splitFmp4InitAndFragments`, `countTracksInInit`, `hasAudioTrackInInit`), MSE ABR temporal aligner (`alignFmp4MseFragments`), and `'soun'` audio-only track extractor (`extractAudioOnlyFromFmp4Parts`).
- `webm_muxer.js` - Pure-JS EBML/Matroska dual-track WebM muxer (`buildDualWebmStreamInit`, `rewriteAudioClusterForMux`, `splitWebmInitAndClusters`, `countTracksInWebmInit`, `mergeWebmVideoAndAudioParts` with optional ABR trimming) remapping audio `TrackNumber` VINTs and interleaving clusters chronologically.
- `mixed_mse_muxer.js` - Pure-JS cross-container muxer converting WebM Opus to `'soun'` fMP4 (`transmuxWebmOpusToFmp4Parts` with monotonic `baseMediaDecodeTime` / `startSequenceNumber`) and merging WebM video with fMP4 AAC into Matroska `.mkv` (`mergeWebmVideoAndFmp4AacParts`).
- `stream_selector.js` - Master-preserving capture eviction (`mergeCapturedMediaEntry`), stream candidate ranking (`rankVideoCandidates`), sibling/companion audio pairing (`findSiblingStreamAudioUrl`, `findMatchingStreamForDirectUrl`, `findCompanionAudioUrl`).
- `adts_transmuxer.js` - Pure-JS ADTS AAC (with optional ID3v2 prefix and sync rescan) parser and ISO BMFF audio fMP4 converter (`looksLikeAdtsAudio`, `parseAdtsFrames`, `transmuxAdtsSegmentsToFmp4Parts` with continuous `baseMediaDecodeTime` / `startSequenceNumber`).
- `ts_transmuxer.js` - Adapter around `muxjs.Transmuxer` producing zero-copy `Uint8Array` parts (`transmuxTsSegmentsToMp4Parts`) with discontinuity timeline flushing (`discontinuityIndices`) for MPEG-TS streams.
- `wav_encoder.js` - 16-bit PCM RIFF/WAVE encoder (`encodePcmWav`) turning decoded `AudioBuffer` / `Float32Array` channels into uncompressed stereo `.wav` payloads.
- `ogg_opus_muxer.js` - Pure-JS RFC 3533/7845 Ogg/Opus framing muxer (`oggCrc32`, `buildOpusHeadPacket`, `buildOpusTagsPacket`, `muxOpusPacketsToOgg`) packaging WebCodecs `AudioEncoder` Opus frames into `.opus` files.
- `svg_utils.js` - SVG sanitizer and optimizer (`optimizeSvgMarkup`, stripping `<script>`, `<foreignObject>`, and `javascript:` hrefs), external sprite symbol isolator (`extractSymbolFromSvgSprite`), URL fragment splitter (`splitSvgSpriteUrl`), UTF-8 safe SVG data-URI decoder (`decodeSvgDataUrl`), and SVG palette/recolor utilities (`normalizeSvgColor`, `extractSvgPalette`, `replaceSvgColor`, `convertSvgToCurrentColor`).
- `zip_builder.js` - CRC-32, archive entry namer (`resolveZipEntryFilename`), and zero-copy part-based ZIP builder (`buildZipUint8Array`, `buildZipBlob`, `buildZipUint8ArrayAsync`, `buildZipBlobAsync`) with selective `CompressionStream('deflate-raw')` compression for compressible text/vector assets (`ZIP_COMPRESSIBLE_EXTENSIONS`).
- `preview_matcher.js` - Matches X/Twitter stream IDs (`ext_tw_video`, `amplify_video`, `tweet_video`) against captured `<video>` poster frames.
- `settings.js` - Bounds-checked normalizer (`normalizeSettings`, `clampInteger`), per-domain host exclusion normalization (`disabledOverlayHosts`), filename template expansion (`default`, `host_stem`, `date_stem`, `host_folder`, `date_folder`), and `chrome.storage.sync` persistence.
- `i18n.js` - Chrome i18n helper with key fallback and DOM translation walker (`data-i18n`, `data-i18n-title`, `data-i18n-aria`, `data-i18n-placeholder`).

## Storage & Concurrency Model

- `chrome.storage.session`:
  - `tab_media_<tabId>` - Captured network media array per tab (capped at `120` items).
  - `tab_route_<tabId>` - Normalized route key (`origin + pathname`) used to clear stale captures across SPA/navigation changes.
  - `tab_mse_<tabId>` - Tracked MSE stream metadata per tab.
  - `tab_referer_<tabId>` - Tab origin/referer metadata used for authenticated media fetches.
  - `dnr_download_<downloadId>` - Persisted temporary DNR rule IDs scoped to active downloads for cleanup after service worker suspension.
  - `dnr_saver_tab_<tabId>` - Persisted temporary DNR rule IDs scoped to Stream Saver tabs for orphan cleanup on tab close or startup.
  - `download_blob_<downloadId>` - Maps active Chrome download IDs to offscreen Blob URLs so `chrome.downloads.onChanged` reliably revokes Blob URLs (and cleans up OPFS temp files) even if the MV3 service worker restarts.
  - `stream_saver_job_<jobId>` - Transient job descriptor handed off from `service_worker.js` to `src/saver/stream_saver.html` when saving `>512` MB streams via File System Access.
- `chrome.storage.sync`:
  - `user_settings` - User configuration (`DEFAULT_SETTINGS`).
- `chrome.storage.local`:
  - `download_history` - Recent download history capped at `LIMITS.MAX_DOWNLOAD_HISTORY` (`15` items).
  - `popup_ui_state` - Persisted popup filter, sort, and image-filter preferences.
- Serialization queues in `service_worker.js`:
  - `tabWriteQueues` serializes per-tab session read-modify-write operations.
  - `offscreenLifecycleQueue` serializes `createDocument` / `closeDocument` against `activeOffscreenBuilds` and `OFFSCREEN_GET_ACTIVE_BUILDS` keep-alive checks.
  - `activeBuilds` maps `requestId` -> `{ cancelled, downloadId }` so cancellations race-safely abort offscreen builds or already-started Chrome downloads.
  - Privileged runtime commands verify `isExtensionSender(sender)` so compromised web pages cannot trigger internal extension actions.

## Message Contracts

All message type constants are defined in `src/config/constants.js` (`MESSAGE_TYPES`):

- Popup -> Service Worker: `GET_MEDIA_FOR_TAB`, `CLEAR_MEDIA_FOR_TAB`, `INSPECT_HLS`, `DOWNLOAD_MEDIA`, `DOWNLOAD_HLS_SUBTITLE`, `EXPORT_BATCH_ZIP`, `START_BATCH_QUEUE`, `CANCEL_BATCH_QUEUE`, `GET_BATCH_QUEUE_STATE`, `OPEN_STREAM_SAVER`, `START_TAB_CAPTURE`, `STOP_TAB_CAPTURE`, `STOP_LIVE_RECORD`, `CANCEL_DOWNLOAD`, `GET_ACTIVE_BUILDS`, `GET_DOWNLOAD_HISTORY`, `CLEAR_DOWNLOAD_HISTORY`, `CHECK_COMPANION`, `DOWNLOAD_WITH_COMPANION`, `CANCEL_COMPANION_DOWNLOAD`.
- Content Script -> Service Worker: `DOWNLOAD_TWEET_VIDEO`, `DOWNLOAD_SITE_VIDEO`, `MSE_STREAM_UPDATED`, `CANCEL_DOWNLOAD`.
- Service Worker <-> Content Bridge: `EXPORT_MSE_STREAM` (tab frame export trigger).
- Service Worker / Content Bridge -> Offscreen (`target: 'offscreen'`): `OFFSCREEN_BUILD_HLS_BLOB`, `OFFSCREEN_BUILD_SUBTITLE_BLOB`, `OFFSCREEN_BUILD_MSE_BLOB`, `OFFSCREEN_CONVERT_IMAGE`, `OFFSCREEN_EXTRACT_SVG_SYMBOL`, `OFFSCREEN_DECODE_WAV`, `OFFSCREEN_BUILD_ZIP_BLOB`, `OFFSCREEN_RECORD_HLS_LIVE`, `OFFSCREEN_STOP_LIVE_RECORD`, `OFFSCREEN_START_TAB_CAPTURE`, `OFFSCREEN_STOP_TAB_CAPTURE`, `OFFSCREEN_GET_ACTIVE_BUILDS`, `OFFSCREEN_CANCEL_BUILD`, `OFFSCREEN_REVOKE_BLOB`.
- Offscreen / Service Worker -> Popup / Content Script: `DOWNLOAD_PROGRESS` (matched by `requestId` or URL), `DOWNLOAD_FINISHED`, `COMPANION_PROGRESS`, `BATCH_QUEUE_PROGRESS`, `MEDIA_UPDATED` (debounced per tab).

## Stream Assembly & Safety Limits

- DRM-protected streams (`#EXT-X-KEY` with `SAMPLE-AES` / `SAMPLE-AES-CTR` / unsupported methods, `#EXT-X-SESSION-KEY` DRM, or DASH `ContentProtection`) are refused explicitly. Non-DRM HLS `AES-128` streams are decrypted via Web Crypto (`src/shared/hls_crypto.js`), and live HLS / dynamic DASH manifests are supported through DVR recording (`recordLiveHlsBlob`).
- Only `http:` and `https:` URLs are accepted for manifest/segment fetches.
- In-memory segment assembly in `offscreen.js` checks both declared `Content-Length` headers and running accumulated byte counts against `LIMITS.MAX_HLS_BUFFER_BYTES` (`512` MB), aborting sibling requests cleanly on overflow. Long Tab Capture and Live DVR recordings spool chunks directly to OPFS (`src/offscreen/opfs_spool.js`) with transparent in-memory fallback and automatic temp-file cleanup on Blob revocation.
- When an `#EXT-X-BYTERANGE` server ignores `Range` headers and returns HTTP `200`, concurrent segment probes coalesce on a single full-buffer cache entry per URL within that build instead of re-downloading the file per segment.
- `mergeFmp4VideoAndAudioParts` and `transmuxTsSegmentsToMp4Parts` pass an ordered array of `Uint8Array` parts straight into `new Blob(outputParts)` and clear buffer references immediately afterward.
