// PDFox — PDF.js viewer wrapper
// Handles loading, rendering, zoom, rotation and viewport exposure.
// SPDX-License-Identifier: GPL-3.0-or-later

import * as pdfjsLib from '../node_modules/pdfjs-dist/build/pdf.mjs';
const { TextLayer } = pdfjsLib;

// Point the worker at the bundled worker file
pdfjsLib.GlobalWorkerOptions.workerSrc =
  new URL('../node_modules/pdfjs-dist/build/pdf.worker.mjs', import.meta.url).href;

export class PDFViewer {
  /**
   * @param {HTMLElement} container  - .pdf-pages element to render pages into
   */
  constructor(container) {
    this.container         = container;
    this.pdfDoc            = null;
    this.scale             = 1.0;
    this.pages             = []; // array of { wrapper, canvas, textDiv, annotCanvas, formLayer }
    this.pageRotations     = {}; // pageNum → user-added rotation in degrees
    this.pageBaseRotations = {}; // pageNum → PDF's own /Rotate value
    this.fieldValues       = {}; // fieldName → current value (for form fields)
    this._annCache         = {}; // pageNum → cached annotation array
    this._pendingRender    = new Set(); // pageNums needing re-render once visible
    this._io               = null;  // IntersectionObserver for deferred renders
    this.isSleeping        = false;
  }

  // Returns the total rotation (PDF base + user) for a page, 0/90/180/270
  getTotalRotation(pageNum) {
    const base = this.pageBaseRotations[pageNum] || 0;
    const user = this.pageRotations[pageNum]     || 0;
    return (base + user) % 360;
  }

