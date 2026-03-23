// Reamlet — annotation layer
// Manages canvas overlays per page and stores annotation objects in memory.
// SPDX-License-Identifier: GPL-3.0-or-later

import type { PDFViewer, PageData } from './viewer.js';
import type { Annotation } from './types.js';

export class Annotator {
  pages: PageData[];
  viewer: PDFViewer | null;
  annotations: Annotation[];
  tool: string;
  color: string;
  thickness: number;
  textBold: boolean;
  textUnderline: boolean;
  textFontSize: number;
  _drawing: boolean;
  _currentPath: { pageNum: number; points: [number, number][]; color: string; thickness: number } | null;
  _shapeStart: { pageNum: number; pos: [number, number]; p: PageData } | null;
  _freehighlight: { pageNum: number; p: PageData; points: [number, number][] } | null;
  _erasing: boolean;
  _erasedAny: boolean;
  _selectedIdx: number | null;
  _selectedPageNum: number | null;
  _dragStart: { x: number; y: number } | null;
  _dragOrigAnn: Annotation | null;
  _dragPageRect: DOMRect | null;
  _history: string[];
  _histIdx: number;
  _handlers: Record<number, unknown>;
  _docMouseupHighlight!: (e: MouseEvent) => void;
  _docMousemoveDrag!: (e: MouseEvent) => void;
  _docMouseupDrag!: (e: MouseEvent) => void;
  _docKeydown!: (e: KeyboardEvent) => void;

  /**
   * @param {Object[]} pages  - viewer.pages array (each has annotCanvas, wrapper)
   * @param {PDFViewer} viewer - needed for font size in text tool (optional)
   */
  constructor(pages: PageData[], viewer?: PDFViewer) {
    this.pages   = pages;
    this.viewer  = viewer || null;

    this.annotations = [];
    this.tool        = 'select';
    this.color       = '#ff3333';
    this.thickness   = 3;
    this.textBold      = false;
    this.textUnderline = false;
    this.textFontSize  = 14;

    this._drawing      = false;
    this._currentPath  = null;
    this._shapeStart   = null;
    this._freehighlight = null; // freehand highlight path when not on text

    this._erasing      = false; // eraser drag state
    this._erasedAny    = false;

    // Select / move state
    this._selectedIdx     = null;  // index into this.annotations
    this._selectedPageNum = null;
    this._dragStart       = null;  // { x, y } screen pixels
    this._dragOrigAnn     = null;  // deep copy of annotation before drag
    this._dragPageRect    = null;  // wrapper getBoundingClientRect at drag start

    this._history = ['[]'];
    this._histIdx = 0;

    this._handlers = {};
    this._attachAll();
  }

  setTool(tool: string) {
    this.tool = tool;
    this._clearSelection();
    this._updateCursors();
    // Canvas captures pointer events for active drawing tools.
    // Select uses wrapper-level capture so text selection still works.
    const canvasCaptures = ['draw', 'text', 'line', 'rect', 'oval', 'arrow', 'eraser'].includes(tool);
    this.pages.forEach(p => {
      p.annotCanvas.style.pointerEvents = canvasCaptures ? 'auto' : 'none';
      // Block form fields while a drawing tool is active so strokes aren't eaten by inputs.
      // Must be set on each individual field element because pointer-events:none on a parent
      // does not suppress children that have pointer-events:auto in their inline style.
      p.formLayer.querySelectorAll('[data-field-name]').forEach((el: Element) => {
        (el as HTMLElement).style.pointerEvents = canvasCaptures ? 'none' : 'auto';
      });
    });
  }

  setColor(color: string)       { this.color        = color; }
  setThickness(t: number)       { this.thickness    = t; }
  setTextBold(b: boolean)       { this.textBold     = b; }
  setTextUnderline(b: boolean)  { this.textUnderline = b; }
  setTextFontSize(size: number) { this.textFontSize = Math.max(8, Math.min(96, size)); }

  clear() {
    this.annotations = [];
    this._clearSelection();
    this.pages.forEach(p => {
      const ctx = p.annotCanvas.getContext('2d')!;
      ctx.clearRect(0, 0, p.annotCanvas.width, p.annotCanvas.height);
    });
    this._history = ['[]'];
    this._histIdx = 0;
  }

