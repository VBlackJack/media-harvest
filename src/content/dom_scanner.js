/*
 * Copyright 2026 Julien Bombled
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

(() => {
  /**
   * Scans the current document for downloadable media elements.
   * Configuration values are injected by the caller to avoid hardcoded thresholds.
   * @param {{
   *   minImageDimensionPx: number,
   *   mediaTypes: { VIDEO: string, IMAGE: string, AUDIO: string },
   *   sourceTag: string,
   *   directExtensions: Array<string>
   * }} config
   * @returns {{ pageTitle: string, pageUrl: string, hasBlobVideo: boolean, items: Array<object> }}
   */
  window.__mediaHarvestScan = function scanPageMedia(config) {
    const {
      minImageDimensionPx,
      previewMaxWidthPx,
      previewFrameQuality,
      mediaTypes,
      sourceTag,
      directExtensions
    } = config;
    const extSet = new Set(directExtensions);
    const seen = new Set();
    const items = [];
    const videoElements = [];
    let hasBlobVideo = false;

    const captureVideoFrame = (video) => {
      if (!video.videoWidth || !video.videoHeight || video.readyState < 2) {
        return '';
      }
      try {
        const targetWidth = Math.min(previewMaxWidthPx, video.videoWidth);
        const targetHeight = Math.max(1, Math.round((video.videoHeight / video.videoWidth) * targetWidth));
        const canvas = document.createElement('canvas');
        canvas.width = targetWidth;
        canvas.height = targetHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          return '';
        }
        ctx.drawImage(video, 0, 0, targetWidth, targetHeight);
        return canvas.toDataURL('image/jpeg', previewFrameQuality);
      } catch {
        return '';
      }
    };

    const toAbsoluteUrl = (raw) => {
      if (!raw || typeof raw !== 'string') {
        return '';
      }
      try {
        return new URL(raw, window.location.href).href;
      } catch {
        return '';
      }
    };

    const addItem = (url, type, meta = {}) => {
      if (!url) {
        return;
      }
      if (url.startsWith('blob:')) {
        if (type === mediaTypes.VIDEO) {
          hasBlobVideo = true;
        }
        return;
      }
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        return;
      }
      if (seen.has(url)) {
        return;
      }
      seen.add(url);
      items.push({
        url,
        type,
        source: sourceTag,
        width: meta.width || 0,
        height: meta.height || 0,
        duration: meta.duration || 0,
        title: meta.title || document.title || '',
        poster: meta.poster || ''
      });
    };

    for (const video of document.querySelectorAll('video')) {
      const posterUrl = toAbsoluteUrl(video.getAttribute('poster'));
      const frameDataUrl = posterUrl ? '' : captureVideoFrame(video);
      const duration = Number.isFinite(video.duration) ? Math.round(video.duration) : 0;
      const directSrc = toAbsoluteUrl(video.currentSrc || video.getAttribute('src'));

      videoElements.push({
        src: directSrc,
        poster: posterUrl,
        frameDataUrl,
        width: video.videoWidth || 0,
        height: video.videoHeight || 0,
        duration
      });

      if (posterUrl) {
        addItem(posterUrl, mediaTypes.IMAGE, {
          width: video.videoWidth || 0,
          height: video.videoHeight || 0
        });
      }

      addItem(directSrc, mediaTypes.VIDEO, {
        width: video.videoWidth || 0,
        height: video.videoHeight || 0,
        poster: posterUrl || frameDataUrl,
        duration
      });

      for (const sourceEl of video.querySelectorAll('source')) {
        addItem(toAbsoluteUrl(sourceEl.getAttribute('src')), mediaTypes.VIDEO, {
          width: video.videoWidth || 0,
          height: video.videoHeight || 0,
          poster: posterUrl || frameDataUrl,
          duration
        });
      }
    }

    for (const audio of document.querySelectorAll('audio')) {
      addItem(toAbsoluteUrl(audio.currentSrc || audio.getAttribute('src')), mediaTypes.AUDIO);
      for (const sourceEl of audio.querySelectorAll('source')) {
        addItem(toAbsoluteUrl(sourceEl.getAttribute('src')), mediaTypes.AUDIO);
      }
    }

    for (const img of document.querySelectorAll('img')) {
      const width = img.naturalWidth || img.width || 0;
      const height = img.naturalHeight || img.height || 0;
      if (width > 0 && height > 0 && (width < minImageDimensionPx || height < minImageDimensionPx)) {
        continue;
      }
      addItem(toAbsoluteUrl(img.currentSrc || img.getAttribute('src')), mediaTypes.IMAGE, {
        width,
        height,
        title: img.getAttribute('alt') || document.title || ''
      });
    }

    for (const anchor of document.querySelectorAll('a[href]')) {
      const href = toAbsoluteUrl(anchor.getAttribute('href'));
      if (!href.startsWith('http://') && !href.startsWith('https://')) {
        continue;
      }
      try {
        const pathname = new URL(href).pathname;
        const dotIdx = pathname.lastIndexOf('.');
        const ext = dotIdx > 0 ? pathname.slice(dotIdx + 1).toLowerCase() : '';
        if (ext && extSet.has(ext)) {
          addItem(href, mediaTypes.VIDEO, {
            title: (anchor.textContent || '').trim() || document.title || ''
          });
        }
      } catch {
        // Ignore malformed anchor URLs
      }
    }

    return {
      pageTitle: document.title || '',
      pageUrl: window.location.href,
      hasBlobVideo,
      videoElements,
      items
    };
  };
})();
