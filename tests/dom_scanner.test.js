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

import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const prevWindow = globalThis.window;
const prevDocument = globalThis.document;

let mockElementsBySelector = { img: [], video: [], audio: [], 'a[href]': [] };

function withAttrs(attrs, extra = {}) {
  return {
    ...extra,
    getAttribute: (name) => (Object.hasOwn(attrs, name) ? attrs[name] : null),
    querySelectorAll: extra.querySelectorAll || (() => [])
  };
}

globalThis.window = {
  location: { href: 'https://example.com/gallery' }
};
globalThis.document = {
  title: 'Sample Gallery',
  querySelectorAll: (selector) => mockElementsBySelector[selector] || [],
  createElement: () => ({
    width: 0,
    height: 0,
    getContext: () => null
  })
};

beforeEach(() => {
  mockElementsBySelector = { img: [], video: [], audio: [], 'a[href]': [] };
});

after(() => {
  globalThis.window = prevWindow;
  globalThis.document = prevDocument;
});

await import('../src/content/dom_scanner.js');

const DEFAULT_CFG = {
  minImageDimensionPx: 100,
  previewMaxWidthPx: 240,
  previewFrameQuality: 0.72,
  mediaTypes: { VIDEO: 'video', IMAGE: 'image', AUDIO: 'audio' },
  sourceTag: 'dom',
  directExtensions: ['mp4', 'jpg', 'png', 'mp3']
};

test('dom_scanner collects valid images above threshold, skips tiny tracking pixels, and flags blob videos', () => {
  mockElementsBySelector.img = [
    withAttrs(
      { alt: 'Hero Photo', src: 'https://cdn.example.com/photo.jpg' },
      {
        currentSrc: 'https://cdn.example.com/photo.jpg',
        naturalWidth: 1200,
        naturalHeight: 800,
        width: 600,
        height: 400
      }
    ),
    withAttrs(
      { alt: 'Tiny Icon' },
      {
        currentSrc: 'https://cdn.example.com/pixel.png',
        naturalWidth: 16,
        naturalHeight: 16,
        width: 16,
        height: 16
      }
    ),
    withAttrs(
      {},
      {
        currentSrc: 'data:image/png;base64,AAAA',
        naturalWidth: 500,
        naturalHeight: 500
      }
    )
  ];

  mockElementsBySelector.video = [
    withAttrs(
      { poster: 'https://cdn.example.com/poster.jpg' },
      {
        currentSrc: 'blob:https://example.com/abc',
        videoWidth: 1280,
        videoHeight: 720,
        duration: 42
      }
    ),
    withAttrs(
      { poster: 'javascript:alert(1)' },
      {
        currentSrc: 'https://cdn.example.com/clip.mp4',
        videoWidth: 1920,
        videoHeight: 1080,
        duration: 15
      }
    )
  ];

  mockElementsBySelector.audio = [
    withAttrs(
      {},
      {
        currentSrc: 'https://cdn.example.com/track.mp3',
        duration: 180
      }
    )
  ];

  mockElementsBySelector['a[href]'] = [
    withAttrs({ href: 'https://cdn.example.com/download/archive.mp4' }, { textContent: 'Archive MP4' }),
    withAttrs({ href: 'https://cdn.example.com/page.html' }, { textContent: 'HTML Link' })
  ];

  const result = globalThis.window.__mediaHarvestScan(DEFAULT_CFG);
  assert.equal(result.pageTitle, 'Sample Gallery');
  assert.equal(result.hasBlobVideo, true);
  assert.deepEqual(
    result.items.map((i) => i.url),
    [
      'https://cdn.example.com/poster.jpg',
      'https://cdn.example.com/clip.mp4',
      'https://cdn.example.com/track.mp3',
      'https://cdn.example.com/photo.jpg',
      'https://cdn.example.com/download/archive.mp4'
    ]
  );

  assert.equal(result.videoElements.length, 2);
  assert.equal(result.videoElements[0].poster, 'https://cdn.example.com/poster.jpg');
  // Unsafe javascript: poster URL must be dropped from videoElements metadata
  assert.equal(result.videoElements[1].poster, '');
});

