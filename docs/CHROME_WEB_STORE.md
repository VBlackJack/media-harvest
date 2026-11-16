[Version française](fr/CHROME_WEB_STORE.md)

# Chrome Web Store Submission Guide (`v1.2.2`)

## Build & Package

1. Generate the clean release archive and SHA-256 digest:
   ```powershell
   npm run check
   npm test
   npm run test:e2e
   npm run package
   ```
2. Upload `dist/media-harvest-v1.2.2.zip` in the Chrome Web Store Developer Dashboard (**Package** -> **Upload new package**).

## Store Listing Copy

- **Extension Name:** Media Harvest
- **Summary (132 chars max):** Detect, preview, and download videos, non-DRM HLS/DASH streams, SVG palettes, subtitles, images, and audio cleanly in Chrome.
- **Category:** Productivity (or Developer Tools)
- **Languages:** English (`en`), French (`fr`)

### Detailed Description (English)

Media Harvest is a Manifest V3 browser utility for inspecting and saving media assets on the active web page without ads, telemetry, or external SaaS dependencies:

- **Video & Stream Capture:** Detects MP4, WebM, non-DRM HLS (`.m3u8`), and static/live DASH (`.mpd`) streams in popup or Chrome Side Panel, with variant resolution/bitrate selection, `AES-128` decryption, live DVR recording, and bounded `512` MB offscreen fMP4/MPEG-TS muxing.
- **Oversized (>512 MB) Direct Disk Saver:** Streams large progressive HTTP videos and HLS/DASH playlists (with incremental MPEG-TS to MP4 transmuxing) straight to disk via the browser File System Access API.
- **Browser Audio Extraction:** Extracts audio tracks in-browser as stream-copied AAC `.m4a`, WebCodecs compact Ogg/Opus `.opus`, or decoded 16-bit PCM `.wav`.
- **Image, SVG & Lightbox Pro:** Inspects `<img>`, `<picture>`, `srcset`, open Shadow DOM, `<canvas>`, inline `<svg>`, and external `.svg#symbol` sprites. Includes orientation filters (`landscape`/`portrait`/`square`), raster downscaling (`512` - `3840` px), SVG color palette extraction with live recoloring and `currentColor` conversion, WebP/AVIF/SVG conversion to PNG/JPG, and selective DEFLATE `.zip` batch export.
- **Subtitles & Inline Buttons:** Captures `.vtt`, `.srt`, `.ttml`, `.ass`, and HLS subtitle tracks; provides live-toggleable download buttons on X/Twitter, major social platforms, and generic HTML5 `<video>` players, plus active tab `REC` recording via `chrome.tabCapture`.
- **Optional Local Companion:** Supports a local Native Messaging host (`companion/`) delegating to user-installed `yt-dlp` and `ffmpeg` cleanly.

## Privacy Policy & Data Handling

- **Zero Telemetry / Zero External Servers:** Media Harvest collects, stores, and transmits no analytics, browsing history, crash telemetry, or usage data to any developer-controlled server.
- **Local Storage Only:** Transient media URLs remain in `chrome.storage.session`; popup filter/view preferences use `chrome.storage.local`; extension settings sync exclusively through the user's Chrome Sync profile (`chrome.storage.sync`).

## Permission Justifications

| Permission | Reviewer Justification |
|---|---|
| `downloads` | Triggers user-initiated media, subtitle, converted image, and ZIP downloads (`chrome.downloads.download`), cancels in-progress downloads on request, and monitors completion to revoke temporary offscreen Blob URLs. |
| `webRequest` + `<all_urls>` | Passively observes HTTP media response headers (`Content-Type`, `Content-Length`) across tabs so video, audio, HLS, DASH, and subtitle URLs discovered during playback are listed cleanly in the popup for the active tab. |
| `activeTab` + `scripting` | Injects the read-only `dom_scanner.js` and `mse_bridge.js` scripts on demand only when the user opens the extension UI or initiates an MSE export, across iframes on that active tab. |
| `storage` | Persists per-tab detected media transiently (`session`), popup filter/sort UI state (`local`), and user settings (`sync`). |
| `offscreen` | Hosts an isolated MV3 offscreen document (`src/offscreen/offscreen.html`) for Web Audio decoding, WebCodecs Opus encoding, Canvas image/SVG conversion, ZIP generation, `MediaRecorder` tab capture, and MP4 transmuxing. |
| `tabCapture` | Captures video and audio of the currently focused tab via `chrome.tabCapture.getMediaStreamId` strictly when the user clicks **Capture tab**. |
| `sidePanel` | Allows docking the Media Harvest panel persistently next to the active web page in Chrome's Side Panel. |
| `declarativeNetRequest` | Installs short-lived session rules scoped solely to user-initiated inspection/download requests that require matching `Referer` / `Origin` headers on strict CDNs, cleaning them up immediately afterward. |
| `nativeMessaging` | Optional bridge to the user-installed `com.mediaharvest.companion` local `yt-dlp` + `ffmpeg` host when invoked explicitly from a card or toolbar action. |
