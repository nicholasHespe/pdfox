// Reamlet — PDF.js viewer wrapper
// Handles loading, rendering, zoom, rotation and viewport exposure.
// SPDX-License-Identifier: GPL-3.0-or-later

// @ts-expect-error — pdfjs-dist is imported via direct path for Electron's file:// ESM loader
import * as _pdfjsLib from '../../node_modules/pdfjs-dist/build/pdf.mjs';
import type * as PDFJSLib from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy, PageViewport } from 'pdfjs-dist';

// Cast to the pdfjs-dist type surface so all downstream code is fully typed
const pdfjsLib = _pdfjsLib as unknown as typeof PDFJSLib;
const { TextLayer } = pdfjsLib;

// Point the worker at the bundled worker file
pdfjsLib.GlobalWorkerOptions.workerSrc =
  new URL('../../node_modules/pdfjs-dist/build/pdf.worker.mjs', import.meta.url).href;

/** Subset of PDF.js annotation data we consume for interactive form-field rendering. */
interface PDFFormAnnotation {
  subtype: string;
  fieldType?: string;
  fieldFlags?: number;
  rect?: [number, number, number, number];
  fieldName?: string;
  fieldValue?: string;
  multiLine?: boolean;
  options?: { exportValue: string; displayValue?: string }[];
}

export interface PageData {
  wrapper: HTMLDivElement;
  canvas: HTMLCanvasElement;
  textDiv: HTMLDivElement;
  annotCanvas: HTMLCanvasElement;
  formLayer: HTMLDivElement;
  viewportTransform: number[] | null;
}

export class PDFViewer {
  container: HTMLElement;
  pdfDoc: PDFDocumentProxy | null;
  scale: number;
  pages: PageData[];
  pageRotations: Record<number, number>;
  pageBaseRotations: Record<number, number>;
  fieldValues: Record<string, string | boolean>;
  _annCache: Record<number, PDFFormAnnotation[]>;
  _pendingRender: Set<number>;
  _io: IntersectionObserver | null;
  _pageSizeCache: Record<number, { width: number; height: number }>;
  isSleeping: boolean;

  /**
   * @param {HTMLElement} container  - .pdf-pages element to render pages into
   */
  constructor(container: HTMLElement) {
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
    this._pageSizeCache    = {}; // pageNum → { width, height } in PDF pts — survives sleep
    this.isSleeping        = false;
  }

  // Returns the total rotation (PDF base + user) for a page, 0/90/180/270
  getTotalRotation(pageNum: number): number {
    const base = this.pageBaseRotations[pageNum] || 0;
    const user = this.pageRotations[pageNum]     || 0;
    return (base + user) % 360;
  }

