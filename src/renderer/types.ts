// Reamlet — shared renderer types
// SPDX-License-Identifier: GPL-3.0-or-later

import type { PDFViewer } from './viewer.js';
import type { Annotator } from './annotator.js';

/** PDF outline node — mirrors the shape returned by PDFDocumentProxy.getOutline(). */
export interface OutlineNode {
  title: string;
  bold: boolean;
  italic: boolean;
  dest: string | unknown[] | null;
  url: string | null;
  unsafeUrl: string | undefined;
  newWindow: boolean | undefined;
  count: number | undefined;
  items: OutlineNode[];
}

// ── Annotation shapes ─────────────────────────────────────────

export interface DrawAnnotation {
  type: 'draw' | 'freeHighlight';
  pageNum: number;
  points: [number, number][];
  color: string;
  thickness: number;
}

export interface HighlightAnnotation {
  type: 'highlight';
  pageNum: number;
  rects: { x: number; y: number; width: number; height: number }[];
  color: string;
}

export interface TextAnnotation {
  type: 'text';
  pageNum: number;
  x: number;
  y: number;
  color: string;
  fontSize: number;
  bold: boolean;
  underline: boolean;
  text: string;
}

export interface ShapeAnnotation {
  type: 'line' | 'arrow' | 'rect' | 'oval';
  pageNum: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  thickness: number;
}

export type Annotation = DrawAnnotation | HighlightAnnotation | TextAnnotation | ShapeAnnotation;

// ── Tab ───────────────────────────────────────────────────────

interface FindCacheEntry {
  items: { str: string; x: number; y: number; width: number; height: number }[];
}

export interface Tab {
  id: number;
  filePath: string | null;
  pdfBytes: Uint8Array;
  viewer: PDFViewer;
  annotator: Annotator | null;
  outline: OutlineNode[] | null;
  pane: HTMLDivElement;
  dirty: boolean;
  tabEl: HTMLElement | null;
  loadingEl: HTMLDivElement | null;
  sleeping: boolean;
  lastActive: number;

  // Transient fields — set during tab lifecycle, absent until first use
  _savedScrollTop?: number | null;
  _savedAnnotations?: Annotation[] | null;
  _suggestedDir?: string | null;
  _suggestedName?: string | null;
  _savedBytes?: Uint8Array | null;
  _findCache?: Map<number, FindCacheEntry>;
  _notBeenViewed?: boolean;
  _undoStack?: Array<{ pdfBytes: Uint8Array; annotations: string }>;
  _undoIdx?: number;
  _undoCleanIdx?: number | null;
}

// ── CloseContext ──────────────────────────────────────────────

export type CloseContext =
  | { type: 'window' }
  | { type: 'tab'; tab: Tab }
  | null;

// ── Find / Match ──────────────────────────────────────────────

export interface Match {
  tabId: number;
  pageNum: number;
  itemIdx: number;
  charStart: number;
  charEnd: number;
  x: number;
  y: number;
  w: number;
  h: number;
}
