[Version française](README.fr.md)

# Media Harvest

Chrome Manifest V3 extension (`v1.3.0`) to detect, preview, and download videos, non-DRM HLS (`.m3u8`) and DASH (`.mpd`) streams, subtitles, images, and audio from the active tab, in popup or Chrome Side Panel mode.

## Features

- Scans page DOM (`<video>`, `<audio>`, `<img>`, non-tainted `<canvas>`, `<track>`, inline `<svg>` vectors with `<use>` symbol and external `.svg#symbol` sprite extraction and SVG markup optimization, CSS `data:image/svg+xml` / `background-image` / `mask-image` assets, direct media links, open Shadow DOM roots, OpenGraph/Twitter meta tags, and JSON-LD `VideoObject`/`AudioObject`/`ImageObject`) across all frames (`allFrames: true`), including live video frame previews and inline `<audio>` playback.
- Captures network media responses (`.mp4`, `.webm`, `.m3u8`, `.mpd`, `.vtt`, `.srt`, `.ttml`, `.ass`, audio, images) per tab via `chrome.webRequest`, propagates `Referer`/`Origin` via temporary `declarativeNetRequest` session rules on restricted CDNs, provides a universal MSE (`MediaSource`) fallback buffer capture up to `150` MB (`enableMseCapture`), and records active tab video+audio directly via `chrome.tabCapture` (`Capture tab` / `Stop REC` with pass-through audio and red `REC` badge).
- Resolves VOD and live HLS playlists (including `#EXT-X-BYTERANGE`, `#EXT-X-DISCONTINUITY` timeline flushes, `#EXT-X-MEDIA:TYPE=SUBTITLES`, native Web Crypto `AES-128` decryption, autonomous browser AAC `.m4a`, compact WebCodecs Ogg/Opus `.opus`, and 16-bit PCM `.wav` audio extraction across HLS, DASH, MSE, and direct HTTP MP4/WebM media, plus live HLS/DASH DVR recording) as well as non-DRM DASH `.mpd` manifests; retries transient segment errors automatically, estimates variant sizes with configurable large-stream warnings, supports direct disk streaming via File System Access (`src/saver/` with incremental MPEG-TS to MP4 transmuxing) for progressive HTTP videos and playlist streams exceeding `512` MB without a companion, supports mid-flight cancellation, and assembles segments in an offscreen document within a `512` MB memory cap (zero-copy `Uint8Array` parts for dual-track fMP4 muxing and MPEG-TS/ADTS to MP4 transmuxing via vendored `mux-mp4.min.js`).
- Offers an image gallery grid view (`list` / `grid` toggle), an `SVG` filter tab with `Copy SVG` markup action and clean sprite symbol extraction, quick pixel-size (`>= 100/300/800 px`), orientation (`landscape` / `portrait` / `square`), and extension filters, configurable SVG raster scale (`256` - `2048` px), max image downscale width (`512` - `3840` px), and JPG compression quality (`50` - `100` %), Lightbox Pro preview (backdrop toggle `Checker` / `Light` / `Dark`, interactive SVG color palette extraction with live recoloring and `currentColor` conversion, Copy SVG/URL, and Download), one-click and batch on-the-fly raster image conversion (`WebP` / `AVIF` / `SVG` -> `PNG` or `JPG`), per-card multi-select with selective DEFLATE `.zip` archive packaging (original or zero-padded sequential filenames), persistent filter/sort/view state, and a Chrome Side Panel view.
- Injects inline download buttons directly on X/Twitter (`x.com` / `twitter.com`), modular social video players (`youtube.com`, `instagram.com`, `tiktok.com`, `reddit.com`, `facebook.com`, `bsky.app`, `vimeo.com`, `dailymotion.com`, `twitch.tv`, `linkedin.com`), and generic HTML5 `<video>` players across the web (`enableGenericVideoOverlay`), each toggleable live in Settings.
- Includes an optional Windows Native Messaging companion (`companion/` delegating to local `yt-dlp` and `ffmpeg`) with live percentage progress and optional browser cookie passthrough (`enableCompanionCookies`) for heavy (`>512` MB) or authenticated streams.
- Includes an Options page (`chrome.storage.sync`) plus English and French localization (`_locales/en`, `_locales/fr`).