test('dom_scanner extracts highest-resolution candidate from srcset and picture sources including URL commas', () => {
  const pictureSources = [
    withAttrs({
      srcset: 'https://cdn.example.com/img/w_400,q_80/hero.avif 400w, https://cdn.example.com/img/w_1600,q_80/hero.avif 1600w'
    })
  ];
  const fakePicture = {
    querySelectorAll: (sel) => (sel === 'source[srcset]' ? pictureSources : [])
  };

  mockElementsBySelector.img = [
    withAttrs(
      {
        alt: 'Responsive Hero',
        srcset: 'https://cdn.example.com/img/low.jpg 1x, https://cdn.example.com/img/hd.jpg 2x'
      },
      {
        currentSrc: 'https://cdn.example.com/img/low.jpg',
        naturalWidth: 400,
        naturalHeight: 300,
        closest: (sel) => (sel === 'picture' ? fakePicture : null)
      }
    )
  ];

  const result = globalThis.window.__mediaHarvestScan(DEFAULT_CFG);
  assert.deepEqual(
    result.items.map((i) => i.url),
    [
      'https://cdn.example.com/img/hd.jpg',
      'https://cdn.example.com/img/low.jpg'
    ]
  );

  // When picture source uses w descriptor exceeding 2000 (3000w > 2x*1000=2000), picture source wins
  pictureSources[0] = withAttrs({
    srcset: 'https://cdn.example.com/img/ultra.avif 3000w'
  });
  const ultraResult = globalThis.window.__mediaHarvestScan(DEFAULT_CFG);
  assert.equal(ultraResult.items[0].url, 'https://cdn.example.com/img/ultra.avif');
});

test('dom_scanner captures subtitle <track> elements and subtitle anchor links', () => {
  mockElementsBySelector['track[src]'] = [
    withAttrs({ src: '/subs/en.vtt', srclang: 'en', label: 'English' })
  ];
  mockElementsBySelector['a[href]'] = [
    withAttrs({ href: '/captions/movie.srt' }, { textContent: 'French Subtitles' })
  ];

  const result = globalThis.window.__mediaHarvestScan({
    ...DEFAULT_CFG,
    mediaTypes: {
      ...DEFAULT_CFG.mediaTypes,
      SUBTITLE: 'subtitle'
    },
    subtitleExtensions: ['vtt', 'srt']
  });

  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].type, 'subtitle');
  assert.equal(result.items[0].url, 'https://example.com/subs/en.vtt');
  assert.equal(result.items[0].title, 'English - en');
  assert.equal(result.items[1].type, 'subtitle');
  assert.equal(result.items[1].url, 'https://example.com/captions/movie.srt');
});