  redrawAll() {
    this.pages.forEach((p, idx) => this._redrawPage(p, idx + 1));
  }

  undo() {
    if (this._histIdx <= 0) return;
    this._histIdx--;
    this._clearSelection(false);
    const data = JSON.parse(this._history[this._histIdx]);
    this.annotations.splice(0, this.annotations.length, ...data);
    this.redrawAll();
  }

  redo() {
    if (this._histIdx >= this._history.length - 1) return;
    this._histIdx++;
    this._clearSelection(false);
    const data = JSON.parse(this._history[this._histIdx]);
    this.annotations.splice(0, this.annotations.length, ...data);
    this.redrawAll();
  }

  // ── Private: event wiring ──────────────────────────────────

  _attachAll() {
    this.pages.forEach((p, idx) => this._attachPage(p, idx + 1));

    // Document-level mouseup for highlight (text selection) and drag end
    this._docMouseupHighlight = (e) => {
      // Freehand highlight commit
      if (this._freehighlight) {
        const fh = this._freehighlight;
        this._freehighlight = null;
        if (fh.points.length > 3) {
          this.annotations.push({
            type:      'freeHighlight',
            pageNum:   fh.pageNum,
            points:    fh.points,
            color:     this.color,
            thickness: 20,
          });
          this._pushHistory();
        }
        return;
      }

      // Text-selection highlight commit
      if (this.tool !== 'highlight') return;
      const wrapper = (e.target as Element)?.closest?.('.page-wrapper');
      if (!wrapper) return;
      const pageNum = Number((wrapper as HTMLElement).dataset.page);
      if (!pageNum) return;
      const p = this.pages[pageNum - 1];
      if (p) this._captureHighlight(p, pageNum);
    };
    document.addEventListener('mouseup', this._docMouseupHighlight);

    // Document-level mousemove / mouseup for annotation dragging (select tool)
    this._docMousemoveDrag = (e) => {
      if (!this._dragStart || this._selectedIdx === null) return;
      const rect = this._dragPageRect!;
      const totalDx = (e.clientX - this._dragStart.x) / rect.width;
      const totalDy = (e.clientY - this._dragStart.y) / rect.height;
      // Restore original then apply accumulated delta
      const restored = JSON.parse(JSON.stringify(this._dragOrigAnn));
      this._moveAnnotation(restored, totalDx, totalDy);
      this.annotations[this._selectedIdx] = restored;
      this.redrawAll();
    };
    document.addEventListener('mousemove', this._docMousemoveDrag);

    this._docMouseupDrag = (e) => {
      if (!this._dragStart) return;
      const moved = Math.hypot(e.clientX - this._dragStart.x, e.clientY - this._dragStart.y) > 3;
      this._dragStart    = null;
      this._dragOrigAnn  = null;
      this._dragPageRect = null;
      if (moved) this._pushHistory();
    };
    document.addEventListener('mouseup', this._docMouseupDrag);

    // Escape clears selection
    this._docKeydown = (e) => {
      if (e.key === 'Escape' && this.tool === 'select') this._clearSelection();
    };
    document.addEventListener('keydown', this._docKeydown);
  }

  // Remove all document-level listeners. Call when the tab is closed.
  destroy() {
    document.removeEventListener('mouseup',   this._docMouseupHighlight);
    document.removeEventListener('mousemove', this._docMousemoveDrag);
    document.removeEventListener('mouseup',   this._docMouseupDrag);
    document.removeEventListener('keydown',   this._docKeydown);
  }

  _attachPage(p: PageData, pageNum: number) {
    const canvas     = p.annotCanvas;
    const wrapper    = p.wrapper;
    const shapeTools = ['line', 'rect', 'oval', 'arrow'];

    // ── Canvas events (draw / shape / eraser tools) ──────────

    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      if (this.tool === 'draw') {
        this._drawing = true;
        this._currentPath = { pageNum, points: [this._canvasPos(canvas, e)], color: this.color, thickness: this.thickness };
      } else if (shapeTools.includes(this.tool)) {
        this._shapeStart = { pageNum, pos: this._canvasPos(canvas, e), p };
      } else if (this.tool === 'eraser') {
        this._erasing   = true;
        this._erasedAny = false;
        const [cx, cy] = this._canvasPos(canvas, e);
        this._tryErase(pageNum, canvas, p, cx, cy);
      }
    };

