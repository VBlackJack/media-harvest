# Changelog

All notable engineering changes to Media Harvest are documented in this file.

## [1.0.0] - 2026-11-14

### Added
- Initial Chrome Manifest V3 extension (`manifest.json` v1.0.0) with popup UI, background service worker, offscreen document assembly, on-demand DOM scanner, and inline X/Twitter post download button.
- Dual-track fMP4 muxing (`src/shared/fmp4_muxer.js`), MPEG-TS/ADTS to MP4 transmuxing (`src/shared/ts_transmuxer.js` + `src/vendor/mux-mp4.min.js`), variant bitrate/size inspection, and video frame previews (`src/shared/preview_matcher.js`).
- Static non-DRM DASH `.mpd` manifest parser (`src/shared/dash_parser.js`) and network/classifier support for `.mpd` (`application/dash+xml`, `application/xml`, `text/xml`).
- HLS `#EXT-X-BYTERANGE` and `#EXT-X-MAP` byte-range support with HTTP `200` range-fallback deduplication in `src/offscreen/offscreen.js`.
- Mid-flight stream cancellation across popup (`Cancel`), service worker (`CANCEL_DOWNLOAD`), and offscreen fetch pools (`OFFSCREEN_CANCEL_BUILD`).
- Synced Options page (`src/options/`) and `src/shared/settings.js` supporting default stream quality (`best` / `lowest`), filename templates (`default` / `host_stem` / `date_stem`), minimum DOM image size (`0-2000` px), parallel segment fetch concurrency (`1-8`), large-stream warning threshold (`0-2048` MB), and live X/Twitter overlay toggle.
- GitHub Actions CI workflow (`.github/workflows/ci.yml`) running `npm test` on Node 22.
- 45 automated unit and mocked MV3 integration tests across 12 test files in `tests/`.

### Fixed & Hardened
- Persisted tab route keys and download-to-Blob mappings in `chrome.storage.session`, serialized per-tab storage writes and offscreen lifecycle transitions, and enforced offscreen Blob revocation across all completion and error paths.
- Reconciled popup media cards in place during live `MEDIA_UPDATED` events so active previews, quality selections, and download progress are preserved.
- Hardened MIME classification against HTML/JSON error pages, improved WCAG AA focus/contrast styling in `src/popup/popup.css`, restored full French accents in `_locales/fr/messages.json`, and enforced Zero-Hardcoding i18n and typography checks (`tests/manifest_and_i18n.test.js`).
- Replaced single contiguous merged buffer copies with part-based `Blob(outputParts)` assembly, enforced `MAX_HLS_BUFFER_BYTES` (`512` MB), rejected non-HTTP(S) URLs from stream manifests, and prevented late `DOWNLOAD_PROGRESS` updates from overwriting cancelled/completed states.