  // Load from ArrayBuffer/Uint8Array and render all pages.
  // Always copies before handing to PDF.js — the worker transfers (detaches) the input buffer.
  //
  // Phase 1: create placeholder wrappers (correct sizes, blank canvases) for every page.
  // Phase 2: fully render only the pages that fall within the first 10 viewport-heights.
  //          This keeps initial load fast for large documents while being imperceptible
  //          for small ones (all pages fit in 10 viewports).
  // Phase 3: wire up IntersectionObserver so the rest render as the user scrolls.
  async load(arrayBuffer: ArrayBuffer | Uint8Array): Promise<void> {
    const src      = arrayBuffer instanceof Uint8Array ? arrayBuffer : new Uint8Array(arrayBuffer);
    const dataCopy = src.slice();
    this._io?.disconnect();
    this._io = null;
    this._pendingRender.clear();

    await this.pdfDoc?.destroy();
    const loadingTask = pdfjsLib.getDocument({ data: dataCopy });
    this.pdfDoc = await loadingTask.promise as PDFDocumentProxy;
    this.isSleeping  = false;
    this.pages       = [];
    this._annCache   = {};
    this._pageSizeCache = {}; // reset for the new document
    // pageRotations and fieldValues are preserved across sleep/wake cycles
    this.container.innerHTML = '';

    // Phase 1 — create sized placeholders for every page so layout/scrollbars
    // are correct before any rendering begins.
    for (let i = 1; i <= this.pdfDoc!.numPages; i++) {
      await this._createPagePlaceholder(i);
    }

    // Phase 2 — wire up the IntersectionObserver BEFORE rendering so it fires
    // immediately for all pages currently in the intersection zone.
    this._io = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        const pageNum = Number((entry.target as HTMLElement).dataset.page);
        if (this._pendingRender.has(pageNum)) {
          this._pendingRender.delete(pageNum);
          this._renderPage(pageNum); // fire-and-forget
        }
      });
    }, { root: this.container.parentElement, threshold: 0 });

    this.pages.forEach(pd => { if (pd) this._io!.observe(pd.wrapper); });

    // Phase 3 — eagerly render the initial 10-viewport window synchronously so
    // there is no blank-flash on open.  Pages outside this range are left as
    // placeholders and will be rendered by the IO as the user scrolls.
    const pane         = this.container.parentElement;
    const renderHeight = (pane ? pane.clientHeight : 800) * 10;
    let   accumulated  = 0;
    for (let i = 1; i <= this.pdfDoc!.numPages; i++) {
      if (accumulated < renderHeight) {
        this._pendingRender.delete(i); // won't be deferred
        await this._renderPage(i);
        accumulated += this.pages[i - 1]?.wrapper.offsetHeight ?? 0;
      } else {
        this._pendingRender.add(i);
      }
    }
  }

  // Re-render at the new scale.
  // Visible pages are rendered immediately; off-screen pages are resized
  // (so layout / scrollbars stay correct) and queued for deferred rendering
  // once they scroll into view via the IntersectionObserver.
  async setZoom(scale: number): Promise<void> {
    const prevScale = this.scale;
    this.scale = Math.max(0.25, Math.min(5, scale));

    // First pass: render pages visible at the OLD layout, resize everything else.
    const visibleSet = this._getVisibleSet();

    for (let i = 1; i <= this.pdfDoc!.numPages; i++) {
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

  // Rotate all pages by delta degrees (cumulative, clamped to 0/90/180/270).
  // Visible pages are rendered immediately; off-screen pages are resized and
  // queued for deferred rendering via the IntersectionObserver.
  async rotateAll(delta: number): Promise<void> {
    for (let i = 1; i <= this.pdfDoc!.numPages; i++) {
      this.pageRotations[i] = ((this.pageRotations[i] || 0) + delta + 360) % 360;
    }

    const visibleSet = this._getVisibleSet();
    for (let i = 1; i <= this.pdfDoc!.numPages; i++) {
      if (visibleSet.has(i)) {
        await this._renderPage(i);
      } else {
        this._resizePageForRotation(i);
        this._pendingRender.add(i);
      }
    }

    // After resizing off-screen pages the layout shifts; re-check which pages
    // are now visible and render any that slipped into the viewport.
    const nowVisible = this._getVisibleSet();
    for (const pageNum of nowVisible) {
      if (this._pendingRender.has(pageNum)) {
        await this._renderPage(pageNum);
      }
    }
  }

  // Rotate a single page by delta degrees
  async rotatePage(pageNum: number, delta: number): Promise<void> {
    this.pageRotations[pageNum] = ((this.pageRotations[pageNum] || 0) + delta + 360) % 360;
    await this._renderPage(pageNum);
  }

  // Returns the page number of the page with the most screen area currently visible
  getVisiblePageNum(): number {
    const pane     = this.container.parentElement;
    if (!pane) return 1;
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
  scrollToPage(pageNum: number): void {
    const p = this.pages[pageNum - 1];
    if (p) p.wrapper.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // Returns the PDF.js viewport for a given 1-based page number (includes user rotation)
  async getViewport(pageNum: number): Promise<PageViewport> {
    const page     = await this.pdfDoc!.getPage(pageNum);
    const rotation = (page.rotate + (this.pageRotations[pageNum] || 0)) % 360;
    return page.getViewport({ scale: this.scale, rotation });
  }

  // Returns { width, height } of the unscaled PDF page in PDF pts (no user rotation).
  // Results are cached so this works even while the viewer is sleeping (pdfDoc is null).
  async getPageSize(pageNum: number): Promise<{ width: number; height: number }> {
    if (this._pageSizeCache[pageNum]) return this._pageSizeCache[pageNum];
    const page = await this.pdfDoc!.getPage(pageNum);
    const vp   = page.getViewport({ scale: 1.0 });
    const size = { width: vp.width, height: vp.height };
    this._pageSizeCache[pageNum] = size;
    return size;
  }

  // Returns the PDF outline (bookmarks) array, or null if none
  async getOutline() {
    if (!this.pdfDoc) return null;
    return this.pdfDoc.getOutline();
  }

  // Resolve an outline destination (string or array) to a 1-based page number
  async resolveOutlineDest(dest: string | unknown[]): Promise<number | null> {
    if (!dest) return null;
     
    let explicitDest: unknown[] | null = Array.isArray(dest) ? dest : null;
    if (typeof dest === 'string') {
       
      explicitDest = await this.pdfDoc!.getDestination(dest);
    }
    if (!Array.isArray(explicitDest) || !explicitDest[0]) return null;
     
    const pageIndex = await this.pdfDoc!.getPageIndex(explicitDest[0] as { num: number; gen: number });
    return pageIndex + 1;
  }

  get pageCount() {
    return this.pdfDoc ? this.pdfDoc!.numPages : 0;
  }

  // Render a page thumbnail at a small scale; returns a data URL (JPEG)
  async renderThumbnail(pageNum: number, scale = 0.4): Promise<string> {
    const page     = await this.pdfDoc!.getPage(pageNum);
    const viewport = page.getViewport({ scale });
    const canvas   = document.createElement('canvas');
    canvas.width   = viewport.width;
    canvas.height  = viewport.height;
    await page.render({ canvasContext: canvas.getContext('2d')!, viewport }).promise;
    return canvas.toDataURL('image/jpeg', 0.92);
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

  // Permanently release all resources; the viewer cannot be used after this.
  destroy() {
    this.sleep();
  }

  // ── Private ────────────────────────────────────────────────

  // Returns a Set of 1-based page numbers whose wrappers overlap the visible
  // area of the scroll pane. Synchronous — uses offsetTop / offsetHeight.
  _getVisibleSet(): Set<number> {
    const pane = this.container.parentElement;
    if (!pane) return new Set<number>();
    const top    = pane.scrollTop;
    const bottom = top + pane.clientHeight;
    const visible = new Set<number>();
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

  // Resize a page's wrapper and canvases to account for a rotation change,
  // using the cached unscaled page size to compute the new dimensions.
  // Swaps width↔height when rotating to/from 90° or 270°.
  _resizePageForRotation(pageNum: number): void {
    const pd     = this.pages[pageNum - 1];
    const cached = this._pageSizeCache[pageNum];
    if (!pd || !cached) return;
    const rot = this.getTotalRotation(pageNum);
    const sw  = (rot % 180 === 0) ? cached.width  : cached.height;
    const sh  = (rot % 180 === 0) ? cached.height : cached.width;
    const w   = Math.round(sw * this.scale);
    const h   = Math.round(sh * this.scale);
    pd.wrapper.style.width  = `${w}px`;
    pd.wrapper.style.height = `${h}px`;
    pd.wrapper.style.setProperty('--scale-factor', String(this.scale));
    pd.canvas.width        = w;
    pd.canvas.height       = h;
    pd.annotCanvas.width   = w;
    pd.annotCanvas.height  = h;
  }

  // Resize a page's wrapper and canvases to the new scale using a ratio
  // (prevScale → this.scale) without issuing a PDF.js render call.
  // Clearing canvas.width resets the canvas content, leaving it blank until
  // the deferred render fires when the page scrolls into view.
  _resizePageLayout(pageNum: number, prevScale: number): void {
    const pd = this.pages[pageNum - 1];
    if (!pd || !prevScale) return;
    const ratio = this.scale / prevScale;
    const newW  = Math.round(pd.canvas.width  * ratio);
    const newH  = Math.round(pd.canvas.height * ratio);
    pd.wrapper.style.width  = `${newW}px`;
    pd.wrapper.style.height = `${newH}px`;
    pd.wrapper.style.setProperty('--scale-factor', String(this.scale));
    pd.canvas.width       = newW;
    pd.canvas.height      = newH;
    pd.annotCanvas.width  = newW;
    pd.annotCanvas.height = newH;
  }

  // Create a sized wrapper with blank canvases for a page without running the
  // PDF.js render pipeline.  This is used during load() so every page has the
  // right dimensions for layout / scrollbar accuracy before we start rendering.
  async _createPagePlaceholder(pageNum: number): Promise<void> {
    const page     = await this.pdfDoc!.getPage(pageNum);
    const userRot  = this.pageRotations[pageNum] || 0;
    this.pageBaseRotations[pageNum] = page.rotate;

    // Cache unscaled page size so getPageSize() works while sleeping.
    if (!this._pageSizeCache[pageNum]) {
      const vp1 = page.getViewport({ scale: 1.0 });
      this._pageSizeCache[pageNum] = { width: vp1.width, height: vp1.height };
    }

    const rotation = (page.rotate + userRot) % 360;
    const viewport = page.getViewport({ scale: this.scale, rotation });
    const idx      = pageNum - 1;
    if (this.pages[idx]) return; // already created

    const wrapper     = document.createElement('div');
    const canvas      = document.createElement('canvas');
    const textDiv     = document.createElement('div');
    const annotCanvas = document.createElement('canvas');
    const formLayer   = document.createElement('div');

    wrapper.className     = 'page-wrapper';
    canvas.className      = 'pdf-canvas';
    textDiv.className     = 'textLayer';
    annotCanvas.className = 'annot-canvas';
    formLayer.className   = 'form-layer';

    wrapper.dataset.page = String(pageNum);
    wrapper.append(canvas, textDiv, annotCanvas, formLayer);
    this.container.appendChild(wrapper);

    wrapper.style.width  = `${viewport.width}px`;
    wrapper.style.height = `${viewport.height}px`;
    wrapper.style.setProperty('--scale-factor', String(this.scale));

    canvas.width  = viewport.width;
    canvas.height = viewport.height;
    annotCanvas.width  = viewport.width;
    annotCanvas.height = viewport.height;
    annotCanvas.style.pointerEvents = 'none';

    // viewportTransform is null until _renderPage fills it in
    this.pages[idx] = { wrapper, canvas, textDiv, annotCanvas, formLayer, viewportTransform: null };
  }

  async _renderPage(pageNum: number): Promise<void> {
    this._pendingRender.delete(pageNum);
    const page     = await this.pdfDoc!.getPage(pageNum);
    const userRot  = this.pageRotations[pageNum] || 0;
    this.pageBaseRotations[pageNum] = page.rotate; // store for saver

    // Populate the page-size cache on every render (cheap: page object is already fetched).
    if (!this._pageSizeCache[pageNum]) {
      const vp1 = page.getViewport({ scale: 1.0 });
      this._pageSizeCache[pageNum] = { width: vp1.width, height: vp1.height };
    }

    const rotation = (page.rotate + userRot) % 360;
    const viewport = page.getViewport({ scale: this.scale, rotation });
    const idx      = pageNum - 1;

    let wrapper, canvas, textDiv, annotCanvas;

    if (this.pages[idx]) {
      // Re-use existing DOM elements on zoom/rotate (formLayer not needed — passed via this.pages[idx])
      ({ wrapper, canvas, textDiv, annotCanvas } = this.pages[idx]);
      this.pages[idx].viewportTransform = viewport.transform;
    } else {
      wrapper     = document.createElement('div');
      canvas      = document.createElement('canvas');
      textDiv     = document.createElement('div');
      annotCanvas = document.createElement('canvas');
      const formLayer = document.createElement('div');

      wrapper.className     = 'page-wrapper';
      canvas.className      = 'pdf-canvas';
      textDiv.className     = 'textLayer';
      annotCanvas.className = 'annot-canvas';
      formLayer.className   = 'form-layer';

      wrapper.dataset.page = String(pageNum);
      wrapper.append(canvas, textDiv, annotCanvas, formLayer);
      this.container.appendChild(wrapper);
      this.pages[idx] = { wrapper, canvas, textDiv, annotCanvas, formLayer, viewportTransform: viewport.transform };
    }

    // Resize wrapper and canvases to match viewport
    wrapper.style.width  = `${viewport.width}px`;
    wrapper.style.height = `${viewport.height}px`;
    // PDF.js v4 sizes the text layer via calc(var(--scale-factor) * N px)
    wrapper.style.setProperty('--scale-factor', String(this.scale));

    canvas.width  = viewport.width;
    canvas.height = viewport.height;

    annotCanvas.width  = viewport.width;
    annotCanvas.height = viewport.height;
    annotCanvas.style.pointerEvents = 'none';

    // Render PDF content
    const ctx = canvas.getContext('2d')!;
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

  async _renderFormFields(pageNum: number, page: PDFPageProxy, viewport: PageViewport, pageData: PageData): Promise<void> {
    const fl = pageData.formLayer;

    // Save any current values before rebuilding the layer
    fl.querySelectorAll('[data-field-name]').forEach((el) => {
      const name = (el as HTMLElement).dataset.fieldName;
      if (!name) return;
      if (el instanceof HTMLInputElement && el.type === 'checkbox') {
        this.fieldValues[name] = el.checked;
      } else {
        this.fieldValues[name] = (el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value;
      }
    });
    fl.innerHTML = '';

    // Cache annotations per page so repeated re-renders (zoom/rotate) are fast
    if (!this._annCache[pageNum]) {
      this._annCache[pageNum] = await page.getAnnotations() as unknown as PDFFormAnnotation[];
    }
    const annotations = this._annCache[pageNum];

    for (const ann of annotations) {
      if (ann.subtype !== 'Widget' || !ann.fieldType || !ann.rect) continue;
      // PDF spec (1-based): bit 15 = 0x4000 radio, bit 16 = 0x8000 push-button
      if (ann.fieldType === 'Btn' && ((ann.fieldFlags ?? 0) & (0x4000 | 0x8000))) continue;

      // Convert PDF user-space rect to viewport (CSS-pixel) coordinates
      const [vx1, vy1] = viewport.convertToViewportPoint(ann.rect[0], ann.rect[1]);
      const [vx2, vy2] = viewport.convertToViewportPoint(ann.rect[2], ann.rect[3]);
      const left   = Math.min(vx1, vx2);
      const top    = Math.min(vy1, vy2);
      const width  = Math.abs(vx2 - vx1);
      const height = Math.abs(vy2 - vy1);

      const fieldName  = ann.fieldName ?? '';
      const savedValue = fieldName in this.fieldValues ? this.fieldValues[fieldName] : undefined;

      let el!: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
      let isCheckbox = false;

      if (ann.fieldType === 'Tx') {
        if (ann.multiLine) {
          const ta = document.createElement('textarea');
          ta.value     = savedValue != null ? String(savedValue) : (ann.fieldValue ?? '');
          ta.className = 'form-field form-text';
          el = ta;
        } else {
          const inp = document.createElement('input');
          inp.type     = 'text';
          inp.value    = savedValue != null ? String(savedValue) : (ann.fieldValue ?? '');
          inp.className = 'form-field form-text';
          el = inp;
        }
      } else if (ann.fieldType === 'Btn') {
        // Checkbox
        const checkbox = document.createElement('input');
        checkbox.type      = 'checkbox';
        checkbox.className = 'form-field form-checkbox';
        const defaultOn    = Boolean(ann.fieldValue) && ann.fieldValue !== 'Off';
        checkbox.checked   = savedValue != null ? Boolean(savedValue) : defaultOn;
        el = checkbox;
        isCheckbox = true;
      } else if (ann.fieldType === 'Ch') {
        // Dropdown / list box
        const sel = document.createElement('select');
        sel.className = 'form-field form-select';
        (ann.options ?? []).forEach(opt => {
          const o = document.createElement('option');
          o.value       = opt.exportValue;
          o.textContent = opt.displayValue ?? opt.exportValue;
          sel.appendChild(o);
        });
        sel.value = savedValue != null ? String(savedValue) : (ann.fieldValue ?? '');
        el = sel;
      } else {
        continue;
      }

      el.dataset.fieldName = fieldName;

      if (isCheckbox) {
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
        this.fieldValues[fieldName] = isCheckbox
          ? (el as HTMLInputElement).checked
          : el.value;
      });
      if (!isCheckbox) {
        el.addEventListener('input', () => { this.fieldValues[fieldName] = el.value; });
      }

      fl.appendChild(el);
    }
  }
}
