// PDFox — shared renderer types
// SPDX-License-Identifier: GPL-3.0-or-later

import type { PDFViewer } from './viewer.js';
import type { Annotator } from './annotator.js';

// ── Tab ───────────────────────────────────────────────────────────

interface FindCacheEntry {
  items: { str: string; x: number; y: number; width: number; height: number }[];
}

export interface Tab {
  id: number;
  filePath: string | null;
  pdfBytes: Uint8Array;
  viewer: PDFViewer;
  annotator: Annotator | null;
  outline: any[] | null;       // pdfjs outline array — no public type available
  pane: HTMLDivElement;
  dirty: boolean;
  tabEl: HTMLElement | null;
  loadingEl: HTMLDivElement | null;
  sleeping: boolean;
  lastActive: number;

  // Transient fields — set during tab lifecycle, absent until first use
  _savedScrollTop?: number | null;
  _savedAnnotations?: any[] | null;
  _suggestedDir?: string | null;
  _suggestedName?: string | null;
  _savedBytes?: Uint8Array | null;
  _findCache?: Map<number, FindCacheEntry>;
}

// ── CloseContext ──────────────────────────────────────────────────

export type CloseContext =
  | { type: 'window' }
  | { type: 'tab'; tab: Tab }
  | null;

// ── Find / Match ──────────────────────────────────────────────────

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
