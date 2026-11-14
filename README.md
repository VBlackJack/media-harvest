[Version française](README.fr.md)

# Media Harvest

Chrome Manifest V3 extension to detect, preview, and download videos, non-DRM HLS (`.m3u8`) and DASH (`.mpd`) streams, images, and audio from the active tab.

## Features

- Scans page DOM (`<video>`, `<audio>`, `<img>`, direct media links) on popup open, including live video frame previews.
- Captures network media responses (`.mp4`, `.webm`, `.m3u8`, `.mpd`, audio, images) per tab via `chrome.webRequest` with toolbar video badge counts and automatic tab-route clearing.
- Resolves non-DRM HLS master/media playlists (including `#EXT-X-BYTERANGE`) and static non-DRM DASH MPD manifests, estimates variant sizes with large-stream warnings, supports mid-flight stream cancellation, and assembles segments in an offscreen document within a 512 MB memory cap (dual-track fMP4 muxing and MPEG-TS/ADTS to MP4 transmuxing via vendored `mux-mp4.min.js`).
- Injects an inline download button directly on X/Twitter video posts (`x.com` / `twitter.com`), with a live enable/disable toggle in Settings.
- Includes an Options page (`chrome.storage.sync`) for default quality, filename templates, minimum image size, fetch concurrency, and warning thresholds, plus English/French localization (`_locales/en`, `_locales/fr`).

## Architecture

- `src/config/constants.js` - Shared media classification tables, limits, storage keys, settings defaults, and message types.
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

## Tests

```powershell
npm test
```
