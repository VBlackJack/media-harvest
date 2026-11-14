[Version française](fr/ARCHITECTURE.md)

# Media Harvest - Architecture

## Overview

Media Harvest is a Manifest V3 Chrome extension built with pure browser ES modules (zero runtime npm dependencies) and one vendored UMD dependency (`src/vendor/mux-mp4.min.js`).

## Runtime Components

| Component | Entry point | Responsibility |
|---|---|---|
| Service Worker | `src/background/service_worker.js` | `webRequest` capture, tab route reset, session state, toolbar badge, offscreen lifecycle, download and cancel orchestration |
| Offscreen Document | `src/offscreen/offscreen.js` | Stream manifest resolution, byte-range / parallel segment fetch, 512 MB cap enforcement, fMP4 muxing, TS/ADTS transmuxing, Blob URL lifecycle |
| Popup UI | `src/popup/popup.html`, `src/popup/popup.js` | Reconciled media card list, category filters, quality selector, inline video previews, download/cancel controls, large-stream badges |
| Options Page | `src/options/options.html`, `src/options/options.js` | Synced user settings editor (`chrome.storage.sync`) with validation and defaults reset |
| Content Scripts | `src/content/dom_scanner.js`, `src/content/x_overlay.js` | On-demand DOM scan (`<video>`, `<audio>`, `<img>`, media links) and live-toggleable X/Twitter post button |

## Shared Modules (`src/shared/`)

- `media_classifier.js` - URL/MIME classification, safe HTTP(S) check, filename sanitization, X status stem extraction, deduplication.
- `hls_parser.js` - Master/media `#EXTM3U` parser, resolution/bandwidth variant sorting, `#EXT-X-KEY` / `#EXT-X-SESSION-KEY` DRM detection, `#EXT-X-MAP` and `#EXT-X-BYTERANGE` per-URL offset tracking.
- `dash_parser.js` - Pure-JS XML parser for static non-DRM DASH `.mpd` manifests (`BaseURL`, `SegmentTemplate` with `SegmentTimeline` or `duration`, `SegmentList`, progressive fallback, `ContentProtection` DRM detection).
- `fmp4_muxer.js` - ISO BMFF box parser and part-based video/audio init+fragment muxer (`mergeFmp4VideoAndAudioParts`, `splitFmp4InitAndFragments`, `countTracksInInit`).
- `ts_transmuxer.js` - Adapter around `muxjs.Transmuxer` producing zero-copy `Uint8Array` parts (`transmuxTsSegmentsToMp4Parts`) for MPEG-TS and ADTS streams.
- `preview_matcher.js` - Matches X/Twitter stream IDs (`ext_tw_video`, `amplify_video`, `tweet_video`) against captured `<video>` poster frames.
- `settings.js` - Bounds-checked normalizer (`normalizeSettings`), filename template expansion (`default`, `host_stem`, `date_stem`), and `chrome.storage.sync` persistence.
- `i18n.js` - Chrome i18n helper with key fallback and DOM translation walker (`data-i18n`, `data-i18n-title`).

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

- Popup -> Service Worker: `GET_MEDIA_FOR_TAB`, `CLEAR_MEDIA_FOR_TAB`, `INSPECT_HLS`, `DOWNLOAD_MEDIA`, `CANCEL_DOWNLOAD`.
- Content Script -> Service Worker: `DOWNLOAD_TWEET_VIDEO`.
- Service Worker -> Offscreen (`target: 'offscreen'`): `OFFSCREEN_BUILD_HLS_BLOB`, `OFFSCREEN_CANCEL_BUILD`, `OFFSCREEN_REVOKE_BLOB`.
- Offscreen / Service Worker -> Popup: `DOWNLOAD_PROGRESS` (matched by `requestId`), `MEDIA_UPDATED` (debounced per tab).

## Stream Assembly & Safety Limits

- Encrypted streams (`#EXT-X-KEY` other than `METHOD=NONE`, `#EXT-X-SESSION-KEY`, or DASH `ContentProtection`) and dynamic live DASH manifests (`type="dynamic"`) are refused explicitly.
- Only `http:` and `https:` URLs are accepted for manifest/segment fetches.
- In-memory segment assembly in `offscreen.js` checks both declared `Content-Length` headers and running accumulated byte counts against `LIMITS.MAX_HLS_BUFFER_BYTES` (`512` MB), aborting sibling requests cleanly on overflow.
- When an `#EXT-X-BYTERANGE` server ignores `Range` headers and returns HTTP `200`, concurrent segment probes coalesce on a single full-buffer cache entry per URL within that build instead of re-downloading the file per segment.
- `mergeFmp4VideoAndAudioParts` and `transmuxTsSegmentsToMp4Parts` pass an ordered array of `Uint8Array` parts straight into `new Blob(outputParts)` and clear buffer references immediately afterward.
