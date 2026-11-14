[Version française](README.fr.md)

# Media Harvest

Chrome Manifest V3 extension to detect, preview, and download videos, non-DRM HLS streams (`.m3u8`), images, and audio from the active tab.

## Features

- Scans page DOM (`<video>`, `<audio>`, `<img>`, direct media links) on popup open, including live video frame previews.
- Captures network media responses (`.mp4`, `.webm`, `.m3u8`, audio, images) per tab via `chrome.webRequest` with toolbar video badge counts and automatic tab-route clearing.
- Resolves non-DRM HLS master playlists, estimates variant sizes, and assembles segments in an offscreen document (dual-track fMP4 muxing and MPEG-TS to MP4 transmuxing via vendored `mux-mp4.min.js`).
- Injects an inline download button directly on X/Twitter video posts (`x.com` / `twitter.com`).
- Includes popup reload-and-capture controls, category filters, batch direct downloads, and English/French localization (`_locales/en`, `_locales/fr`).

## Architecture

- `src/config/constants.js` - Shared media classification tables, limits, storage keys, and message types.
- `src/shared/` - Pure ES modules (`media_classifier.js`, `hls_parser.js`, `fmp4_muxer.js`, `ts_transmuxer.js`, `preview_matcher.js`, `i18n.js`).
- `src/background/service_worker.js` - Network capture, session state, badge updates, offscreen lifecycle, and downloads.
- `src/offscreen/` - Offscreen document assembling HLS segments into downloadable Blob URLs.
- `src/content/` - On-demand DOM media scanner and X/Twitter inline post overlay.
- `src/popup/` - Extension popup UI with live preview, quality selection, and progress reporting.

## Installation in Chrome

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select this folder.
4. Open a page or post (for example on X), play or reload the video, then click the Media Harvest icon or inline post button.

## Tests

```powershell
npm test
```
