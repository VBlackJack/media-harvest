[Version française](README.fr.md)

# Media Harvest

Chrome Manifest V3 extension (`v1.0.0`) to detect, preview, and download videos, non-DRM HLS (`.m3u8`) and DASH (`.mpd`) streams, images, and audio from the active tab.

## Features

- Scans page DOM (`<video>`, `<audio>`, `<img>`, direct media links) on popup open, including live video frame previews.
- Captures network media responses (`.mp4`, `.webm`, `.m3u8`, `.mpd`, audio, images) per tab via `chrome.webRequest` with toolbar video badge counts and automatic tab-route clearing.
- Resolves non-DRM HLS master/media playlists (including `#EXT-X-BYTERANGE`) and static non-DRM DASH `.mpd` manifests, estimates variant sizes with configurable large-stream warnings, supports mid-flight cancellation, and assembles segments in an offscreen document within a `512` MB memory cap (zero-copy `Uint8Array` parts for dual-track fMP4 muxing and MPEG-TS/ADTS to MP4 transmuxing via vendored `mux-mp4.min.js`).
- Injects an inline download button directly on X/Twitter video posts (`x.com` / `twitter.com`), with a live enable/disable toggle in Settings.
- Includes an Options page (`chrome.storage.sync`) plus English and French localization (`_locales/en`, `_locales/fr`).

## Settings (`src/options/`)

Open Settings from the gear button in the popup or via Chrome's Extension Details -> Extension options:

| Setting | Default | Bounds / Values | Description |
|---|---|---|---|
| Default stream quality | `best` | `best`, `lowest` | Preferred variant selected when inspecting HLS/DASH streams |
| Filename template | `default` | `default`, `host_stem`, `date_stem` | Naming format (`{name}.{ext}`, `{host}_{name}.{ext}`, `{YYYY-MM-DD}_{name}.{ext}`) |
| Minimum image size | `64` px | `0` - `2000` px | Ignores smaller DOM images and tracking pixels |
| Parallel segment downloads | `4` | `1` - `8` | Bounded concurrency pool in `offscreen.js` |
| Large stream warning | `250` MB | `0` - `2048` MB | Shows a warning badge above threshold (`0` disables) |
| X / Twitter post button | Enabled | `true` / `false` | Live-toggles the inline download button on `x.com` / `twitter.com` |

## Limitations & Safety Boundaries

- **DRM / Encryption:** Encrypted HLS (`#EXT-X-KEY` / `#EXT-X-SESSION-KEY`) and DRM-protected DASH (`ContentProtection`) streams are detected and blocked with a localized error message.
- **Live Streams:** Dynamic DASH manifests (`type="dynamic"`) and infinite live playlists cannot be assembled as finite VOD files and are refused.
- **Memory Cap:** Offscreen stream assembly is capped at `512` MB (`LIMITS.MAX_HLS_BUFFER_BYTES`) to protect browser tab stability.

## Permissions

- `downloads` - Triggers and tracks file downloads (`chrome.downloads.download` / `.cancel` / `.onChanged`).
- `webRequest` + `<all_urls>` - Observes media response headers (`Content-Type`, `Content-Length`) and main-frame navigations per tab.
- `activeTab` + `scripting` - Scans DOM media on demand when the popup opens.
- `storage` - Stores transient per-tab state in `chrome.storage.session` and user preferences in `chrome.storage.sync`.
- `offscreen` - Runs segment fetching and MP4 muxing in an isolated MV3 offscreen document with Blob URL lifecycle management.

## Architecture & Docs

- Detailed architecture and message contracts: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) ([FR](docs/fr/ARCHITECTURE.md))
- Change history: [CHANGELOG.md](CHANGELOG.md)
- Directory overview:
  - `src/config/constants.js` - Media tables, limits, storage keys, settings defaults, and message types.
  - `src/shared/` - Pure ES modules (`media_classifier.js`, `hls_parser.js`, `dash_parser.js`, `fmp4_muxer.js`, `ts_transmuxer.js`, `preview_matcher.js`, `settings.js`, `i18n.js`).
  - `src/background/service_worker.js` - Network capture, session state, badge updates, offscreen lifecycle, cancellation, and downloads.
  - `src/offscreen/` - Offscreen document assembling HLS and DASH segments into downloadable Blob URLs.
  - `src/content/` - On-demand DOM media scanner and X/Twitter inline post overlay.
  - `src/popup/` - Extension popup UI with live preview, quality selection, cancellation, and progress reporting.
  - `src/options/` - Synced extension settings page (`options.html`, `options.css`, `options.js`).

## Installation in Chrome

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select this folder.
4. Open a page or post (for example on X), play or reload the video, then click the Media Harvest icon or inline post button.

## Tests & CI

Zero external runtime or dev npm packages are required; tests use Node.js built-in `node:test` and `node:assert/strict` (`45` tests across `12` test files in `tests/`, also executed in CI on Node 22 via `.github/workflows/ci.yml`):

```powershell
npm test
```