  // Load from ArrayBuffer/Uint8Array and render all pages.
  // Always copies before handing to PDF.js — the worker transfers (detaches) the input buffer.
  async load(arrayBuffer) {
    const src      = arrayBuffer instanceof Uint8Array ? arrayBuffer : new Uint8Array(arrayBuffer);
    const dataCopy = src.slice();
    this._io?.disconnect();
    this._io = null;
    this._pendingRender.clear();

    await this.pdfDoc?.destroy();
    const loadingTask = pdfjsLib.getDocument({ data: dataCopy });
    this.pdfDoc = await loadingTask.promise;
    this.isSleeping = false;
    this.pages      = [];
    this._annCache  = {};
    // pageRotations and fieldValues are preserved across sleep/wake cycles
    this.container.innerHTML = '';
    for (let i = 1; i <= this.pdfDoc.numPages; i++) {
      await this._renderPage(i);
    }

    // Watch page wrappers: when a deferred (off-screen) page becomes visible,
    // render it now. root = the .viewer-pane scroll container.
    this._io = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        const pageNum = Number(entry.target.dataset.page);
        if (this._pendingRender.has(pageNum)) {
          this._pendingRender.delete(pageNum);
          this._renderPage(pageNum); // fire-and-forget
        }
      });
    }, { root: this.container.parentElement, threshold: 0 });

    this.pages.forEach(pd => { if (pd) this._io.observe(pd.wrapper); });
  }

  // Re-render at the new scale.
  // Visible pages are rendered immediately; off-screen pages are resized
  // (so layout / scrollbars stay correct) and queued for deferred rendering
  // once they scroll into view via the IntersectionObserver.
  async setZoom(scale) {
    const prevScale = this.scale;
    this.scale = Math.max(0.25, Math.min(5, scale));

    // First pass: render pages visible at the OLD layout, resize everything else.
    const visibleSet = this._getVisibleSet();

    for (let i = 1; i <= this.pdfDoc.numPages; i++) {
      if (visibleSet.has(i)) {
        await this._renderPage(i);
      } else {
        this._resizePageLayout(i, prevScale);
        this._pendingRender.add(i);
      }
    }

    // Second pass: after resizing, recompute which pages are visible.
    // Resizing off-screen pages changes the layout (e.g. zooming out shrinks
    // all pages so more fit in the viewport). The IntersectionObserver only
    // fires on *changes*, so pages that were already in the viewport won't
    // get a callback — we have to check them explicitly here.
    const nowVisible = this._getVisibleSet();
    for (const pageNum of nowVisible) {
      if (this._pendingRender.has(pageNum)) {
        await this._renderPage(pageNum);
      }
    }
  }

  // Rotate all pages by delta degrees (cumulative, clamped to 0/90/180/270)
  async rotateAll(delta) {
    for (let i = 1; i <= this.pdfDoc.numPages; i++) {
      this.pageRotations[i] = ((this.pageRotations[i] || 0) + delta + 360) % 360;
    }
    for (let i = 1; i <= this.pdfDoc.numPages; i++) {
      await this._renderPage(i);
    }
  }

  // Rotate a single page by delta degrees
  async rotatePage(pageNum, delta) {
    this.pageRotations[pageNum] = ((this.pageRotations[pageNum] || 0) + delta + 360) % 360;
    await this._renderPage(pageNum);
  }

  // Returns the page number of the page with the most screen area currently visible
  getVisiblePageNum() {
    const pane     = this.container.parentElement;
    const paneRect = pane.getBoundingClientRect();
    let best = 1, bestOverlap = 0;
    this.pages.forEach((p, idx) => {
      const r       = p.wrapper.getBoundingClientRect();
      const overlap = Math.min(r.bottom, paneRect.bottom) - Math.max(r.top, paneRect.top);
      if (overlap > bestOverlap) { bestOverlap = overlap; best = idx + 1; }
    });
    return best;
  }

  // Smooth-scroll the viewer pane to show the given page
  scrollToPage(pageNum) {
    const p = this.pages[pageNum - 1];
    if (p) p.wrapper.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // Returns the PDF.js viewport for a given 1-based page number (includes user rotation)
  async getViewport(pageNum) {
    const page     = await this.pdfDoc.getPage(pageNum);
    const rotation = (page.rotate + (this.pageRotations[pageNum] || 0)) % 360;
    return page.getViewport({ scale: this.scale, rotation });
  }

  // Returns { width, height } of the unscaled PDF page in PDF pts (no user rotation)
  async getPageSize(pageNum) {
    const page = await this.pdfDoc.getPage(pageNum);
    const vp   = page.getViewport({ scale: 1.0 });
    return { width: vp.width, height: vp.height };
  }

  // Returns the PDF outline (bookmarks) array, or null if none
  async getOutline() {
    if (!this.pdfDoc) return null;
    return this.pdfDoc.getOutline();
  }

  // Resolve an outline destination (string or array) to a 1-based page number
  async resolveOutlineDest(dest) {
    if (!dest) return null;
    let explicitDest = dest;
    if (typeof dest === 'string') {
      explicitDest = await this.pdfDoc.getDestination(dest);
    }
    if (!Array.isArray(explicitDest) || !explicitDest[0]) return null;
    const pageIndex = await this.pdfDoc.getPageIndex(explicitDest[0]);
    return pageIndex + 1;
  }

  get pageCount() {
    return this.pdfDoc ? this.pdfDoc.numPages : 0;
  }

  // Render a page thumbnail at a small scale; returns a data URL (JPEG)
  async renderThumbnail(pageNum, scale = 0.18) {
    const page     = await this.pdfDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale });
    const canvas   = document.createElement('canvas');
    canvas.width   = viewport.width;
    canvas.height  = viewport.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    return canvas.toDataURL('image/jpeg', 0.75);
  }

  // Release all PDF.js resources and clear rendered canvases.
  // pageRotations and fieldValues are intentionally kept so they survive wake.
  sleep() {
    this._io?.disconnect();
    this._io = null;
    this._pendingRender.clear();
    this.pdfDoc?.destroy();
    this.pdfDoc  = null;
    this.pages   = [];
    this._annCache = {};
    this.container.innerHTML = '';
    this.isSleeping = true;
  }

  // ── Private ────────────────────────────────────────────────

  // Returns a Set of 1-based page numbers whose wrappers overlap the visible
  // area of the scroll pane. Synchronous — uses offsetTop / offsetHeight.
  _getVisibleSet() {
    const pane   = this.container.parentElement;
    const top    = pane.scrollTop;
    const bottom = top + pane.clientHeight;
    const visible = new Set();
    this.pages.forEach((pd, idx) => {
      if (!pd) return;
      const pageTop    = pd.wrapper.offsetTop;
      const pageBottom = pageTop + pd.wrapper.offsetHeight;
      if (pageBottom > top && pageTop < bottom) visible.add(idx + 1);
    });
    // Always include at least page 1 so a fresh document has something to render
    if (visible.size === 0 && this.pages[0]) visible.add(1);
    return visible;
  }

  // Resize a page's wrapper and canvases to the new scale using a ratio
  // (prevScale → this.scale) without issuing a PDF.js render call.
  // Clearing canvas.width resets the canvas content, leaving it blank until
  // the deferred render fires when the page scrolls into view.
  _resizePageLayout(pageNum, prevScale) {
    const pd = this.pages[pageNum - 1];
    if (!pd || !prevScale) return;
    const ratio = this.scale / prevScale;
    const newW  = Math.round(pd.canvas.width  * ratio);
    const newH  = Math.round(pd.canvas.height * ratio);
    pd.wrapper.style.width  = `${newW}px`;
    pd.wrapper.style.height = `${newH}px`;
    pd.wrapper.style.setProperty('--scale-factor', this.scale);
    pd.canvas.width       = newW;
    pd.canvas.height      = newH;
    pd.annotCanvas.width  = newW;
    pd.annotCanvas.height = newH;
  }

  async _renderPage(pageNum) {
    this._pendingRender.delete(pageNum);
    const page     = await this.pdfDoc.getPage(pageNum);
    const userRot  = this.pageRotations[pageNum] || 0;
    this.pageBaseRotations[pageNum] = page.rotate; // store for saver
    const rotation = (page.rotate + userRot) % 360;
    const viewport = page.getViewport({ scale: this.scale, rotation });
    const idx      = pageNum - 1;

    let wrapper, canvas, textDiv, annotCanvas, formLayer;

    if (this.pages[idx]) {
      // Re-use existing DOM elements on zoom/rotate
      ({ wrapper, canvas, textDiv, annotCanvas, formLayer } = this.pages[idx]);
    } else {
      wrapper     = document.createElement('div');
      canvas      = document.createElement('canvas');
      textDiv     = document.createElement('div');
      annotCanvas = document.createElement('canvas');
      formLayer   = document.createElement('div');

      wrapper.className     = 'page-wrapper';
      canvas.className      = 'pdf-canvas';
      textDiv.className     = 'textLayer';
      annotCanvas.className = 'annot-canvas';
      formLayer.className   = 'form-layer';

      wrapper.dataset.page = pageNum;
      wrapper.append(canvas, textDiv, annotCanvas, formLayer);
      this.container.appendChild(wrapper);
      this.pages[idx] = { wrapper, canvas, textDiv, annotCanvas, formLayer };
    }

    // Resize wrapper and canvases to match viewport
    wrapper.style.width  = `${viewport.width}px`;
    wrapper.style.height = `${viewport.height}px`;
    // PDF.js v4 sizes the text layer via calc(var(--scale-factor) * N px)
    wrapper.style.setProperty('--scale-factor', this.scale);

    canvas.width  = viewport.width;
    canvas.height = viewport.height;

    annotCanvas.width  = viewport.width;
    annotCanvas.height = viewport.height;
    annotCanvas.style.pointerEvents = 'none';

    // Render PDF content
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;

    // Render text layer for selection (PDF.js 4.x class-based API)
    // setLayerDimensions() inside TextLayer constructor sets width/height via --scale-factor
    textDiv.innerHTML = '';
    const textLayer = new TextLayer({
      textContentSource: page.streamTextContent(),
      container: textDiv,
      viewport,
    });
    await textLayer.render();

    // Render interactive form field overlays
    await this._renderFormFields(pageNum, page, viewport, this.pages[idx]);
  }

  // ── Form field overlay ──────────────────────────────────────

  async _renderFormFields(pageNum, page, viewport, pageData) {
    const fl = pageData.formLayer;

    // Save any current values before rebuilding the layer
    fl.querySelectorAll('[data-field-name]').forEach(el => {
      const name = el.dataset.fieldName;
      if (name) this.fieldValues[name] = el.type === 'checkbox' ? el.checked : el.value;
    });
    fl.innerHTML = '';

    // Cache annotations per page so repeated re-renders (zoom/rotate) are fast
    if (!this._annCache[pageNum]) {
      this._annCache[pageNum] = await page.getAnnotations();
    }
    const annotations = this._annCache[pageNum];

    for (const ann of annotations) {
      if (ann.subtype !== 'Widget' || !ann.fieldType || !ann.rect) continue;
      // PDF spec (1-based): bit 15 = 0x4000 radio, bit 16 = 0x8000 push-button
      if (ann.fieldType === 'Btn' && (ann.fieldFlags & (0x4000 | 0x8000))) continue;

      // Convert PDF user-space rect to viewport (CSS-pixel) coordinates
      const [vx1, vy1] = viewport.convertToViewportPoint(ann.rect[0], ann.rect[1]);
      const [vx2, vy2] = viewport.convertToViewportPoint(ann.rect[2], ann.rect[3]);
      const left   = Math.min(vx1, vx2);
      const top    = Math.min(vy1, vy2);
      const width  = Math.abs(vx2 - vx1);
      const height = Math.abs(vy2 - vy1);

      const fieldName  = ann.fieldName || '';
      const savedValue = this.fieldValues[fieldName];

      let el;

      if (ann.fieldType === 'Tx') {
        el = ann.multiLine ? document.createElement('textarea') : document.createElement('input');
        if (el.tagName === 'INPUT') el.type = 'text';
        el.value     = savedValue !== undefined ? savedValue : (ann.fieldValue || '');
        el.className = 'form-field form-text';

      } else if (ann.fieldType === 'Btn') {
        // Checkbox
        el          = document.createElement('input');
        el.type     = 'checkbox';
        el.className = 'form-field form-checkbox';
        const defaultOn = ann.fieldValue && ann.fieldValue !== 'Off';
        el.checked  = savedValue !== undefined ? !!savedValue : defaultOn;

      } else if (ann.fieldType === 'Ch') {
        // Dropdown / list box
        el = document.createElement('select');
        el.className = 'form-field form-select';
        (ann.options || []).forEach(opt => {
          const o = document.createElement('option');
          o.value       = opt.exportValue;
          o.textContent = opt.displayValue || opt.exportValue;
          el.appendChild(o);
        });
        el.value = savedValue !== undefined ? savedValue : (ann.fieldValue || '');

      } else {
        continue;
      }

      el.dataset.fieldName = fieldName;

      if (el.type === 'checkbox') {
        // Centre checkbox within the field rect; keep browser-native size
        const size = Math.round(Math.min(width, height, 18));
        const cx   = left + (width  - size) / 2;
        const cy   = top  + (height - size) / 2;
        el.style.cssText = `position:absolute;left:${cx}px;top:${cy}px;width:${size}px;height:${size}px;pointer-events:auto;margin:0;`;
      } else {
        const fontSize = Math.max(8, Math.round(height * 0.65));
        el.style.cssText =
          `position:absolute;left:${left}px;top:${top}px;` +
          `width:${width}px;height:${height}px;` +
          `box-sizing:border-box;pointer-events:auto;font-size:${fontSize}px;` +
          (ann.multiLine ? 'resize:none;' : '');
      }

      // Keep fieldValues in sync as the user types / changes
      el.addEventListener('change', () => {
        this.fieldValues[fieldName] = el.type === 'checkbox' ? el.checked : el.value;
      });
      if (el.type !== 'checkbox') {
        el.addEventListener('input', () => { this.fieldValues[fieldName] = el.value; });
      }

      fl.appendChild(el);
    }
  }
}
