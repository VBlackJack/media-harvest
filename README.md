[Version francaise](README.fr.md)

# Media Harvest

Chrome Manifest V3 extension to detect and download videos, non-DRM HLS streams (`.m3u8`), images, and audio from the active tab.

## Features

- Scans page DOM (`<video>`, `<audio>`, `<img>`, direct media links) on popup open.
- Captures network media responses (`.mp4`, `.webm`, `.m3u8`, audio, images) per tab via `chrome.webRequest`.
- Resolves non-DRM HLS master playlists, lets you pick quality variants, and assembles segments in an offscreen document.
- Localized in English and French (`_locales/en`, `_locales/fr`).

## Installation in Chrome

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select this folder.
4. Open a post (for example on X), play or reload the video, then click the Media Harvest icon.

## Tests

```powershell
node --test tests/*.test.js
```