## Settings (`src/options/`)

Open Settings from the gear button in the popup or via Chrome's Extension Details -> Extension options:

| Setting | Default | Bounds / Values | Description |
|---|---|---|---|
| Default stream quality | `best` | `best`, `lowest` | Preferred variant selected when inspecting HLS/DASH streams |
| Filename template | `default` | `default`, `host_stem`, `date_stem`, `host_folder`, `date_folder` | Naming format (`{name}.{ext}`, `{host}_{name}.{ext}`, `{YYYY-MM-DD}_{name}.{ext}`, `{host}/{name}.{ext}`, `{YYYY-MM-DD}/{name}.{ext}`) |
| Minimum image size | `64` px | `0` - `2000` px | Ignores smaller DOM images and tracking pixels |
| Parallel segment downloads | `4` | `1` - `8` | Bounded concurrency pool in `offscreen.js` |
| Large stream warning | `250` MB | `0` - `512` MB | Shows a warning badge above threshold (`0` disables); streams over `512` MB expose direct disk saving (`src/saver/`) |
| JPG conversion quality | `90` % | `50` - `100` % | Compression quality used when converting raster or SVG assets to `.jpg` |
| Max image resize | `0` (Original) | `0`, `512`, `1024`, `1920`, `2560`, `3840` px | Downscales oversized raster images on export (`0` keeps original dimensions) |
| Audio export format | `m4a` | `m4a`, `opus`, `wav` | Output container used for browser-side audio extraction (AAC `.m4a`, WebCodecs Ogg/Opus `.opus`, or PCM `.wav`) |
| Tab Capture bitrate | `5` Mbps | `1` - `16` Mbps | Video recording bitrate used by `chrome.tabCapture` `MediaRecorder` sessions |
| X / Twitter post button | Enabled | `true` / `false` | Live-toggles the inline download button on `x.com` / `twitter.com` |
| Social sites video button | Enabled | `true` / `false` | Live-toggles floating video buttons on Instagram, TikTok, Reddit, YouTube, Facebook, Bluesky, Vimeo, Dailymotion, Twitch, and LinkedIn |
| Other websites video button | Enabled | `true` / `false` | Live-toggles floating download buttons on any generic HTML5 `<video>` (`>= 220x140` px) outside social platforms |
| MSE buffer capture | Enabled | `true` / `false` | Captures non-DRM `MediaSource` buffers as an offscreen MP4/WebM fallback (`150` MB cap) |
| Companion Chrome cookies | Disabled | `true` / `false` | Passes `--cookies-from-browser chrome` to the local `yt-dlp` companion for logged-in sessions |
| Save As prompt | Disabled | `true` / `false` | Prompts where to save individual downloads |

## Optional Local Companion (`companion/`)

For streams exceeding browser memory limits (`512` MB) or complex platform formats, install the optional Chrome Native Messaging host wrapping `yt-dlp` and `ffmpeg` (requires Python 3 and `yt-dlp` on PATH):

- **Windows (PowerShell):**
  ```powershell
  .\companion\install_companion.ps1 -ExtensionId <YOUR_EXTENSION_ID>
  ```
- **Linux / macOS (Bash):**
  ```bash
  ./companion/install_companion.sh <YOUR_EXTENSION_ID>
  ```

Use **Check status** in Extension Options to verify the connection. Downloads triggered via the companion save into `Downloads\MediaHarvest`.

## Shortcuts & Controls

- `Alt+Shift+M` (or `Option+Shift+M` on macOS): opens the extension popup instantly from anywhere in Chrome.
- Chrome Side Panel button (topbar): detaches the media list into Chrome's persistent sidebar.

## Limitations & Safety Boundaries

- **DRM / Encryption:** HLS `AES-128` streams (`METHOD=AES-128`) are decrypted natively in browser memory via Web Crypto, whereas DRM-protected HLS (`SAMPLE-AES` / `#EXT-X-SESSION-KEY`) and DASH (`ContentProtection`) streams are detected and blocked with a localized error message.
- **Live Streams:** Live HLS and dynamic DASH (`type="dynamic"`) broadcasts can be captured via DVR mode (`Record live` / `Stop & Save`, bounded by the `512` MB memory cap) with an active `REC` toolbar badge indicator.
- **Memory Cap:** Offscreen stream assembly is capped at `512` MB (`LIMITS.MAX_HLS_BUFFER_BYTES`) to protect browser tab stability.