    const onMove = (e: MouseEvent) => {
      if (this.tool === 'draw' && this._drawing) {
        // Ignore events from canvases other than the one the stroke started on.
        // Guards against fast mouse moves that skip the mouseleave event.
        if (this._currentPath?.pageNum !== pageNum) return;
        const pos = this._canvasPos(canvas, e);
        this._currentPath.points.push(pos);
        const ctx = canvas.getContext('2d')!;
        const pts = this._currentPath.points;
        if (pts.length < 2) return;
        ctx.save();
        ctx.strokeStyle = this._currentPath.color;
        ctx.lineWidth   = this._currentPath.thickness;
        ctx.lineCap     = 'round';
        ctx.lineJoin    = 'round';
        ctx.beginPath();
        ctx.moveTo(pts[pts.length - 2][0], pts[pts.length - 2][1]);
        ctx.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
        ctx.stroke();
        ctx.restore();

      } else if (this._shapeStart?.pageNum === pageNum && shapeTools.includes(this.tool)) {
        const [x2, y2] = this._constrainShape(this.tool, ...this._shapeStart.pos, ...this._canvasPos(canvas, e), e.shiftKey);
        this._redrawPage(p, pageNum);
        this._drawPreview(canvas, this._shapeStart.pos, [x2, y2]);

      } else if (this.tool === 'eraser' && this._erasing) {
        const [cx, cy] = this._canvasPos(canvas, e);
        this._tryErase(pageNum, canvas, p, cx, cy);
      }
    };

    const onUp = (e: MouseEvent) => {
      if (e.button !== 0) return;

      if (this.tool === 'draw' && this._drawing) {
        this._drawing = false;
        if (this._currentPath && this._currentPath.points.length > 1) {
          const w = canvas.width, h = canvas.height;
          this.annotations.push({
            type:      'draw',
            pageNum,
            points:    this._currentPath.points.map(([x, y]) => [x / w, y / h]),
            color:     this._currentPath.color,
            thickness: this._currentPath.thickness,
          });
          this._pushHistory();
        }
        this._currentPath = null;

      } else if (this._shapeStart?.pageNum === pageNum && shapeTools.includes(this.tool)) {
        const [x1, y1] = this._shapeStart.pos;
        const [x2, y2] = this._constrainShape(this.tool, x1, y1, ...this._canvasPos(canvas, e), e.shiftKey);
        this._shapeStart = null;
        if (Math.abs(x2 - x1) > 2 || Math.abs(y2 - y1) > 2) {
          const w = canvas.width, h = canvas.height;
          this.annotations.push({
            type: this.tool, pageNum,
            x1: x1 / w, y1: y1 / h,
            x2: x2 / w, y2: y2 / h,
            color:     this.color,
            thickness: this.thickness,
          });
          this._pushHistory();
        }
        this._redrawPage(p, pageNum);

      } else if (this.tool === 'text') {
        this._placeTextBox(p, pageNum, this._canvasPos(canvas, e));

      } else if (this.tool === 'eraser' && this._erasing) {
        this._erasing = false;
        if (this._erasedAny) this._pushHistory();
        this._erasedAny = false;
      }
    };

    canvas.addEventListener('mousedown',  onDown);
    canvas.addEventListener('mousemove',  onMove);
    canvas.addEventListener('mouseup',    onUp);

    // Commit and stop a freehand stroke the moment the cursor leaves the canvas.
    // This keeps each stroke confined to the page it started on; the user must
    // click again to begin a new stroke on another page.
    canvas.addEventListener('mouseleave', () => {
      if (this.tool !== 'draw' || !this._drawing) return;
      if (this._currentPath?.pageNum !== pageNum) return;
      this._drawing = false;
      if (this._currentPath && this._currentPath.points.length > 1) {
        const w = canvas.width, h = canvas.height;
        this.annotations.push({
          type:      'draw',
          pageNum,
          points:    this._currentPath.points.map(([x, y]) => [x / w, y / h]),
          color:     this._currentPath.color,
          thickness: this._currentPath.thickness,
        });
        this._pushHistory();
      }
      this._currentPath = null;
    });