test('dom_scanner traverses open Shadow DOM, meta tags, JSON-LD, and CSS background-image URLs', () => {
  const shadowImg = withAttrs(
    { src: 'https://cdn.example.com/shadow-pic.png', alt: 'Shadow Image' },
    { naturalWidth: 320, naturalHeight: 240 }
  );
  const shadowHost = {
    shadowRoot: {
      querySelectorAll: (sel) => {
        if (sel === 'img') {
          return [shadowImg];
        }
        return [];
      }
    }
  };
  const bgElement = {
    getBoundingClientRect: () => ({ width: 400, height: 300 }),
    __bg: 'url("https://cdn.example.com/bg-hero.webp")'
  };
  const prevGetComputedStyle = globalThis.window.getComputedStyle;
  globalThis.window.getComputedStyle = (el) => ({ backgroundImage: el.__bg || 'none' });

  mockElementsBySelector['*'] = [shadowHost];
  mockElementsBySelector['meta[property], meta[name]'] = [
    withAttrs({ property: 'og:video', content: 'https://cdn.example.com/og-clip.mp4' }),
    withAttrs({ name: 'twitter:image', content: 'https://cdn.example.com/og-thumb.jpg' })
  ];
  mockElementsBySelector['script[type="application/ld+json"]'] = [
    {
      textContent: JSON.stringify({
        '@type': 'VideoObject',
        name: 'LD Sample Title',
        contentUrl: 'https://cdn.example.com/ld-video.mp4',
        thumbnailUrl: 'https://cdn.example.com/ld-thumb.jpg'
      })
    }
  ];
  mockElementsBySelector['div, section, article, figure, span, a'] = [bgElement];

  try {
    const result = globalThis.window.__mediaHarvestScan(DEFAULT_CFG);
    const urls = result.items.map((item) => item.url);
    assert.ok(urls.includes('https://cdn.example.com/shadow-pic.png'));
    assert.ok(urls.includes('https://cdn.example.com/og-clip.mp4'));
    assert.ok(urls.includes('https://cdn.example.com/og-thumb.jpg'));
    assert.ok(urls.includes('https://cdn.example.com/ld-video.mp4'));
    assert.ok(urls.includes('https://cdn.example.com/ld-thumb.jpg'));
    assert.ok(urls.includes('https://cdn.example.com/bg-hero.webp'));
  } finally {
    globalThis.window.getComputedStyle = prevGetComputedStyle;
    mockElementsBySelector = { img: [], video: [], audio: [], 'a[href]': [] };
  }
});

test('dom_scanner extracts inline <svg> with <use> symbol resolution and CSS svg data URIs', () => {
  const clonedDefs = {
    children: [],
    appendChild(node) { this.children.push(node); }
  };
  const symbolDefNode = {
    tagName: 'SYMBOL',
    cloneNode: () => ({ tagName: 'SYMBOL', outerHTML: '<symbol id="brand-mark"><path d="M1 1"/></symbol>' })
  };
  const svgAttrs = { viewBox: '0 0 48 48', 'aria-label': 'Brand Icon', onclick: 'evil()' };
  const svgUseEl = withAttrs({ href: '#brand-mark' });
  const scriptEl = { removed: false, remove() { this.removed = true; } };
  const inlineSvgEl = {
    getAttribute: (name) => (Object.hasOwn(svgAttrs, name) ? svgAttrs[name] : null),
    setAttribute: (name, val) => { svgAttrs[name] = String(val); },
    querySelectorAll: (sel) => {
      if (sel.includes('path')) {
        return [svgUseEl];
      }
      if (sel === 'use') {
        return [svgUseEl];
      }
      if (sel === 'script') {
        return [scriptEl];
      }
      return [];
    },
    querySelector: () => null,
    getBoundingClientRect: () => ({ width: 48, height: 48 }),
    insertBefore: () => {},
    cloneNode: () => ({
      ...inlineSvgEl,
      outerHTML: '<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg" onclick="evil()"><defs><symbol id="brand-mark"><path d="M1 1"/></symbol></defs><use href="#brand-mark"/></svg>'
    })
  };
  const bgSvgEl = {
    getBoundingClientRect: () => ({ width: 120, height: 120 }),
    __bg: 'url("data:image/svg+xml;charset=utf-8,%3Csvg%3E%3Crect%20width%3D%2210%22%2F%3E%3C%2Fsvg%3E")'
  };

  const prevGetById = globalThis.document.getElementById;
  const prevCreateNs = globalThis.document.createElementNS;
  const prevGetComputedStyle = globalThis.window.getComputedStyle;
  globalThis.document.getElementById = (id) => (id === 'brand-mark' ? symbolDefNode : null);
  globalThis.document.createElementNS = () => clonedDefs;
  globalThis.window.getComputedStyle = (el) => ({ backgroundImage: el.__bg || 'none' });

  mockElementsBySelector.svg = [inlineSvgEl];
  mockElementsBySelector['div, section, article, figure, span, a'] = [bgSvgEl];

  try {
    const result = globalThis.window.__mediaHarvestScan(DEFAULT_CFG);
    const svgItems = result.items.filter((i) => i.ext === 'svg');
    assert.equal(svgItems.length, 2);
    const inlineItem = svgItems.find((i) => i.title === 'Brand Icon');
    assert.ok(inlineItem);
    assert.ok(inlineItem.url.startsWith('data:image/svg+xml;charset=utf-8,'));
    assert.equal(inlineItem.svgMarkup.includes('onclick='), false);
    assert.equal(scriptEl.removed, true);
    assert.equal(clonedDefs.children.length, 1);
    assert.ok(svgItems.some((i) => i.url.includes('%3Crect')));
  } finally {
    globalThis.document.getElementById = prevGetById;
    globalThis.document.createElementNS = prevCreateNs;
    globalThis.window.getComputedStyle = prevGetComputedStyle;
    mockElementsBySelector = { img: [], video: [], audio: [], 'a[href]': [] };
  }
});