## Permissions

- `downloads` - Triggers and tracks file downloads (`chrome.downloads.download` / `.cancel` / `.onChanged`).
- `webRequest` + `<all_urls>` - Observes media response headers (`Content-Type`, `Content-Length`) and main-frame navigations per tab.
- `activeTab` + `scripting` - Scans DOM media on demand when the popup opens.
- `storage` - Stores transient per-tab state in `chrome.storage.session`, filter/sort view state in `chrome.storage.local`, and user preferences in `chrome.storage.sync`.
- `offscreen` - Runs segment fetching, MediaRecorder tab capture, and MP4 muxing in an isolated MV3 offscreen document with Blob URL lifecycle management.
- `tabCapture` - Grants on-demand tab audio+video capture (`chrome.tabCapture.getMediaStreamId`) when the user activates **Capture tab** in the popup.
- `sidePanel` - Allows detaching the capture list into Chrome's persistent Side Panel alongside the active page.
- `declarativeNetRequest` - Applies temporary session `Referer` / `Origin` headers when downloading or inspecting Referer-protected CDN media.
- `nativeMessaging` - Communicates with the optional local `com.mediaharvest.companion` (`yt-dlp` + `ffmpeg`) host when installed.

## Architecture & Docs

- Detailed architecture and message contracts: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) ([FR](docs/fr/ARCHITECTURE.md))
- Chrome Web Store submission & privacy guide: [docs/CHROME_WEB_STORE.md](docs/CHROME_WEB_STORE.md) ([FR](docs/fr/CHROME_WEB_STORE.md))
- Change history: [CHANGELOG.md](CHANGELOG.md)
- Directory overview:
  - `src/config/constants.js` - Media tables, limits, storage keys, settings defaults, and message types.
  - `src/shared/` - Pure ES modules (`media_classifier.js`, `fetch_utils.js`, `hls_parser.js`, `hls_crypto.js`, `dash_parser.js`, `fmp4_muxer.js`, `ts_transmuxer.js`, `wav_encoder.js`, `ogg_opus_muxer.js`, `svg_utils.js`, `zip_builder.js`, `preview_matcher.js`, `settings.js`, `i18n.js`).
  - `src/background/` - Network capture, session state, badge updates, temporary DNR rules (`dnr_manager.js`), offscreen lifecycle, cancellation, stream saver handoff, and downloads.
  - `src/offscreen/` - Offscreen document assembling HLS/DASH segments, decoding Web Audio PCM `.wav`, converting raster/SVG assets, and packaging ZIP archives.
  - `src/saver/` - Dedicated File System Access disk streamer (`stream_saver.html`, `stream_saver.js`) saving `>512` MB progressive/HLS/DASH streams straight to disk.
  - `src/content/` - On-demand DOM media scanner (`srcset`, `<picture>`, and external `<use>` SVG sprites), MSE capture hook/bridge, and modular social/video inline overlays.
  - `src/popup/` - Modular extension popup UI (`popup.js`, `media_card.js`, `preview_player.js`, `batch_runner.js`, `popup_helpers.js`) with live preview, Lightbox Pro, search/sort controls, bounded inspection queue with retry, quality/audio/subtitle selection, over-cap disk-save action, batch ZIP controls, cancellation, and progress reporting.
  - `src/options/` - Synced extension settings page (`options.html`, `options.css`, `options.js`).

## Installation in Chrome

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select this folder.
4. Open a page or post (for example on X), play or reload the video, then click the Media Harvest icon or inline post button.

## Tests, CI & Distribution

Zero external runtime or dev npm packages are required; syntax checking, packaging, and tests use Node.js built-in `node --check`, `node:test`, and `node:assert/strict` (`129` tests in `tests/`, also executed in CI on Node 22 via `.github/workflows/ci.yml`), plus a headless Chromium/Edge MV3 E2E runner (`npm run test:e2e`):

```powershell
npm run check
npm test
npm run test:e2e
npm run test:coverage
npm run package
```