    // ── Wrapper events (highlight + select tool) ─────────────

    // Freehand highlight: starts on mousedown on non-text areas
    const onWrapperDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      // Let form field inputs (checkboxes, text, select) handle their own events.
      if ((e.target as Element)?.closest('[data-field-name]')) return;

      if (this.tool === 'highlight') {
        if (!(e.target as Element)?.closest('.textLayer span')) {
          e.preventDefault(); // don't start text selection
          const rect = wrapper.getBoundingClientRect();
          const nx = (e.clientX - rect.left) / rect.width;
          const ny = (e.clientY - rect.top)  / rect.height;
          this._freehighlight = { pageNum, p, points: [[nx, ny]] };
        }
        return;
      }

      if (this.tool === 'select') {
        const rect = wrapper.getBoundingClientRect();
        const nx = (e.clientX - rect.left) / rect.width;
        const ny = (e.clientY - rect.top)  / rect.height;
        const idx = this._hitTest(pageNum, nx, ny);
        if (idx >= 0) {
          e.stopPropagation(); // prevent text selection from starting
          this._selectedIdx     = idx;
          this._selectedPageNum = pageNum;
          this._dragStart    = { x: e.clientX, y: e.clientY };
          this._dragOrigAnn  = JSON.parse(JSON.stringify(this.annotations[idx]));
          this._dragPageRect = rect;
          this.redrawAll();
        } else {
          this._clearSelection();
        }
      }
    };

    // Freehand highlight: draw stroke as mouse moves.
    // Redraw the whole page + full path each frame so round caps at segment
    // joints don't stack alpha (a single stroke never compounds with itself).
    const onWrapperMove = (e: MouseEvent) => {
      if (!this._freehighlight || this._freehighlight.pageNum !== pageNum) return;
      const rect = wrapper.getBoundingClientRect();
      const nx = (e.clientX - rect.left) / rect.width;
      const ny = (e.clientY - rect.top)  / rect.height;
      const fh = this._freehighlight;
      fh.points.push([nx, ny]);

      this._redrawPage(p, pageNum);
      const cvs = p.annotCanvas;
      const ctx = cvs.getContext('2d')!;
      const w = cvs.width, h = cvs.height;
      ctx.save();
      ctx.globalAlpha = 0.35;
      ctx.strokeStyle = this.color;
      ctx.lineWidth   = 20;
      ctx.lineCap     = 'round';
      ctx.lineJoin    = 'round';
      ctx.beginPath();
      fh.points.forEach(([px, py], i) => {
        if (i === 0) ctx.moveTo(px * w, py * h); else ctx.lineTo(px * w, py * h);
      });
      ctx.stroke();
      ctx.restore();
    };

    // Double-click on text annotation to edit it
    const onWrapperDblClick = (e: MouseEvent) => {
      if (this.tool !== 'select') return;
      const rect = wrapper.getBoundingClientRect();
      const nx = (e.clientX - rect.left) / rect.width;
      const ny = (e.clientY - rect.top)  / rect.height;
      const idx = this._hitTest(pageNum, nx, ny);
      if (idx >= 0 && this.annotations[idx].type === 'text') {
        this._editTextBox(p, pageNum, idx);
      }
    };

    wrapper.addEventListener('mousedown',  onWrapperDown,    { capture: true });
    wrapper.addEventListener('mousemove',  onWrapperMove);
    wrapper.addEventListener('dblclick',   onWrapperDblClick);

    this._handlers[pageNum] = { onDown, onMove, onUp, canvas };
  }

  // ── Highlight (text selection → annotation) ─────────────────

  _captureHighlight(p: PageData, pageNum: number) {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;

    const wrapper  = p.wrapper;
    const wrapRect = wrapper.getBoundingClientRect();

    const rects = [];
    for (let i = 0; i < sel.rangeCount; i++) {
      const range = sel.getRangeAt(i);
      for (const r of range.getClientRects()) {
        if (r.width < 1) continue;

        const el   = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        const span = el?.closest?.('.textLayer span');
        let textH  = r.height * 0.55;
        if (span) {
          const fs = parseFloat(window.getComputedStyle(span).fontSize);
          if (fs > 0) textH = Math.min(fs * 1.25, r.height * 0.9);
        }

        const trimV = (r.height - textH) / 2;
        rects.push({
          x:      (r.left - wrapRect.left) / wrapRect.width,
          y:      (r.top  - wrapRect.top  + trimV) / wrapRect.height,
          width:  r.width  / wrapRect.width,
          height: textH    / wrapRect.height,
        });
      }
    }
    sel.removeAllRanges();
    if (rects.length === 0) return;

    const annot = { type: 'highlight', pageNum, rects, color: this.color };
    this.annotations.push(annot);
    this._pushHistory();
    const ctx = p.annotCanvas.getContext('2d')!;
    this._drawAnnotation(ctx, annot, p.annotCanvas.width, p.annotCanvas.height);
  }

  // ── Text box placement ──────────────────────────────────────

  _placeTextBox(p: PageData, pageNum: number, [cx, cy]: number[]) {
    const canvas   = p.annotCanvas;
    const wrapper  = p.wrapper;
    const w = canvas.width, h = canvas.height;
    const fontSize = this.textFontSize;
    const scaleX   = wrapper.offsetWidth  / w;
    const scaleY   = wrapper.offsetHeight / h;
    const weight   = this.textBold      ? 'bold'      : 'normal';
    const decor    = this.textUnderline ? 'underline' : 'none';

    this._openTextarea(wrapper, cx * scaleX, cy * scaleY, '', {
      fontSize, weight, decor, color: this.color,
      onCommit: (text) => {
        if (!text) return;
        const annot = {
          type: 'text', pageNum,
          x: cx / w, y: cy / h,
          text,
          color:     this.color,
          fontSize,
          bold:      this.textBold,
          underline: this.textUnderline,
        };
        this.annotations.push(annot);
        this._pushHistory();
        const ctx = canvas.getContext('2d')!;
        this._drawAnnotation(ctx, annot, w, h);
      },
    });
  }

  _editTextBox(p: PageData, pageNum: number, idx: number) {
    const ann    = this.annotations[idx];
    const canvas = p.annotCanvas;
    const wrapper = p.wrapper;
    const w = canvas.width, h = canvas.height;
    const scaleX = wrapper.offsetWidth  / w;
    const scaleY = wrapper.offsetHeight / h;

    // Temporarily remove annotation so the canvas area is clear
    this.annotations.splice(idx, 1);
    this._selectedIdx = null;
    this._redrawPage(p, pageNum);

    const weight = ann.bold      ? 'bold'      : 'normal';
    const decor  = ann.underline ? 'underline' : 'none';

    this._openTextarea(wrapper, ann.x * w * scaleX, ann.y * h * scaleY, ann.text, {
      fontSize: ann.fontSize, weight, decor, color: ann.color,
      onCommit: (text) => {
        const newAnn = { ...ann, text };
        if (text) {
          this.annotations.splice(idx, 0, newAnn);
          this._pushHistory();
          this._redrawPage(p, pageNum);
        }
      },
      onCancel: () => {
        // Restore original on Escape
        this.annotations.splice(idx, 0, ann);
        this._redrawPage(p, pageNum);
      },
    });
  }

  _openTextarea(wrapper: HTMLElement, left: number, top: number, initialText: string, { fontSize, weight, decor, color, onCommit, onCancel }: { fontSize: number; weight: string; decor: string; color: string; onCommit?: (text: string) => void; onCancel?: () => void }) {
    const ta = document.createElement('textarea');
    ta.value = initialText;
    ta.style.cssText = `
      position:        absolute;
      left:            ${left}px;
      top:             ${top}px;
      min-width:       120px;
      min-height:      ${fontSize + 6}px;
      background:      transparent;
      border:          1px dashed rgba(128,128,128,0.6);
      font:            ${weight} ${fontSize}px system-ui, sans-serif;
      color:           ${color};
      text-decoration: ${decor};
      line-height:     ${fontSize + 2}px;
      caret-color:     ${color};
      resize:          both;
      z-index:         10;
      outline:         none;
      padding:         2px 4px;
      overflow:        hidden;
    `;
    wrapper.appendChild(ta);
    ta.focus();
    // Move caret to end if editing existing text
    if (initialText) { ta.selectionStart = ta.selectionEnd = initialText.length; }

    let committed = false;
    const commit = () => {
      if (committed) return;
      committed = true;
      const text = ta.value.trim();
      ta.remove();
      onCommit?.(text);
    };
    const cancel = () => {
      if (committed) return;
      committed = true;
      ta.remove();
      onCancel?.();
    };

    ta.addEventListener('blur',    commit);
    ta.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    });
  }

  // ── Hit testing ─────────────────────────────────────────────

  _hitTest(pageNum: number, nx: number, ny: number) {
    for (let i = this.annotations.length - 1; i >= 0; i--) {
      const a = this.annotations[i];
      if (a.pageNum !== pageNum) continue;
      if (this._annotContains(a, nx, ny)) return i;
    }
    return -1;
  }

  _annotContains(a: Annotation, nx: number, ny: number) {
    const tol = 0.015;
    if (a.type === 'draw' || a.type === 'freeHighlight') {
      for (let i = 0; i < a.points.length - 1; i++) {
        if (this._distToSegment(nx, ny, a.points[i], a.points[i + 1]) < tol) return true;
      }
    } else if (a.type === 'highlight') {
      return a.rects.some(r =>
        nx >= r.x - tol && nx <= r.x + r.width  + tol &&
        ny >= r.y - tol && ny <= r.y + r.height + tol
      );
    } else if (a.type === 'text') {
      return Math.abs(nx - a.x) < 0.15 && Math.abs(ny - a.y) < 0.06;
    } else if (a.type === 'rect' || a.type === 'oval') {
      const x1 = Math.min(a.x1, a.x2), x2 = Math.max(a.x1, a.x2);
      const y1 = Math.min(a.y1, a.y2), y2 = Math.max(a.y1, a.y2);
      return nx >= x1 - tol && nx <= x2 + tol && ny >= y1 - tol && ny <= y2 + tol;
    } else if (a.type === 'line' || a.type === 'arrow') {
      return this._distToSegment(nx, ny, [a.x1, a.y1], [a.x2, a.y2]) < tol;
    }
    return false;
  }

  _distToSegment(px: number, py: number, [ax, ay]: number[], [bx, by]: number[]) {
    const dx = bx - ax, dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return Math.hypot(px - ax, py - ay);
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }

  // ── Eraser ──────────────────────────────────────────────────

  _tryErase(pageNum: number, canvas: HTMLCanvasElement, p: PageData, cx: number, cy: number) {
    const w = canvas.width, h = canvas.height;
    const idx = this._hitTest(pageNum, cx / w, cy / h);
    if (idx >= 0) {
      this.annotations.splice(idx, 1);
      this._erasedAny = true;
      this._redrawPage(p, pageNum);
    }
  }

  // ── Select / move ────────────────────────────────────────────

  _clearSelection(redraw = true) {
    const had = this._selectedIdx !== null;
    this._selectedIdx     = null;
    this._selectedPageNum = null;
    if (had && redraw) this.redrawAll();
  }

  _moveAnnotation(ann: Annotation, dx: number, dy: number) {
    if (ann.type === 'draw' || ann.type === 'freeHighlight') {
      ann.points = ann.points.map(([x, y]: [number, number]) => [x + dx, y + dy]);
    } else if (ann.type === 'highlight') {
      ann.rects = ann.rects.map(r => ({ ...r, x: r.x + dx, y: r.y + dy }));
    } else if (ann.type === 'text') {
      ann.x += dx; ann.y += dy;
    } else if (['rect', 'oval', 'line', 'arrow'].includes(ann.type)) {
      ann.x1 += dx; ann.y1 += dy;
      ann.x2 += dx; ann.y2 += dy;
    }
  }

  _getAnnotBounds(ann: Annotation, w: number, h: number) {
    if (ann.type === 'draw' || ann.type === 'freeHighlight') {
      const xs = ann.points.map(([nx]: [number, number]) => nx * w);
      const ys = ann.points.map(([, ny]: [number, number]) => ny * h);
      return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    } else if (ann.type === 'highlight') {
      const allX = ann.rects.flatMap(r => [r.x * w, (r.x + r.width) * w]);
      const allY = ann.rects.flatMap(r => [r.y * h, (r.y + r.height) * h]);
      return { x: Math.min(...allX), y: Math.min(...allY), w: Math.max(...allX) - Math.min(...allX), h: Math.max(...allY) - Math.min(...allY) };
    } else if (ann.type === 'text') {
      return { x: ann.x * w - 2, y: ann.y * h - ann.fontSize - 2, w: 120, h: ann.fontSize * 2 + 4 };
    } else if (['rect', 'oval', 'line', 'arrow'].includes(ann.type)) {
      const x1 = Math.min(ann.x1, ann.x2) * w, x2 = Math.max(ann.x1, ann.x2) * w;
      const y1 = Math.min(ann.y1, ann.y2) * h, y2 = Math.max(ann.y1, ann.y2) * h;
      return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
    }
    return null;
  }

  // ── Shape helpers ────────────────────────────────────────────

  _constrainShape(tool: string, x1: number, y1: number, x2: number, y2: number, shift: boolean): [number, number] {
    if (!shift) return [x2, y2];
    if (tool === 'rect' || tool === 'oval') {
      const dx = x2 - x1, dy = y2 - y1;
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      return [x1 + Math.sign(dx) * d, y1 + Math.sign(dy) * d];
    }
    if (tool === 'line' || tool === 'arrow') {
      const dx = x2 - x1, dy = y2 - y1;
      const len   = Math.sqrt(dx * dx + dy * dy);
      const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
      return [x1 + Math.cos(angle) * len, y1 + Math.sin(angle) * len];
    }
    return [x2, y2];
  }

  _drawPreview(canvas: HTMLCanvasElement, [x1, y1]: number[], [x2, y2]: number[]) {
    const ctx = canvas.getContext('2d')!;
    ctx.save();
    ctx.strokeStyle = this.color;
    ctx.lineWidth   = this.thickness;
    ctx.lineCap     = 'round';
    ctx.lineJoin    = 'round';
    ctx.setLineDash([4, 4]);
    this._drawShape(ctx, this.tool, x1, y1, x2, y2);
    ctx.setLineDash([]);
    ctx.restore();
  }

  _drawShape(ctx: CanvasRenderingContext2D, type: string, x1: number, y1: number, x2: number, y2: number) {
    if (type === 'line') {
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    } else if (type === 'rect') {
      ctx.beginPath();
      ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
    } else if (type === 'oval') {
      const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
      const rx = Math.max(Math.abs(x2 - x1) / 2, 1);
      const ry = Math.max(Math.abs(y2 - y1) / 2, 1);
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      ctx.stroke();
    } else if (type === 'arrow') {
      const headLen = Math.max(10, ctx.lineWidth * 4);
      const angle   = Math.atan2(y2 - y1, x2 - x1);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = ctx.strokeStyle;
      ctx.beginPath();
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - headLen * Math.cos(angle - Math.PI / 6), y2 - headLen * Math.sin(angle - Math.PI / 6));
      ctx.lineTo(x2 - headLen * Math.cos(angle + Math.PI / 6), y2 - headLen * Math.sin(angle + Math.PI / 6));
      ctx.closePath();
      ctx.fill();
    }
  }

  // ── Drawing ─────────────────────────────────────────────────

  _redrawPage(p: PageData, pageNum: number) {
    const ctx = p.annotCanvas.getContext('2d')!;
    const { width: w, height: h } = p.annotCanvas;
    ctx.clearRect(0, 0, w, h);
    this.annotations
      .filter(a => a.pageNum === pageNum)
      .forEach(a => this._drawAnnotation(ctx, a, w, h));

    // Draw selection indicator on top
    if (this._selectedIdx !== null && this._selectedPageNum === pageNum) {
      const sel = this.annotations[this._selectedIdx];
      if (sel) this._drawSelectionIndicator(ctx, sel, w, h);
    }
  }

  _drawSelectionIndicator(ctx: CanvasRenderingContext2D, ann: Annotation, w: number, h: number) {
    const b = this._getAnnotBounds(ann, w, h);
    if (!b) return;
    const pad = 5;
    ctx.save();
    ctx.strokeStyle = '#4488ff';
    ctx.lineWidth   = 2;
    ctx.setLineDash([5, 3]);
    ctx.strokeRect(b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2);
    ctx.setLineDash([]);
    ctx.restore();
  }

  _drawAnnotation(ctx: CanvasRenderingContext2D, annot: Annotation, w: number, h: number) {
    ctx.save();
    if (annot.type === 'draw') {
      ctx.strokeStyle = annot.color;
      ctx.lineWidth   = annot.thickness;
      ctx.lineCap     = 'round';
      ctx.lineJoin    = 'round';
      ctx.beginPath();
      annot.points.forEach(([nx, ny]: [number, number], i: number) => {
        const x = nx * w, y = ny * h;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();

    } else if (annot.type === 'freeHighlight') {
      ctx.globalAlpha = 0.35;
      ctx.strokeStyle = annot.color;
      ctx.lineWidth   = annot.thickness;
      ctx.lineCap     = 'round';
      ctx.lineJoin    = 'round';
      ctx.beginPath();
      annot.points.forEach(([nx, ny]: [number, number], i: number) => {
        const x = nx * w, y = ny * h;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();

    } else if (annot.type === 'highlight') {
      ctx.globalAlpha = 0.35;
      ctx.fillStyle   = annot.color;
      annot.rects.forEach(r => {
        ctx.fillRect(r.x * w, r.y * h, r.width * w, r.height * h);
      });

    } else if (annot.type === 'text') {
      const weight = annot.bold ? 'bold ' : '';
      ctx.fillStyle = annot.color;
      ctx.font      = `${weight}${annot.fontSize}px system-ui, sans-serif`;
      annot.text.split('\n').forEach((line: string, i: number) => {
        const x = annot.x * w;
        const y = annot.y * h + i * (annot.fontSize + 2) + annot.fontSize;
        ctx.fillText(line, x, y);
        if (annot.underline) {
          const metrics = ctx.measureText(line);
          ctx.fillRect(x, y + 2, metrics.width, Math.max(1, annot.fontSize / 12));
        }
      });

    } else if (['line', 'rect', 'oval', 'arrow'].includes(annot.type)) {
      ctx.strokeStyle = annot.color;
      ctx.lineWidth   = annot.thickness;
      ctx.lineCap     = 'round';
      ctx.lineJoin    = 'round';
      this._drawShape(ctx, annot.type, annot.x1 * w, annot.y1 * h, annot.x2 * w, annot.y2 * h);
    }
    ctx.restore();
  }

  _canvasPos(canvas: HTMLCanvasElement, e: MouseEvent): [number, number] {
    const rect   = canvas.getBoundingClientRect();
    const scaleX = canvas.width  / rect.width;
    const scaleY = canvas.height / rect.height;
    return [(e.clientX - rect.left) * scaleX, (e.clientY - rect.top) * scaleY];
  }

  _updateCursors() {
    const cursors = {
      select:    'default',
      draw:      'crosshair',
      highlight: 'text',
      text:      'text',
      line:      'crosshair',
      rect:      'crosshair',
      oval:      'crosshair',
      arrow:     'crosshair',
      eraser:    'cell',
    };
    this.pages.forEach(p => {
      p.annotCanvas.style.cursor = (cursors as Record<string, string>)[this.tool] || 'default';
      p.wrapper.style.cursor     = this.tool === 'select' ? 'default' : '';
    });
  }

  // ── Undo / redo history ──────────────────────────────────────

  _pushHistory() {
    this._history.splice(this._histIdx + 1);
    this._history.push(JSON.stringify([...this.annotations]));
    this._histIdx++;
  }
}
