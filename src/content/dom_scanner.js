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
   *   previewMaxWidthPx: number,
   *   previewFrameQuality: number,
   *   mediaTypes: { VIDEO: string, IMAGE: string, AUDIO: string, SUBTITLE?: string },
   *   sourceTag: string,
   *   directExtensions: Array<string>,
   *   subtitleExtensions?: Array<string>,
   *   maxJsonLdNodes?: number,
   *   maxCssBgElements?: number
   * }} config
   * @returns {{ pageTitle: string, pageUrl: string, hasBlobVideo: boolean, videoElements: Array<object>, items: Array<object> }}
   */
  window.__mediaHarvestScan = function scanPageMedia(config) {
    const {
      minImageDimensionPx,
      previewMaxWidthPx,
      previewFrameQuality,
      mediaTypes,
      sourceTag,
      directExtensions,
      subtitleExtensions = [],
      maxJsonLdNodes = 50,
      maxCssBgElements = 250,
      maxSvgItems = 80,
      minSvgDimensionPx = 12,
      minRasterDataUriLength = 200
    } = config;
    const extSet = new Set(directExtensions);
    const subtitleExtSet = new Set(subtitleExtensions);
    const seen = new Set();
    const seenSvgMarkup = new Set();
    const items = [];
    const videoElements = [];
    let hasBlobVideo = false;

    const isSafeHttpUrl = (url) => typeof url === 'string'
      && (url.startsWith('http://') || url.startsWith('https://'));
    const isSvgDataUri = (url) => typeof url === 'string'
      && /^data:image\/svg\+xml[;,]/i.test(url.trim());
    const isRasterDataUri = (url) => typeof url === 'string'
      && /^data:image\/(png|jpeg|jpg|webp|gif|avif)[;,]/i.test(url.trim())
      && url.trim().length >= minRasterDataUriLength;

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

    const parseBestSrcsetCandidate = (rawSrcset) => {
      if (!rawSrcset || typeof rawSrcset !== 'string') {
        return { url: '', score: -1 };
      }
      let best = { url: '', score: -1 };
      let cursor = 0;
      const len = rawSrcset.length;
      while (cursor < len) {
        while (cursor < len && /[\s,]/.test(rawSrcset[cursor])) {
          cursor += 1;
        }
        if (cursor >= len) {
          break;
        }
        const urlStart = cursor;
        while (cursor < len && !/\s/.test(rawSrcset[cursor])) {
          cursor += 1;
        }
        let candidateUrl = rawSrcset.slice(urlStart, cursor);
        while (cursor < len && /\s/.test(rawSrcset[cursor])) {
          cursor += 1;
        }
        let descriptor = '';
        if (candidateUrl.endsWith(',')) {
          candidateUrl = candidateUrl.slice(0, -1);
        } else if (cursor < len) {
          const descStart = cursor;
          while (cursor < len && rawSrcset[cursor] !== ',') {
            cursor += 1;
          }
          descriptor = rawSrcset.slice(descStart, cursor).trim();
        }
        let score = 1;
        const wMatch = /^(\d+(?:\.\d+)?)w$/i.exec(descriptor);
        const xMatch = /^(\d+(?:\.\d+)?)x$/i.exec(descriptor);
        if (wMatch) {
          score = Number.parseFloat(wMatch[1]);
        } else if (xMatch) {
          score = Number.parseFloat(xMatch[1]) * 1000;
        }
        const resolved = toAbsoluteUrl(candidateUrl);
        if (isSafeHttpUrl(resolved) && score > best.score) {
          best = { url: resolved, score };
        }
      }
      return best;
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
      const allowDataImage = type === mediaTypes.IMAGE && (isSvgDataUri(url) || isRasterDataUri(url));
      if (!isSafeHttpUrl(url) && !allowDataImage) {
        return;
      }
      if (seen.has(url)) {
        return;
      }
      seen.add(url);
      const entry = {
        url,
        type,
        source: sourceTag,
        width: meta.width || 0,
        height: meta.height || 0,
        duration: meta.duration || 0,
        title: meta.title || document.title || '',
        poster: meta.poster || ''
      };
      if (meta.ext) {
        entry.ext = meta.ext;
      }
      if (meta.svgMarkup) {
        entry.svgMarkup = meta.svgMarkup;
      }
      items.push(entry);
    };

    const collectRoots = () => {
      const roots = [document];
      const visited = new Set([document]);
      for (let i = 0; i < roots.length && roots.length < 250; i += 1) {
        const root = roots[i];
        if (!root || typeof root.querySelectorAll !== 'function') {
          continue;
        }
        const candidates = root.querySelectorAll('*') || [];
        for (let j = 0; j < candidates.length && roots.length < 250; j += 1) {
          const sr = candidates[j].shadowRoot;
          if (sr && !visited.has(sr)) {
            visited.add(sr);
            roots.push(sr);
          }
        }
      }
      return roots;
    };

    const domRoots = collectRoots();
    const queryAllRoots = (selector) => {
      const results = [];
      for (const root of domRoots) {
        if (typeof root.querySelectorAll !== 'function') {
          continue;
        }
        const matched = root.querySelectorAll(selector) || [];
        for (const el of matched) {
          results.push(el);
        }
      }
      return results;
    };

    for (const video of queryAllRoots('video')) {
      const rawPosterUrl = toAbsoluteUrl(video.getAttribute('poster'));
      const posterUrl = isSafeHttpUrl(rawPosterUrl) ? rawPosterUrl : '';
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

    for (const audio of queryAllRoots('audio')) {
      addItem(toAbsoluteUrl(audio.currentSrc || audio.getAttribute('src')), mediaTypes.AUDIO);
      for (const sourceEl of audio.querySelectorAll('source')) {
        addItem(toAbsoluteUrl(sourceEl.getAttribute('src')), mediaTypes.AUDIO);
      }
    }

    if (mediaTypes.SUBTITLE) {
      for (const track of queryAllRoots('track[src]')) {
        const trackUrl = toAbsoluteUrl(track.getAttribute('src'));
        const label = (track.getAttribute('label') || '').trim();
        const lang = (track.getAttribute('srclang') || '').trim();
        const trackTitle = [label, lang].filter(Boolean).join(' - ') || document.title || '';
        addItem(trackUrl, mediaTypes.SUBTITLE, { title: trackTitle });
      }
    }

    for (const img of queryAllRoots('img')) {
      const width = img.naturalWidth || img.width || 0;
      const height = img.naturalHeight || img.height || 0;
      if (width > 0 && height > 0 && (width < minImageDimensionPx || height < minImageDimensionPx)) {
        continue;
      }
      const title = img.getAttribute('alt') || document.title || '';
      let bestCandidate = parseBestSrcsetCandidate(img.getAttribute('srcset'));
      if (typeof img.closest === 'function') {
        const picture = img.closest('picture');
        if (picture && typeof picture.querySelectorAll === 'function') {
          for (const sourceEl of picture.querySelectorAll('source[srcset]')) {
            const candidate = parseBestSrcsetCandidate(sourceEl.getAttribute('srcset'));
            if (candidate.score > bestCandidate.score) {
              bestCandidate = candidate;
            }
          }
        }
      }
      if (bestCandidate.url) {
        addItem(bestCandidate.url, mediaTypes.IMAGE, { width, height, title });
      }
      addItem(toAbsoluteUrl(img.currentSrc || img.getAttribute('src')), mediaTypes.IMAGE, {
        width,
        height,
        title
      });
    }

    for (const canvas of queryAllRoots('canvas')) {
      const cWidth = canvas.width || 0;
      const cHeight = canvas.height || 0;
      if (cWidth < minImageDimensionPx || cHeight < minImageDimensionPx || typeof canvas.toDataURL !== 'function') {
        continue;
      }
      try {
        const dataUrl = canvas.toDataURL('image/png');
        if (isRasterDataUri(dataUrl)) {
          const label = (canvas.getAttribute && (canvas.getAttribute('aria-label') || canvas.getAttribute('id'))) || '';
          addItem(dataUrl, mediaTypes.IMAGE, {
            ext: 'png',
            width: cWidth,
            height: cHeight,
            title: label || document.title || ''
          });
        }
      } catch {
        // Ignore cross-origin tainted canvases
      }
    }

    for (const anchor of queryAllRoots('a[href]')) {
      const href = toAbsoluteUrl(anchor.getAttribute('href'));
      if (!href.startsWith('http://') && !href.startsWith('https://')) {
        continue;
      }
      try {
        const pathname = new URL(href).pathname;
        const dotIdx = pathname.lastIndexOf('.');
        const ext = dotIdx > 0 ? pathname.slice(dotIdx + 1).toLowerCase() : '';
        if (ext && (extSet.has(ext) || (mediaTypes.SUBTITLE && subtitleExtSet.has(ext)))) {
          const anchorType = mediaTypes.SUBTITLE && subtitleExtSet.has(ext)
            ? mediaTypes.SUBTITLE
            : mediaTypes.VIDEO;
          addItem(href, anchorType, {
            title: (anchor.textContent || '').trim() || document.title || ''
          });
        }
      } catch {
        // Ignore malformed anchor URLs
      }
    }

    const metaMediaSpec = [
      { key: 'og:video:secure_url', type: mediaTypes.VIDEO },
      { key: 'og:video:url', type: mediaTypes.VIDEO },
      { key: 'og:video', type: mediaTypes.VIDEO },
      { key: 'twitter:player:stream', type: mediaTypes.VIDEO },
      { key: 'og:audio:secure_url', type: mediaTypes.AUDIO },
      { key: 'og:audio', type: mediaTypes.AUDIO },
      { key: 'og:image:secure_url', type: mediaTypes.IMAGE },
      { key: 'og:image:url', type: mediaTypes.IMAGE },
      { key: 'og:image', type: mediaTypes.IMAGE },
      { key: 'twitter:image:src', type: mediaTypes.IMAGE },
      { key: 'twitter:image', type: mediaTypes.IMAGE }
    ];
    const metaKeyMap = new Map(metaMediaSpec.map((entry) => [entry.key, entry.type]));
    const ogTitleNodes = document.querySelectorAll('meta[property="og:title"], meta[name="twitter:title"]') || [];
    const ogTitleEl = ogTitleNodes[0] || null;
    const metaTitle = (ogTitleEl && ogTitleEl.getAttribute('content')) || document.title || '';

    for (const metaEl of (document.querySelectorAll('meta[property], meta[name]') || [])) {
      const prop = (metaEl.getAttribute('property') || metaEl.getAttribute('name') || '').toLowerCase().trim();
      const targetType = metaKeyMap.get(prop);
      if (!targetType) {
        continue;
      }
      const rawContent = metaEl.getAttribute('content');
      const absUrl = toAbsoluteUrl(rawContent);
      if (isSafeHttpUrl(absUrl)) {
        addItem(absUrl, targetType, { title: metaTitle });
      }
    }

    const ldStack = [];
    for (const scriptEl of (document.querySelectorAll('script[type="application/ld+json"]') || [])) {
      const rawJson = (scriptEl.textContent || '').trim();
      if (!rawJson) {
        continue;
      }
      try {
        ldStack.push(JSON.parse(rawJson));
      } catch {
        // Ignore invalid JSON-LD payloads
      }
    }
    let inspectedLdNodes = 0;
    while (ldStack.length > 0 && inspectedLdNodes < maxJsonLdNodes) {
      const node = ldStack.pop();
      inspectedLdNodes += 1;
      if (Array.isArray(node)) {
        for (const child of node) {
          if (child && typeof child === 'object') {
            ldStack.push(child);
          }
        }
        continue;
      }
      if (!node || typeof node !== 'object') {
        continue;
      }
      const rawLdType = Array.isArray(node['@type']) ? node['@type'][0] : node['@type'];
      const ldType = typeof rawLdType === 'string' ? rawLdType.toLowerCase() : '';
      const nodeTitle = (typeof node.name === 'string' && node.name.trim()) || metaTitle;
      const pushUrlField = (value, type) => {
        if (typeof value === 'string') {
          const absUrl = toAbsoluteUrl(value);
          if (isSafeHttpUrl(absUrl)) {
            addItem(absUrl, type, { title: nodeTitle });
          }
        } else if (value && typeof value === 'object' && typeof value.url === 'string') {
          const absUrl = toAbsoluteUrl(value.url);
          if (isSafeHttpUrl(absUrl)) {
            addItem(absUrl, type, { title: nodeTitle });
          }
        }
      };
      if (ldType === 'videoobject') {
        pushUrlField(node.contentUrl, mediaTypes.VIDEO);
        pushUrlField(node.thumbnailUrl, mediaTypes.IMAGE);
      } else if (ldType === 'audioobject') {
        pushUrlField(node.contentUrl, mediaTypes.AUDIO);
      } else if (ldType === 'imageobject') {
        pushUrlField(node.contentUrl || node.url, mediaTypes.IMAGE);
      }
      for (const value of Object.values(node)) {
        if (value && typeof value === 'object') {
          ldStack.push(value);
        }
      }
    }

    if (typeof window.getComputedStyle === 'function') {
      const cssUrlRegex = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
      const extractCssUrlCandidates = (rawCssValue, rect) => {
        if (!rawCssValue || rawCssValue === 'none' || !rawCssValue.includes('url(')) {
          return;
        }
        cssUrlRegex.lastIndex = 0;
        let match;
        while ((match = cssUrlRegex.exec(rawCssValue)) !== null) {
          const rawCandidate = match[2];
          if (isSvgDataUri(rawCandidate)) {
            addItem(rawCandidate.trim(), mediaTypes.IMAGE, {
              ext: 'svg',
              width: rect ? Math.round(rect.width) : 0,
              height: rect ? Math.round(rect.height) : 0,
              title: document.title || ''
            });
            continue;
          }
          if (isRasterDataUri(rawCandidate)) {
            addItem(rawCandidate.trim(), mediaTypes.IMAGE, {
              width: rect ? Math.round(rect.width) : 0,
              height: rect ? Math.round(rect.height) : 0,
              title: document.title || ''
            });
            continue;
          }
          const candidate = toAbsoluteUrl(rawCandidate);
          if (isSafeHttpUrl(candidate)) {
            addItem(candidate, mediaTypes.IMAGE, {
              width: rect ? Math.round(rect.width) : 0,
              height: rect ? Math.round(rect.height) : 0,
              title: document.title || ''
            });
          }
        }
      };

      const bgCandidates = [
        ...queryAllRoots('div, section, article, figure, span, a'),
        ...queryAllRoots('button, i')
      ];
      const inspectLimit = Math.min(bgCandidates.length, maxCssBgElements);
      for (let i = 0; i < inspectLimit; i += 1) {
        const el = bgCandidates[i];
        const rect = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
        if (rect && (rect.width < minImageDimensionPx || rect.height < minImageDimensionPx)) {
          continue;
        }
        let computed;
        try {
          computed = window.getComputedStyle(el);
        } catch {
          continue;
        }
        if (!computed) {
          continue;
        }
        extractCssUrlCandidates(computed.backgroundImage || '', rect);
        extractCssUrlCandidates(computed.maskImage || computed.webkitMaskImage || '', rect);
      }
    }

    const svgCandidates = queryAllRoots('svg');
    let svgAddedCount = 0;
    const parseViewBoxDims = (rawViewBox) => {
      if (typeof rawViewBox !== 'string' || !rawViewBox.trim()) {
        return { width: 0, height: 0 };
      }
      const parts = rawViewBox.trim().split(/[\s,]+/).map(Number);
      if (parts.length === 4 && Number.isFinite(parts[2]) && Number.isFinite(parts[3])) {
        return { width: Math.round(parts[2]), height: Math.round(parts[3]) };
      }
      return { width: 0, height: 0 };
    };
    const inlineUseSymbols = (svgClone) => {
      if (typeof svgClone.querySelectorAll !== 'function') {
        return;
      }
      const uses = svgClone.querySelectorAll('use') || [];
      const inlinedIds = new Set();
      let defsEl = null;
      for (const useEl of uses) {
        const rawHref = (useEl.getAttribute && (useEl.getAttribute('href') || useEl.getAttribute('xlink:href'))) || '';
        if (!rawHref) {
          continue;
        }
        if (!rawHref.startsWith('#')) {
          const externalBase = toAbsoluteUrl(rawHref.split('#')[0]);
          if (isSafeHttpUrl(externalBase) && /\.svg(?:$|[?#])/i.test(externalBase)) {
            addItem(externalBase, mediaTypes.IMAGE, {
              ext: 'svg',
              title: document.title || 'svg-sprite'
            });
          }
          continue;
        }
        if (typeof document.getElementById !== 'function') {
          continue;
        }
        const refId = rawHref.slice(1).trim();
        if (!refId || inlinedIds.has(refId)) {
          continue;
        }
        const refTarget = document.getElementById(refId);
        if (!refTarget || typeof refTarget.cloneNode !== 'function') {
          continue;
        }
        inlinedIds.add(refId);
        if (!defsEl && typeof document.createElementNS === 'function') {
          defsEl = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
          if (typeof svgClone.insertBefore === 'function') {
            svgClone.insertBefore(defsEl, svgClone.firstChild || null);
          }
        }
        if (defsEl && typeof defsEl.appendChild === 'function') {
          defsEl.appendChild(refTarget.cloneNode(true));
        }
      }
    };
    const serializeSvgElement = (svgEl, targetW, targetH) => {
      const clone = typeof svgEl.cloneNode === 'function' ? svgEl.cloneNode(true) : svgEl;
      if (typeof clone.setAttribute === 'function') {
        if (!clone.getAttribute('xmlns')) {
          clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
        }
        if (!clone.getAttribute('viewBox') && targetW > 0 && targetH > 0) {
          clone.setAttribute('viewBox', `0 0 ${targetW} ${targetH}`);
        }
        if (!clone.getAttribute('width') && targetW > 0) {
          clone.setAttribute('width', String(targetW));
        }
        if (!clone.getAttribute('height') && targetH > 0) {
          clone.setAttribute('height', String(targetH));
        }
      }
      inlineUseSymbols(clone);
      if (typeof clone.querySelectorAll === 'function') {
        for (const scriptNode of (clone.querySelectorAll('script') || [])) {
          if (typeof scriptNode.remove === 'function') {
            scriptNode.remove();
          }
        }
      }
      let markup = '';
      if (typeof XMLSerializer === 'function') {
        try {
          markup = new XMLSerializer().serializeToString(clone);
        } catch {
          markup = '';
        }
      }
      if (!markup && typeof clone.outerHTML === 'string') {
        markup = clone.outerHTML;
      }
      return markup.replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '').trim();
    };

    for (const svg of svgCandidates) {
      if (svgAddedCount >= maxSvgItems) {
        break;
      }
      if (typeof svg.closest === 'function' && (svg.closest('defs') || svg.closest('[data-media-harvest-ui]'))) {
        continue;
      }
      const drawableNodes = typeof svg.querySelectorAll === 'function'
        ? (svg.querySelectorAll('path, circle, rect, polygon, polyline, line, ellipse, text, use') || [])
        : [];
      if (drawableNodes.length === 0) {
        continue;
      }
      const rect = typeof svg.getBoundingClientRect === 'function' ? svg.getBoundingClientRect() : null;
      const attrW = Number.parseFloat(svg.getAttribute && svg.getAttribute('width')) || 0;
      const attrH = Number.parseFloat(svg.getAttribute && svg.getAttribute('height')) || 0;
      const vbDims = parseViewBoxDims(svg.getAttribute && svg.getAttribute('viewBox'));
      const svgWidth = Math.round((rect && rect.width > 0 ? rect.width : 0) || attrW || vbDims.width || 0);
      const svgHeight = Math.round((rect && rect.height > 0 ? rect.height : 0) || attrH || vbDims.height || 0);
      if (svgWidth > 0 && svgHeight > 0 && (svgWidth < minSvgDimensionPx || svgHeight < minSvgDimensionPx)) {
        continue;
      }

      const markup = serializeSvgElement(svg, svgWidth, svgHeight);
      if (!markup || !markup.toLowerCase().includes('<svg') || seenSvgMarkup.has(markup)) {
        continue;
      }
      seenSvgMarkup.add(markup);
      const titleNode = typeof svg.querySelector === 'function' ? svg.querySelector('title') : null;
      const ariaTitle = svg.getAttribute ? (svg.getAttribute('aria-label') || svg.getAttribute('id') || '') : '';
      const svgTitle = (ariaTitle || (titleNode && titleNode.textContent) || '').trim() || 'svg-graphic';
      const svgDataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
      addItem(svgDataUrl, mediaTypes.IMAGE, {
        ext: 'svg',
        width: svgWidth,
        height: svgHeight,
        title: svgTitle,
        svgMarkup: markup
      });
      svgAddedCount += 1;
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
