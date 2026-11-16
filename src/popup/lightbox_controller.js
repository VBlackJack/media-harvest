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

import { DEFAULT_FILENAMES, LIGHTBOX_BG_MODES } from '../config/constants.js';
import { isSvgDataUrl } from '../shared/media_classifier.js';
import {
  convertSvgToCurrentColor,
  extractSvgPalette,
  replaceSvgColor
} from '../shared/svg_utils.js';
import { resolveSvgMarkup } from './media_card.js';
import { localizeError } from './popup_helpers.js';

/**
 * Creates a controller managing the popup modal Lightbox Pro preview and SVG recoloring.
 * @param {object} deps
 * @returns {{
 *   applyLightboxBg: (mode: string) => void,
 *   applyRecoloredSvgToLightbox: (updatedSvg: string) => void,
 *   renderLightboxPalette: (svgMarkup: string) => void,
 *   copyLightboxContent: () => Promise<void>,
 *   openLightbox: (entry: object) => void,
 *   closeLightbox: () => void,
 *   bindLightboxEvents: (onDownloadEntry: (entry: object) => void) => void
 * }}
 */
export function createLightboxController({
  doc,
  els,
  state,
  translateFn,
  setStatusBanner,
  writeClipboardFn
}) {
  function applyLightboxBg(mode) {
    const safeMode = Object.values(LIGHTBOX_BG_MODES).includes(mode)
      ? mode
      : LIGHTBOX_BG_MODES.CHECKER;
    state.lightboxBg = safeMode;
    if (els.lightboxStage) {
      els.lightboxStage.classList.toggle('is-bg-checker', safeMode === LIGHTBOX_BG_MODES.CHECKER);
      els.lightboxStage.classList.toggle('is-bg-light', safeMode === LIGHTBOX_BG_MODES.LIGHT);
      els.lightboxStage.classList.toggle('is-bg-dark', safeMode === LIGHTBOX_BG_MODES.DARK);
    }
    const toggleActive = (btn, active) => {
      if (btn) {
        btn.classList.toggle('is-active', active);
        btn.setAttribute('aria-pressed', String(active));
      }
    };
    toggleActive(els.lightboxBgCheckerBtn, safeMode === LIGHTBOX_BG_MODES.CHECKER);
    toggleActive(els.lightboxBgLightBtn, safeMode === LIGHTBOX_BG_MODES.LIGHT);
    toggleActive(els.lightboxBgDarkBtn, safeMode === LIGHTBOX_BG_MODES.DARK);
  }

  function isSvgItemEntry(item) {
    return Boolean(
      item
      && (
        item.svgMarkup
        || (item.ext || '').toLowerCase() === DEFAULT_FILENAMES.SVG_EXT
        || isSvgDataUrl(item.url)
      )
    );
  }

  function renderLightboxPalette(svgMarkup) {
    if (!els.lightboxPaletteBar || !els.lightboxPaletteSwatches) {
      return;
    }
    const colors = svgMarkup ? extractSvgPalette(svgMarkup) : [];
    els.lightboxPaletteSwatches.replaceChildren();
    if (!svgMarkup || colors.length === 0) {
      els.lightboxPaletteBar.classList.add('hidden');
      return;
    }
    for (const color of colors) {
      const swatch = doc.createElement('label');
      swatch.className = 'lightbox-swatch-item';
      swatch.title = translateFn('popup_lightbox_recolor_title', [color]);

      const dot = doc.createElement('span');
      dot.className = 'lightbox-swatch-dot';
      if (dot.style) {
        dot.style.backgroundColor = color;
      }

      const code = doc.createElement('span');
      code.textContent = color;

      const input = doc.createElement('input');
      input.type = 'color';
      input.className = 'lightbox-swatch-input';
      input.setAttribute('aria-label', translateFn('popup_lightbox_recolor_title', [color]));
      if (/^#[0-9a-f]{6}$/i.test(color)) {
        input.value = color;
      }
      input.addEventListener('change', () => {
        if (!state.lightboxSvgMarkup || !input.value) {
          return;
        }
        const recolored = replaceSvgColor(state.lightboxSvgMarkup, color, input.value);
        applyRecoloredSvgToLightbox(recolored);
      });

      swatch.appendChild(dot);
      swatch.appendChild(code);
      swatch.appendChild(input);
      els.lightboxPaletteSwatches.appendChild(swatch);
    }
    if (els.lightboxCurrentColorBtn) {
      els.lightboxCurrentColorBtn.classList.toggle(
        'hidden',
        colors.every((c) => c === 'currentcolor')
      );
    }
    els.lightboxPaletteBar.classList.remove('hidden');
  }

  function applyRecoloredSvgToLightbox(updatedSvg) {
    if (!state.lightboxEntry || !state.lightboxEntry.item || !updatedSvg) {
      return;
    }
    state.lightboxSvgMarkup = updatedSvg;
    const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(updatedSvg)}`;
    state.lightboxEntry.item.svgMarkup = updatedSvg;
    state.lightboxEntry.item.svgSymbolId = '';
    state.lightboxEntry.item.url = dataUrl;
    if (els.lightboxImg) {
      els.lightboxImg.src = dataUrl;
    }
    if (state.lightboxEntry.thumbEl) {
      state.lightboxEntry.thumbEl.src = dataUrl;
    }
    renderLightboxPalette(updatedSvg);
  }

  async function copyLightboxContent() {
    if (!state.lightboxEntry || !state.lightboxEntry.item) {
      return;
    }
    const { item } = state.lightboxEntry;
    const isSvgItem = isSvgItemEntry(item);
    let payloadText = item.url || '';
    if (isSvgItem) {
      try {
        payloadText = state.lightboxSvgMarkup || (await resolveSvgMarkup(item)) || payloadText;
      } catch {
        payloadText = item.url || '';
      }
    }
    const writeFn = writeClipboardFn
      || (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function'
        ? (text) => navigator.clipboard.writeText(text)
        : null);
    if (writeFn && payloadText) {
      try {
        await writeFn(payloadText);
        setStatusBanner(translateFn('popup_action_copied'));
      } catch (err) {
        setStatusBanner(localizeError(err && err.message, translateFn), true);
      }
    }
  }

  function openLightbox(entry) {
    if (!entry || !entry.item || !els.imageLightbox || !els.lightboxImg) {
      return;
    }
    const { item } = entry;
    state.lightboxEntry = entry;
    state.lightboxSvgMarkup = '';
    els.lightboxImg.src = item.url || '';
    els.lightboxImg.alt = item.suggestedFilename || '';
    if (els.lightboxTitle) {
      els.lightboxTitle.textContent = item.suggestedFilename || item.url || '';
    }
    if (els.lightboxMeta) {
      const parts = [];
      if (item.width && item.height) {
        parts.push(translateFn('popup_lightbox_dimensions', [String(item.width), String(item.height)]));
      }
      if (item.ext) {
        parts.push(String(item.ext).toUpperCase());
      }
      els.lightboxMeta.textContent = parts.join(' - ');
      els.lightboxMeta.classList.toggle('hidden', parts.length === 0);
    }
    const isSvgItem = isSvgItemEntry(item);
    if (els.lightboxCopyBtn) {
      els.lightboxCopyBtn.textContent = translateFn(
        isSvgItem ? 'popup_lightbox_copy_svg' : 'popup_lightbox_copy_url'
      );
    }
    renderLightboxPalette('');
    if (isSvgItem) {
      if (item.svgMarkup) {
        state.lightboxSvgMarkup = item.svgMarkup;
        renderLightboxPalette(item.svgMarkup);
      } else {
        resolveSvgMarkup(item)
          .then((markup) => {
            if (state.lightboxEntry === entry && markup) {
              state.lightboxSvgMarkup = markup;
              renderLightboxPalette(markup);
            }
          })
          .catch(() => {});
      }
    }
    applyLightboxBg(state.lightboxBg);
    els.imageLightbox.classList.remove('hidden');
    if (els.lightboxCloseBtn && typeof els.lightboxCloseBtn.focus === 'function') {
      els.lightboxCloseBtn.focus();
    }
  }

  function closeLightbox() {
    if (!els.imageLightbox) {
      return;
    }
    state.lightboxEntry = null;
    state.lightboxSvgMarkup = '';
    renderLightboxPalette('');
    els.imageLightbox.classList.add('hidden');
    if (els.lightboxImg) {
      els.lightboxImg.src = '';
    }
  }

  function bindLightboxEvents(onDownloadEntry) {
    if (els.lightboxCloseBtn) {
      els.lightboxCloseBtn.addEventListener('click', closeLightbox);
    }
    if (els.lightboxBackdrop) {
      els.lightboxBackdrop.addEventListener('click', closeLightbox);
    }
    if (els.lightboxBgCheckerBtn) {
      els.lightboxBgCheckerBtn.addEventListener('click', () => applyLightboxBg(LIGHTBOX_BG_MODES.CHECKER));
    }
    if (els.lightboxBgLightBtn) {
      els.lightboxBgLightBtn.addEventListener('click', () => applyLightboxBg(LIGHTBOX_BG_MODES.LIGHT));
    }
    if (els.lightboxBgDarkBtn) {
      els.lightboxBgDarkBtn.addEventListener('click', () => applyLightboxBg(LIGHTBOX_BG_MODES.DARK));
    }
    if (els.lightboxCopyBtn) {
      els.lightboxCopyBtn.addEventListener('click', copyLightboxContent);
    }
    if (els.lightboxCurrentColorBtn) {
      els.lightboxCurrentColorBtn.addEventListener('click', () => {
        if (!state.lightboxSvgMarkup) {
          return;
        }
        applyRecoloredSvgToLightbox(convertSvgToCurrentColor(state.lightboxSvgMarkup));
      });
    }
    if (els.lightboxDownloadBtn) {
      els.lightboxDownloadBtn.addEventListener('click', () => {
        if (state.lightboxEntry) {
          onDownloadEntry(state.lightboxEntry);
        }
      });
    }
  }

  return {
    applyLightboxBg,
    applyRecoloredSvgToLightbox,
    renderLightboxPalette,
    copyLightboxContent,
    openLightbox,
    closeLightbox,
    bindLightboxEvents
  };
}