test('dom_scanner captures non-tainted canvas, CSS mask-image, and external <use href> SVG sprites', () => {
  const longPngDataUrl = `data:image/png;base64,${'A'.repeat(220)}`;
  const validCanvas = withAttrs(
    { 'aria-label': 'Chart Snapshot' },
    {
      width: 320,
      height: 200,
      toDataURL: () => longPngDataUrl
    }
  );
  const taintedCanvas = {
    width: 300,
    height: 300,
    toDataURL: () => {
      throw new Error('SecurityError');
    }
  };
  const maskBtnEl = {
    getBoundingClientRect: () => ({ width: 128, height: 128 }),
    __mask: 'url("https://cdn.example.com/icons/mask-logo.svg")'
  };
  const externalUseEl = withAttrs({ href: '/sprites/ui.svg#arrow-right' });
  const spriteSvgAttrs = { viewBox: '0 0 120 120' };
  const externalUseSvgEl = {
    getAttribute: (name) => (Object.hasOwn(spriteSvgAttrs, name) ? spriteSvgAttrs[name] : null),
    setAttribute: (name, val) => { spriteSvgAttrs[name] = String(val); },
    querySelectorAll: (sel) => {
      if (sel.includes('path') || sel === 'use') {
        return [externalUseEl];
      }
      return [];
    },
    querySelector: () => null,
    getBoundingClientRect: () => ({ width: 120, height: 120 }),
    cloneNode: () => ({
      ...externalUseSvgEl,
      outerHTML: '<svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg"><use href="/sprites/ui.svg#arrow-right"/></svg>'
    })
  };

  const prevGetComputedStyle = globalThis.window.getComputedStyle;
  globalThis.window.getComputedStyle = (el) => ({ backgroundImage: 'none', maskImage: el.__mask || 'none' });
  mockElementsBySelector.canvas = [validCanvas, taintedCanvas];
  mockElementsBySelector['button, i'] = [maskBtnEl];
  mockElementsBySelector.svg = [externalUseSvgEl];

  try {
    const result = globalThis.window.__mediaHarvestScan({
      ...DEFAULT_CFG,
      minRasterDataUriLength: 200
    });
    const urls = result.items.map((item) => item.url);
    assert.ok(urls.includes(longPngDataUrl));
    assert.ok(urls.includes('https://cdn.example.com/icons/mask-logo.svg'));
    assert.ok(urls.includes('https://example.com/sprites/ui.svg'));
    const canvasItem = result.items.find((item) => item.url === longPngDataUrl);
    assert.equal(canvasItem.ext, 'png');
    assert.equal(canvasItem.title, 'Chart Snapshot');
  } finally {
    globalThis.window.getComputedStyle = prevGetComputedStyle;
    mockElementsBySelector = { img: [], video: [], audio: [], 'a[href]': [] };
  }
});
