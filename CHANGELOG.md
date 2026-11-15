# Changelog

All notable engineering changes to Media Harvest are documented in this file.

## [1.2.0] - 2026-11-15

### Added
- Compact WebCodecs Ogg/Opus browser audio extraction (`src/shared/ogg_opus_muxer.js`, RFC 3533/7845 framing with 48 kHz resampling in `src/offscreen/offscreen.js` and automatic PCM `.wav` fallback).
- Incremental MPEG-TS to MP4 transmuxing in the direct File System Access disk writer (`src/saver/stream_saver.html`, `src/saver/stream_saver.js`) alongside oversized (`>512` MB) direct save support on large progressive HTTP videos in `src/popup/media_card.js`.
- Lightbox Pro SVG color palette extraction and live interactive color-picker recoloring plus one-click `currentColor` conversion (`normalizeSvgColor`, `extractSvgPalette`, `replaceSvgColor`, `convertSvgToCurrentColor` in `src/shared/svg_utils.js`, wired into `src/popup/popup.js`).
- Imageye++ image orientation quick filter (`all`, `landscape`, `portrait`, `square` in `#imageOrientationFilterSelect` with persisted UI state) and configurable maximum image resize width (`maxImageResizePx`, `0` - `3840` px) applied during single-image and ZIP batch conversions.
- Configurable Tab Capture `MediaRecorder` video bitrate (`tabCaptureBitrateMbps`, `1` - `16` Mbps, default `5` Mbps) in Options (`src/options/options.html`, `src/options/options.js`).
- Bilingual Chrome Web Store submission, privacy policy, and permission justification guides ([docs/CHROME_WEB_STORE.md](docs/CHROME_WEB_STORE.md), [docs/fr/CHROME_WEB_STORE.md](docs/fr/CHROME_WEB_STORE.md)).
- Expanded test suite to 134 automated unit/integration tests (`86.53%` line coverage) and strengthened `scripts/e2e_chromium.mjs` with orientation, SVG palette, and `stream_saver.html` runtime checks.

## [1.1.0] - 2026-11-15

### Added
- Direct File System Access disk streaming tab (`src/saver/stream_saver.html`, `src/saver/stream_saver.js`) for saving progressive and non-DRM HLS/DASH streams over 512 MB directly to disk without a companion.
- Autonomous browser 16-bit PCM `.wav` audio extraction (`src/shared/wav_encoder.js`, `OFFSCREEN_DECODE_WAV`, selectable `audioExportFormat` `m4a`/`wav` in Settings) supporting HLS, DASH, MSE, and direct HTTP MP4/WebM media.
- SVG Gobbler++ sprite symbol isolation and markup optimization (`src/shared/svg_utils.js`, `OFFSCREEN_EXTRACT_SVG_SYMBOL`) across DOM scan, Copy SVG, Lightbox Pro, PNG/JPG conversion, and ZIP export.
- Configurable JPG compression quality (`50-100%` in Settings) and sequential zero-padded ZIP batch filenames (`media_001.ext` toggle in popup).
- SVG category filter, Lightbox Pro backdrop toggle (`Checker`/`Light`/`Dark`), Tab Capture `REC` mode (`chrome.tabCapture`), live HLS/DASH DVR recording, selective DEFLATE ZIP batch packaging, quick image pixel/format filters, persistent popup filter/sort/grid state, and Chrome Side Panel support.
- Native Messaging companion host (`companion/media_harvest_host.py`) wrapping yt-dlp and ffmpeg with Windows (`install_companion.ps1`), Linux, and macOS (`install_companion.sh`) installers and optional Chrome cookies passthrough.
- MediaSource (MSE) capture in MAIN world with ISOLATED world bridge (`src/content/mse_hook.js`, `src/content/mse_bridge.js`) and offscreen chunked assembly.
- Universal and modular social site overlay adapters (`src/content/site_overlay.js`, `src/content/site_overlay.css`) for YouTube, Instagram, TikTok, Reddit, Bluesky, Facebook, Vimeo, Dailymotion, Twitch, and LinkedIn, plus generic HTML5 `<video>` players.
- Keyboard shortcut `Alt+Shift+M` (`Option+Shift+M` on macOS) to toggle the extension popup directly.
- Standalone zero-dependency ZIP packager script (`scripts/package_extension.mjs`) generating release archives with SHA-256 digests via `npm run package`.
- Modular popup subcomponents (`src/popup/media_card.js`, `src/popup/preview_player.js`, `src/popup/batch_runner.js`, `src/popup/popup_helpers.js`) and declarativeNetRequest manager (`src/background/dnr_manager.js`).
- Subtitle extraction, WebVTT track merging, and dedicated category filter.
- Automated test suite expanded to 129 unit/integration tests across 24 test suites plus headless Chromium MV3 E2E runner (`npm run test:e2e`, CI-safe on Linux).

### Fixed
- Enforced strict 512 MB buffer cap with early Content-Length reservation and streaming chunk checks in offscreen fetch pools.
- Resolved memory-cap race and prevented unbounded buffering on missing Content-Length.
- Re-attached active stream builds and cancellation controls when reopening popup or browser side panel.
- Replaced unconfirmed bulk download with in-DOM confirmation at 10+ items and live batch progress reporting.
- Improved WCAG AA contrast ratio on danger/cancel buttons and hydration retry handling.
- Differentiated empty page state from active search/filter empty state with one-click filter reset.
- Extended recursive typography guard to cover Python, PowerShell, and Shell companion scripts.

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
