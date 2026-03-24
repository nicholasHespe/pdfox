// Reamlet — renderer entry point
// SPDX-License-Identifier: GPL-3.0-or-later

import { PDFViewer }        from './viewer.js';
import { Annotator }        from './annotator.js';
import { embedAnnotations } from './saver.js';
// @ts-expect-error — pdf-lib is imported via direct path for Electron's file:// ESM loader
import * as _pdfLib       from '../../node_modules/pdf-lib/dist/pdf-lib.esm.js';
import type * as PDFLibNS from 'pdf-lib';
import type { OutlineNode } from './types.js';
const { PDFDocument } = _pdfLib as unknown as typeof PDFLibNS;
import { FindBar }          from './find.js';
import type { Tab, CloseContext } from './types.js';

// ── State ──────────────────────────────────────────────────────

const tabs: Tab[]      = [];
let   activeTab: Tab | null = null;
let   _paneScrollCleanup: (() => void) | null = null;

// Tab drag state (same-window reorder)
let _draggedTab: Tab | null = null;
let _dropHandled         = false;
// Timer ID for the "open new window" fallback in dragend; cancelled by cross-window IPC
let _newWindowTimer: ReturnType<typeof setTimeout> | null = null;
// Set true once we've called focusWindow() during an external drag-over to avoid repeat calls
let _dragOverFocused     = false;

// Recently closed tabs stack for Ctrl+Shift+T
const _closedTabStack: { filePath: string }[] = [];

// Zoom debounce state
let _zoomTimer: ReturnType<typeof setTimeout> | null = null; // setTimeout handle for deferred re-render
let _zoomTarget: number | null = null; // accumulated target scale while debounce is pending

// Custom scrollbar drag state
let _sbDragging        = false;
let _sbDragStartY      = 0;
let _sbDragStartScroll = 0;

// Native file drag state (drag-to-external-app)
let _nativeDrag: { filePath: string; x: number; y: number } | null = null; // { filePath, x, y } while tracking mousedown before threshold

// Context for the close-confirm modal: null | { type:'window' } | { type:'tab', tab }
let _closeContext: CloseContext = null;

// Window identity (obtained from main process at startup)
let myWindowId: number | null = null;

// ── DOM refs ───────────────────────────────────────────────────

const sidebar              = document.getElementById('sidebar')!;
const viewerScrollbar      = document.getElementById('viewer-scrollbar')!;
const viewerScrollbarThumb = document.getElementById('viewer-scrollbar-thumb')!;
const tabBar         = document.getElementById('tab-bar')!;
const toolsPanel     = document.getElementById('tools-panel')!;
const viewerHost     = document.getElementById('viewer-host')!;
const emptyState     = document.getElementById('empty-state')!;
const thicknessInput = document.getElementById('thickness') as HTMLInputElement;
const tocPanel       = document.getElementById('toc-panel')!;
const tocTree        = document.getElementById('toc-tree')!;
const contentArea    = document.getElementById('content-area')!;
const pageInput      = document.getElementById('page-input') as HTMLInputElement;
const pageTotal      = document.getElementById('page-total')!;
const btnBold        = document.getElementById('btn-bold')!;
const btnUnderline   = document.getElementById('btn-underline')!;
const fontSizeInput  = document.getElementById('font-size-input') as HTMLInputElement;
const colorBtn       = document.getElementById('color-btn')!;
const colorDot       = document.getElementById('color-dot')!;
const colorPanel     = document.getElementById('color-panel')!;
const titleFilename  = document.getElementById('title-filename')!;
const contextMenu    = document.getElementById('context-menu')!;
const ctxCut         = document.querySelector('[data-ctx="cut"]')   as HTMLButtonElement;
const ctxPaste       = document.querySelector('[data-ctx="paste"]') as HTMLButtonElement;

// ── Platform setup ─────────────────────────────────────────────

const isMac = window.api.platform === 'darwin';
if (isMac) {
  document.body.classList.add('platform-mac');
  // Replace "Ctrl+" with "⌘" in the File/View dropdown shortcut labels
  document.querySelectorAll('.titlebar-dropdown span').forEach(span => {
    span.textContent = (span.textContent ?? '').replace('Ctrl+', '⌘');
  });
}

// ── Find bar ───────────────────────────────────────────────────

const finder = new FindBar({
  getTabs:      () => tabs,
  getActiveTab: () => activeTab,
  switchTab,
});

// ── Custom window controls ──────────────────────────────────────

document.getElementById('btn-win-min')!.addEventListener('click',   () => window.api.minimizeWindow());
document.getElementById('btn-win-max')!.addEventListener('click',   () => window.api.toggleMaximize());
document.getElementById('btn-win-close')!.addEventListener('click', () => window.api.closeWindow());

function updateTitleBar(tab: Tab | null) {
  titleFilename.textContent = tab?.filePath ?? 'Reamlet';
}

// ── Window ID ──────────────────────────────────────────────────

window.api.getWindowId().then(id => { myWindowId = id; });

// ── Sidebar mode switch ────────────────────────────────────────

document.querySelectorAll('.sidebar-mode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.sidebar-mode-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const mode = (btn as HTMLElement).dataset.mode;
    tabBar.classList.toggle('active',     mode === 'tabs');
    toolsPanel.classList.toggle('active', mode === 'tools');
  });
});

// ── Custom scrollbar ───────────────────────────────────────────

// Update thumb size and position to match the active pane's scroll state.
function _syncScrollbar() {
  if (!activeTab) { viewerScrollbar.style.display = 'none'; return; }
  const pane = activeTab.pane;
  const scrollH = pane.scrollHeight;
  const clientH = pane.clientHeight;
  if (scrollH <= clientH) { viewerScrollbar.style.display = 'none'; return; }
  viewerScrollbar.style.display = 'block';
  const trackH  = viewerScrollbar.clientHeight;
  const thumbH  = Math.max(30, Math.round((clientH / scrollH) * trackH));
  const maxScroll   = scrollH - clientH;
  const maxThumbTop = trackH - thumbH;
  const thumbTop = Math.round((pane.scrollTop / maxScroll) * maxThumbTop);
  viewerScrollbarThumb.style.height = `${thumbH}px`;
  viewerScrollbarThumb.style.top    = `${thumbTop}px`;
}

// Move the scrollbar track so it sits just left of the toc-panel whenever it's visible.
const SCROLLBAR_GAP = 6; // px gap between scrollbar and toc panel / window edge
function _positionScrollbar() {
  const base = !tocPanel.classList.contains('hidden') ? tocPanel.offsetWidth : 0;
  viewerScrollbar.style.right = `${base + SCROLLBAR_GAP}px`;
  _syncScrollbar();
}

// Jump scroll on track click (not thumb)
viewerScrollbar.addEventListener('mousedown', (e) => {
  if (e.target === viewerScrollbarThumb || !activeTab) return;
  const rect  = viewerScrollbar.getBoundingClientRect();
  const ratio = (e.clientY - rect.top) / rect.height;
  activeTab.pane.scrollTop = ratio * (activeTab.pane.scrollHeight - activeTab.pane.clientHeight);
});

// Thumb drag start
viewerScrollbarThumb.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  _sbDragging        = true;
  _sbDragStartY      = e.clientY;
  _sbDragStartScroll = activeTab?.pane.scrollTop ?? 0;
  viewerScrollbarThumb.classList.add('dragging');
  document.body.style.userSelect = 'none';
});

// ── Colour picker ──────────────────────────────────────────────

colorBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  colorPanel.classList.toggle('hidden');
});

// Close colour panel when clicking anywhere else
document.addEventListener('click', () => colorPanel.classList.add('hidden'));
colorPanel.addEventListener('click', (e) => e.stopPropagation());

// ── Context menu ───────────────────────────────────────────────

function _hideContextMenu() {
  contextMenu.classList.add('hidden');
}

viewerHost.addEventListener('contextmenu', (e) => {
  if (!activeTab) return;
  e.preventDefault();

  // Show Cut only when a cuttable annotation is selected; Paste when clipboard has content
  const ann = activeTab.annotator;
  const selectedAnn = ann && ann._selectedIdx !== null ? ann.annotations[ann._selectedIdx] : null;
  const canCut = selectedAnn !== null && selectedAnn !== undefined &&
    Annotator._cuttableTypes.includes(selectedAnn.type);
  ctxCut.style.display   = canCut ? '' : 'none';
  ctxPaste.style.display = (ann && ann._clipboard) ? '' : 'none';

  contextMenu.classList.remove('hidden');
  const menuW = contextMenu.offsetWidth  || 140;
  const menuH = contextMenu.offsetHeight || 90;
  const left  = Math.min(e.clientX, window.innerWidth  - menuW - 4);
  const top   = Math.min(e.clientY, window.innerHeight - menuH - 4);
  contextMenu.style.left = `${Math.max(0, left)}px`;
  contextMenu.style.top  = `${Math.max(0, top)}px`;
});

document.addEventListener('mousedown', (e) => {
  if (!(e.target as Element)?.closest('#context-menu')) _hideContextMenu();
});

contextMenu.addEventListener('mousedown', (e) => {
  const btn = (e.target as Element)?.closest('[data-ctx]') as HTMLElement | null;
  if (!btn) return;
  e.preventDefault();
  _hideContextMenu();
  switch (btn.dataset.ctx) {
    case 'cut':   activeTab?.annotator?.cut();   break;
    case 'paste': activeTab?.annotator?.paste();  break;
    case 'copy':
      navigator.clipboard.writeText(window.getSelection()?.toString() ?? '');
      break;
    case 'highlight':
      if (activeTab?.annotator) activeTab.annotator.setTool('highlight');
      syncToolButtons('highlight');
      break;
    case 'find': {
      const sel = window.getSelection()?.toString().trim();
      if (sel) finder._input.value = sel;
      finder.open();
      break;
    }
  }
});

// ── Resize handles ─────────────────────────────────────────────

const sidebarResizeHandle = document.getElementById('sidebar-resize')!;
const tocResizeHandle     = document.getElementById('toc-resize')!;
const SIDEBAR_MIN = 120;
const TOC_MIN     = 120;

let _resizingSidebar = false;
let _resizingToc     = false;

sidebarResizeHandle.addEventListener('mousedown', (e) => {
  e.preventDefault();
  _resizingSidebar = true;
  sidebarResizeHandle.classList.add('resizing');
  document.body.style.cursor     = 'ew-resize';
  document.body.style.userSelect = 'none';
});

tocResizeHandle.addEventListener('mousedown', (e) => {
  e.preventDefault();
  _resizingToc = true;
  tocResizeHandle.classList.add('resizing');
  tocPanel.classList.add('resizing');
  document.body.style.cursor     = 'ew-resize';
  document.body.style.userSelect = 'none';
});

document.addEventListener('mousemove', (e) => {
  if (_resizingSidebar) {
    const w = Math.max(SIDEBAR_MIN, e.clientX);
    sidebar.style.width = w + 'px';
  }
  if (_resizingToc) {
    const w = Math.max(TOC_MIN, window.innerWidth - e.clientX);
    tocPanel.style.width = w + 'px';
  }
  if (_sbDragging && activeTab) {
    const pane       = activeTab.pane;
    const trackH     = viewerScrollbar.clientHeight;
    const thumbH     = viewerScrollbarThumb.offsetHeight;
    const maxTravel  = trackH - thumbH;
    if (maxTravel <= 0) return;
    const dy         = e.clientY - _sbDragStartY;
    const maxScroll  = pane.scrollHeight - pane.clientHeight;
    pane.scrollTop   = _sbDragStartScroll + (dy / maxTravel) * maxScroll;
  }
  if (_nativeDrag) {
    const dx = e.clientX - _nativeDrag.x;
    const dy = e.clientY - _nativeDrag.y;
    if (Math.sqrt(dx * dx + dy * dy) > 6) {
      const fp = _nativeDrag.filePath;
      _nativeDrag = null;
      window.api.startDrag(fp);
    }
  }
});

document.addEventListener('mouseup', () => {
  if (_resizingSidebar) {
    _resizingSidebar = false;
    sidebarResizeHandle.classList.remove('resizing');
    document.body.style.cursor     = '';
    document.body.style.userSelect = '';
  }
  if (_resizingToc) {
    _resizingToc = false;
    tocResizeHandle.classList.remove('resizing');
    tocPanel.classList.remove('resizing');
    document.body.style.cursor     = '';
    document.body.style.userSelect = '';
    _positionScrollbar();
  }
  _nativeDrag = null;
  if (_sbDragging) {
    _sbDragging = false;
    viewerScrollbarThumb.classList.remove('dragging');
    document.body.style.userSelect = '';
  }
});

// ── Tab management ─────────────────────────────────────────────

let _nextTabId = 1;

function createTab(filePath: string | null, pdfData: ArrayBuffer | Uint8Array): Tab {
  const id = _nextTabId++;

  const pane  = document.createElement('div');
  pane.className = 'viewer-pane';
  const pages = document.createElement('div');
  pages.className = 'pdf-pages';
  pane.appendChild(pages);

  // Loading overlay — visible until _loadTabContent() completes
  const loadingEl = document.createElement('div');
  loadingEl.className = 'loading-overlay';
  loadingEl.innerHTML = '<div class="spinner"></div>';
  pane.appendChild(loadingEl);

  viewerHost.appendChild(pane);

  const viewer   = new PDFViewer(pages);
  const pdfBytes = pdfData instanceof Uint8Array ? pdfData.slice() : new Uint8Array(pdfData);

  const state = { id, filePath, pdfBytes, viewer, annotator: null, outline: null, pane, dirty: false, tabEl: null, loadingEl, sleeping: false, lastActive: Date.now() };
  tabs.push(state);
  return state;
}

function renderTabBar() {
  tabBar.innerHTML = '';
  tabs.forEach(t => {
    const el = document.createElement('div');
    el.className = 'tab' + (t === activeTab ? ' active' : '') + (t.loadingEl || t.sleeping ? ' loading' : '');
    el.dataset.id = String(t.id);
    el.draggable  = true;

    const name = document.createElement('span');
    name.className = 'tab-name';
    const basename = t.filePath ? t.filePath.split(/[\\/]/).pop() : 'Untitled';
    name.textContent = (t.dirty ? '*' : '') + basename;
    name.title       = t.filePath || 'Untitled';

    const close = document.createElement('button');
    close.className = 'tab-close';
    close.textContent = '\u00d7';
    close.title = 'Close tab';
    close.addEventListener('click', (e) => { e.stopPropagation(); requestCloseTab(t); });

    // Native file drag handle — only for files that exist on disk
    if (t.filePath && /[\\/]/.test(t.filePath)) {
      const grip = document.createElement('span');
      grip.className = 'tab-drag-grip';
      grip.title     = t.dirty ? 'Drag file (save first for latest annotations)' : 'Drag file to another app';
      grip.innerHTML = '<svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor">' +
        '<circle cx="3" cy="2.5" r="1.2"/><circle cx="7" cy="2.5" r="1.2"/>' +
        '<circle cx="3" cy="7"   r="1.2"/><circle cx="7" cy="7"   r="1.2"/>' +
        '<circle cx="3" cy="11.5" r="1.2"/><circle cx="7" cy="11.5" r="1.2"/>' +
        '</svg>';
      if (t.dirty) grip.classList.add('dirty');
      grip.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        e.stopPropagation(); // don't trigger tab switch or HTML5 drag
        e.preventDefault();
        _nativeDrag = { filePath: t.filePath!, x: e.clientX, y: e.clientY };
      });
      el.append(grip, name, close);
    } else {
      el.append(name, close);
    }
    el.addEventListener('click', () => switchTab(t));
    t.tabEl = el;

    // ── Same-window drag-to-reorder ────────────────────────────
    el.addEventListener('dragstart', (e) => {
      _draggedTab  = t;
      _dropHandled = false;
      e.dataTransfer!.effectAllowed = 'move';
      e.dataTransfer!.setData('tab-id', String(t.id));
      // Cross-window identification
      e.dataTransfer!.setData('reamlet-tab-filepath',  t.filePath || '');
      e.dataTransfer!.setData('reamlet-tab-source-id', String(myWindowId || ''));
      e.dataTransfer!.setData('reamlet-tab-dirty',     t.dirty ? '1' : '0');
      setTimeout(() => el.style.opacity = '0.5', 0);
    });

    el.addEventListener('dragend', () => {
      el.style.opacity = '';
      const tab     = _draggedTab;
      const handled = _dropHandled;
      _draggedTab  = null;
      _dropHandled = false;

      if (!handled && tab && tab.filePath) {
        // Schedule "open in new window" but allow the cross-window IPC signal to cancel it.
        // The target window calls notifyTabTransferred after finishing its async file load,
        // which triggers onCloseTabByFilepath here and clears this timer.
        _newWindowTimer = setTimeout(async () => {
          _newWindowTimer = null;
          if (tabs.includes(tab) && tabs.length > 1) {
            closeTab(tab);
            await window.api.openNewWindow(tab.filePath!);
          }
        }, 500);
      }
    });

    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer!.dropEffect = 'move';
      el.classList.add('drag-over');
    });
    el.addEventListener('dragleave', () => el.classList.remove('drag-over'));

    el.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation(); // don't bubble to tabBar cross-window handler
      el.classList.remove('drag-over');
      _dropHandled = true;

      const srcId = Number(e.dataTransfer!.getData('tab-id'));
      if (!srcId) return; // cross-window drop without a tab-id — let it fall through
      const srcTab = tabs.find(t2 => t2.id === srcId);
      if (!srcTab || srcTab === t) return;
      const srcIdx = tabs.indexOf(srcTab);
      const dstIdx = tabs.indexOf(t);
      tabs.splice(srcIdx, 1);
      tabs.splice(dstIdx, 0, srcTab);
      renderTabBar();
    });

    tabBar.appendChild(el);
  });
}

// ── Cross-window drag: tab bar as drop target ──────────────────

// Bring this window to front as soon as an external tab drag enters anywhere in the window.
// dragenter fires on entry; _dragOverFocused guards against repeat calls.
document.addEventListener('dragenter', (e) => {
  if (e.dataTransfer!.types.includes('reamlet-tab-filepath') && !_dragOverFocused) {
    _dragOverFocused = true;
    window.api.focusWindow();
  }
});
// relatedTarget is null when the drag leaves the browser window entirely — reset the flag.
document.addEventListener('dragleave', (e) => {
  if (!e.relatedTarget) _dragOverFocused = false;
});

tabBar.addEventListener('dragover', (e) => {
  if (e.dataTransfer!.types.includes('reamlet-tab-filepath')) {
    e.preventDefault();
    e.dataTransfer!.dropEffect = 'move';
    tabBar.classList.add('drag-over-external');
  }
});
tabBar.addEventListener('dragleave', (e) => {
  if (!tabBar.contains(e.relatedTarget as Node | null)) {
    tabBar.classList.remove('drag-over-external');
  }
});
tabBar.addEventListener('drop', async (e) => {
  tabBar.classList.remove('drag-over-external');
  _dragOverFocused = false; // reset so the next drag to this window also focuses it
  const filepath = e.dataTransfer!.getData('reamlet-tab-filepath');
  const sourceId = Number(e.dataTransfer!.getData('reamlet-tab-source-id'));
  const isDirty  = e.dataTransfer!.getData('reamlet-tab-dirty') === '1';
  if (!filepath || sourceId === myWindowId) return; // same window handled by tab elements

  e.preventDefault();
  _dropHandled = true;

  if (isDirty) {
    const name = filepath.split(/[\\/]/).pop();
    const ok = confirm(`"${name}" has unsaved annotations.\nMoving it to this window will discard them. Continue?`);
    if (!ok) return;
  }

  const result = await window.api.openFileFromPath(filepath);
  if (!result) return;

  const tab = createTab(result.filePath, result.buffer);
  renderTabBar();
  switchTab(tab);

  // Notify source window immediately — before loading — so its _newWindowTimer
  // is cancelled well within the 500ms window, regardless of PDF load time.
  await window.api.notifyTabTransferred(sourceId, filepath);

  await _loadTabContent(tab);
});

// Close tab when another window accepted the drag
window.api.onCloseTabByFilepath((filepath) => {
  const tab = tabs.find(t => t.filePath === filepath);
  if (!tab) return;
  // Cancel the "open new window" fallback — the target window already accepted this tab.
  if (_newWindowTimer !== null) { clearTimeout(_newWindowTimer); _newWindowTimer = null; }
  closeTab(tab);
  if (tabs.length === 0) window.close();
});

// ── Switch / close tab ─────────────────────────────────────────

function switchTab(tab: Tab) {
  if (activeTab) activeTab.pane.classList.remove('active');
  activeTab = tab;
  tab.pane.classList.add('active');
  tab.lastActive = Date.now();
  emptyState.style.display = 'none';
  updateTitleBar(tab);
  renderTabBar();

  if (tab.sleeping) {
    _wakeTab(tab); // async; will update UI when done
    return;
  }

  if (tab.annotator) {
    thicknessInput.value = String(tab.annotator.thickness);
    fontSizeInput.value  = String(tab.annotator.textFontSize);
    syncToolButtons(tab.annotator.tool);
    syncTextFormatButtons(tab.annotator);
  }

  syncSwatches(tab.annotator?.color);
  renderToc(tab.outline);
  updatePageDisplay(tab);
  attachScrollListener(tab);
  _positionScrollbar();
  finder.onTabSwitch();
}

function closeTab(tab: Tab) {
  const idx = tabs.indexOf(tab);
  if (idx === -1) return;
  // Remember for Ctrl+Shift+T (only real absolute paths, not virtual names like 'Combined.pdf')
  if (tab.filePath && /[\\/]/.test(tab.filePath)) {
    _closedTabStack.push({ filePath: tab.filePath });
    if (_closedTabStack.length > 20) _closedTabStack.shift();
  }
  tab.annotator?.destroy();
  tab.viewer.sleep(); // release pdfDoc + IntersectionObserver
  if (_paneScrollCleanup) { _paneScrollCleanup(); _paneScrollCleanup = null; }
  tab.pane.remove();
  finder.invalidateTab(tab); // after pane.remove so find-layers are detached when pruned
  tabs.splice(idx, 1);
  if (activeTab === tab) {
    activeTab = null;
    const next = tabs[idx] || tabs[idx - 1];
    if (next) switchTab(next);
    else {
      emptyState.style.display = '';
      renderToc(null);
      updatePageDisplay(null);
      updateTitleBar(null);
    }
  }
  renderTabBar();
}

function markDirty(tab: Tab) {
  tab.dirty = true;
  renderTabBar();
}

function clearDirty(tab: Tab) {
  tab.dirty = false;
  renderTabBar();
}

// ── Close prompt helpers ────────────────────────────────────────

function showCloseModal(ctx: Exclude<CloseContext, null>, message: string) {
  _closeContext = ctx;
  document.getElementById('close-modal-msg')!.textContent = message;
  const discardBtn = document.getElementById('close-discard')!;
  const saveBtn    = document.getElementById('close-save')!;
  if (ctx.type === 'tab') {
    discardBtn.textContent = 'Discard';
    saveBtn.textContent    = ctx.tab.filePath ? 'Save' : 'Save As\u2026';
  } else {
    discardBtn.textContent = 'Discard All';
    saveBtn.textContent    = 'Save All';
  }
  document.getElementById('close-modal')!.classList.remove('hidden');
}

// Use instead of closeTab() for user-initiated closes so dirty tabs get a prompt.
function requestCloseTab(tab: Tab | null) {
  if (!tab) return;
  if (!tab.dirty) { closeTab(tab); return; }
  const name = tab.filePath?.split(/[\\/]/).pop() || 'Untitled';
  showCloseModal({ type: 'tab', tab }, `"${name}" has unsaved changes.`);
}

// ── Sleeping tabs ───────────────────────────────────────────────

const SLEEP_KEEP_RECENT = 3;           // always keep this many most-recent tabs awake
const SLEEP_AFTER_MS    = 2 * 60_000; // sleep tabs inactive longer than this

function _sleepTab(tab: Tab) {
  if (tab.sleeping || tab === activeTab || !tab.annotator) return;
  tab._savedScrollTop   = tab.pane.scrollTop;
  tab._savedAnnotations = tab.annotator.annotations.slice();
  tab.annotator.destroy();
  tab.annotator = null;
  tab.viewer.sleep();
  tab.sleeping  = true;
  renderTabBar();
}

async function _wakeTab(tab: Tab) {
  tab.sleeping = false;
  const loadingEl = document.createElement('div');
  loadingEl.className = 'loading-overlay';
  loadingEl.innerHTML = '<div class="spinner"></div>';
  tab.pane.appendChild(loadingEl);
  tab.loadingEl = loadingEl;
  renderTabBar();

  await tab.viewer.load(tab.pdfBytes);
  tab.annotator = new Annotator(tab.viewer.pages, tab.viewer);
  _patchAnnotatorForDirty(tab);
  if (tab._savedAnnotations?.length) {
    tab.annotator!.annotations = tab._savedAnnotations;
    tab.annotator!.redrawAll();
    tab._savedAnnotations = null;
  }
  tab.outline = await tab.viewer.getOutline();
  loadingEl.remove();
  tab.loadingEl = null;

  const savedScroll = tab._savedScrollTop || 0;
  tab._savedScrollTop = null;
  requestAnimationFrame(() => { tab.pane.scrollTop = savedScroll; });

  renderTabBar();
  if (activeTab === tab) {
    thicknessInput.value = String(tab.annotator!.thickness);
    fontSizeInput.value  = String(tab.annotator!.textFontSize);
    syncToolButtons(tab.annotator!.tool);
    syncTextFormatButtons(tab.annotator!);
    syncSwatches(tab.annotator!.color);
    renderToc(tab.outline);
    updatePageDisplay(tab);
    attachScrollListener(tab);
    _positionScrollbar();
    _syncScrollbar();
  }
}

function _sleepCheck() {
  const now    = Date.now();
  const sorted = [...tabs].sort((a, b) => (b.lastActive || 0) - (a.lastActive || 0));
  sorted.forEach((tab, i) => {
    if (tab.sleeping || tab === activeTab || !tab.annotator) return;
    const tooOld = (now - (tab.lastActive || 0)) > SLEEP_AFTER_MS;
    if (i >= SLEEP_KEEP_RECENT || tooOld) _sleepTab(tab);
  });
}

setInterval(_sleepCheck, 15_000);

// ── Tab content loader (async; shows spinner until done) ────────

async function _loadTabContent(tab: Tab) {
  try {
    await tab.viewer.load(tab.pdfBytes);
    tab.annotator = new Annotator(tab.viewer.pages, tab.viewer);
    tab._cleanAnnotationsJSON = '[]';
    _patchAnnotatorForDirty(tab);
    tab.outline = await tab.viewer.getOutline();
  } catch (err) {
    const name = tab.filePath ? tab.filePath.split(/[\\/]/).pop() : 'file';
    alert(`Could not open "${name}": ${(err as Error).message}`);
    closeTab(tab);
    return;
  }
  if (tab.loadingEl) { tab.loadingEl.remove(); tab.loadingEl = null; }
  tab.lastActive = Date.now(); // reset clock so freshly-loaded tabs don't immediately sleep
  renderTabBar();
  if (activeTab === tab) {
    syncToolButtons(tab.annotator!.tool);
    syncTextFormatButtons(tab.annotator!);
    syncSwatches(tab.annotator!.color);
    renderToc(tab.outline);
    updatePageDisplay(tab);
    _syncScrollbar();
  }
}

// ── Open / Save ────────────────────────────────────────────────

// Return an already-open tab for the given absolute file path, or null.
// Used to avoid opening duplicate tabs for the same file.
function _findOpenTab(filePath: string | null) {
  if (!filePath || !/[\\/]/.test(filePath)) return null;
  return tabs.find(t => t.filePath === filePath) ?? null;
}

async function openFile() {
  const results = await window.api.openFileDialog();
  if (!results || results.length === 0) return;

  // Partition results: files that are already open vs genuinely new ones.
  const newTabs    = [];
  let   lastExisting = null;
  for (const { filePath, buffer } of results) {
    const existing = _findOpenTab(filePath);
    if (existing) {
      lastExisting = existing;
      continue; // don't create a duplicate tab
    }
    newTabs.push(createTab(filePath, buffer));
  }

  if (newTabs.length === 0) {
    // Every selected file was already open — just switch to the last one.
    if (lastExisting) switchTab(lastExisting);
    return;
  }

  // Create all new tabs immediately so they appear in the sidebar straight away.
  renderTabBar();
  switchTab(newTabs[newTabs.length - 1]);

  // Load the active (last-selected) tab first, then the rest in order.
  const activeNew = newTabs[newTabs.length - 1];
  for (const tab of [activeNew, ...newTabs.slice(0, -1)]) {
    await _loadTabContent(tab);
  }
}

async function saveTab(tab: Tab | null) {
  if (!tab) return false;

  // Resolve annotation source: live annotator or cached annotations from a sleeping tab.
  let annotations, viewer;
  if (tab.annotator) {
    annotations = tab.annotator.annotations;
    viewer      = tab.viewer;
  } else if (tab.sleeping) {
    annotations = tab._savedAnnotations || [];
    viewer      = tab.viewer; // getPageSize() uses _pageSizeCache — works while sleeping
  } else {
    return false; // tab is still loading, not ready to save
  }

  const bytes = await embedAnnotations(tab.pdfBytes, annotations, viewer);

  // Real on-disk file: overwrite after confirmation.
  if (tab.filePath && /[\\/]/.test(tab.filePath)) {
    const res = await window.api.saveFile(tab.filePath, bytes.buffer as ArrayBuffer);
    if (res.ok) {
      tab.pdfBytes     = bytes;
      tab._savedBytes  = null;
      tab.dirty        = false;
      tab._cleanAnnotationsJSON = JSON.stringify([...annotations]);
      renderTabBar();
      return true;
    } else if (res.error && res.error !== 'cancelled') {
      alert('Save failed: ' + res.error);
    }
    return false;
  }

  // Virtual tab (Combined.pdf, etc.): open Save As dialog with suggested default path.
  const defaultPath = (tab._suggestedDir && tab._suggestedName)
    ? tab._suggestedDir + '/' + tab._suggestedName
    : undefined;
  const res = await window.api.saveFileCopy(bytes.buffer as ArrayBuffer, defaultPath);
  if (res.ok) {
    tab.filePath       = res.filePath ?? null;
    tab._suggestedDir  = null;
    tab._suggestedName = null;
    tab.pdfBytes       = bytes;
    tab._savedBytes    = null;
    tab.dirty          = false;
    tab._cleanAnnotationsJSON = JSON.stringify([...annotations]);
    renderTabBar();
    updateTitleBar(tab);
    return true;
  }
  return false;
}

async function saveTabCopy(tab: Tab | null) {
  if (!tab) return false;

  let annotations, viewer;
  if (tab.annotator) {
    annotations = tab.annotator.annotations;
    viewer      = tab.viewer;
  } else if (tab.sleeping) {
    annotations = tab._savedAnnotations || [];
    viewer      = tab.viewer;
  } else {
    return false;
  }

  const bytes       = await embedAnnotations(tab.pdfBytes, annotations, viewer);
  const defaultPath = (tab._suggestedDir && tab._suggestedName)
    ? tab._suggestedDir + '/' + tab._suggestedName
    : undefined;
  const res = await window.api.saveFileCopy(bytes.buffer as ArrayBuffer, defaultPath);
  if (res.ok) {
    tab.filePath       = res.filePath ?? null;
    tab._suggestedDir  = null;
    tab._suggestedName = null;
    tab.pdfBytes       = bytes;
    tab.dirty          = false;
    tab._cleanAnnotationsJSON = JSON.stringify([...annotations]);
    renderTabBar();
    updateTitleBar(tab);
    return true;
  }
  return false;
}

async function reopenLastTab() {
  if (_closedTabStack.length === 0) return;
  const { filePath } = _closedTabStack.pop()!;
  const existing = _findOpenTab(filePath);
  if (existing) { switchTab(existing); return; }
  const result = await window.api.openFileFromPath(filePath);
  if (!result) { alert(`Could not reopen "${filePath.split(/[\\/]/).pop()}": file not found.`); return; }
  const tab = createTab(result.filePath, result.buffer);
  renderTabBar();
  switchTab(tab);
  await _loadTabContent(tab);
}

function _patchAnnotatorForDirty(tab: Tab) {
  const orig  = tab.annotator!.annotations;
  const proxy = new Proxy(orig, {
    set(target, prop, value, receiver) {
      const result = Reflect.set(target, prop, value, receiver);
      if (typeof prop === 'string' && !isNaN(Number(prop))) {
        JSON.stringify(target) === (tab._cleanAnnotationsJSON ?? '[]') ? clearDirty(tab) : markDirty(tab);
      }
      return result;
    },
    deleteProperty(target, prop) {
      const result = Reflect.deleteProperty(target, prop);
      if (typeof prop === 'string' && !isNaN(Number(prop))) {
        JSON.stringify(target) === (tab._cleanAnnotationsJSON ?? '[]') ? clearDirty(tab) : markDirty(tab);
      }
      return result;
    },
  });
  tab.annotator!.annotations = proxy;
}

// ── Zoom ───────────────────────────────────────────────────────

// Immediately apply a CSS scale transform to the page container for visual
// feedback, then re-render at the true scale after a 250 ms debounce.
function zoom(delta: number) {
  if (!activeTab) return;
  const v        = activeTab.viewer;
  const newScale = Math.max(0.25, Math.min(5,
    Math.round(((_zoomTarget ?? v.scale) + delta) * 100) / 100));
  _zoomTarget = newScale;

  // Instant visual feedback via CSS transform (GPU-accelerated, zero render cost)
  const pagesEl = activeTab.pane.querySelector('.pdf-pages') as HTMLElement | null;
  if (pagesEl) {
    const ratio = newScale / v.scale;
    pagesEl.style.transformOrigin = 'top center';
    pagesEl.style.transform       = `scale(${ratio})`;
  }

  // Debounce: wait until the user stops zooming, then do the real re-render
  clearTimeout(_zoomTimer ?? undefined);
  _zoomTimer = setTimeout(async () => {
    const scale = _zoomTarget!;
    _zoomTimer  = null;
    _zoomTarget = null;
    await _applyZoomNow(scale);
  }, 250);
}

// Cancel any pending debounce, remove the CSS transform, and synchronously
// run the full re-render at the given scale. Used by fitWidth/fitHeight/Ctrl+R.
async function _applyZoomNow(scale: number) {
  if (!activeTab) return;
  clearTimeout(_zoomTimer ?? undefined);
  _zoomTimer  = null;
  _zoomTarget = null;

  const pagesEl = activeTab.pane.querySelector('.pdf-pages') as HTMLElement | null;
  if (pagesEl) pagesEl.style.transform = '';

  const v = activeTab.viewer;
  await v.setZoom(scale);
  activeTab.annotator!.pages = v.pages;
  activeTab.annotator!.redrawAll();
  _syncScrollbar();
  finder.onZoom();
}

async function fitWidth() {
  if (!activeTab) return;
  const v  = activeTab.viewer;
  const vp = await v.getViewport(1);
  const tocW       = tocPanel.classList.contains('hidden') ? 0 : tocPanel.offsetWidth;
  const sbRight    = tocW + SCROLLBAR_GAP + 10; // scrollbar sits left of toc (10px wide) with gap
  const availableW = activeTab.pane.clientWidth - 2 * Math.max(sidebar.offsetWidth, sbRight);
  await _applyZoomNow(Math.round(((availableW - 32) / (vp.width / v.scale)) * 100) / 100);
}

async function fitHeight() {
  if (!activeTab) return;
  const v  = activeTab.viewer;
  const vp = await v.getViewport(v.getVisiblePageNum());
  await _applyZoomNow(Math.round(((activeTab.pane.clientHeight - 32) / (vp.height / v.scale)) * 100) / 100);
}

// ── Rotate ─────────────────────────────────────────────────────

async function rotate(singlePage: boolean) {
  if (!activeTab) return;
  const v = activeTab.viewer;
  if (singlePage) await v.rotatePage(v.getVisiblePageNum(), 90);
  else            await v.rotateAll(90);
  activeTab.annotator!.pages = v.pages;
  activeTab.annotator!.redrawAll();
  markDirty(activeTab);
}

// ── Page navigation ─────────────────────────────────────────────

function updatePageDisplay(tab: Tab | null) {
  if (!tab?.viewer) {
    pageInput.value       = '1';
    pageTotal.textContent = '/ 1';
    return;
  }
  pageInput.max         = String(tab.viewer.pageCount);
  pageInput.value       = String(tab.viewer.getVisiblePageNum());
  pageTotal.textContent = `/ ${tab.viewer.pageCount}`;
}

function attachScrollListener(tab: Tab) {
  if (_paneScrollCleanup) _paneScrollCleanup();
  const handler = () => { updatePageDisplay(tab); _syncScrollbar(); };
  tab.pane.addEventListener('scroll', handler, { passive: true });
  _paneScrollCleanup = () => tab.pane.removeEventListener('scroll', handler);
}

function jumpToPage(pageNum: number) {
  if (!activeTab) return;
  const n = Math.max(1, Math.min(activeTab.viewer.pageCount, pageNum));
  activeTab.viewer.scrollToPage(n);
  pageInput.value = String(n);
}

// ── Table of Contents ──────────────────────────────────────────

function renderToc(outline: OutlineNode[] | null) {
  tocTree.innerHTML = '';
  if (!outline || outline.length === 0) {
    tocPanel.classList.add('hidden');
    contentArea.classList.remove('toc-open');
    _positionScrollbar();
    return;
  }
  tocPanel.classList.remove('hidden');
  contentArea.classList.add('toc-open');
  _buildTocNodes(outline, tocTree);
  _positionScrollbar();
}

function _buildTocNodes(items: OutlineNode[], container: HTMLElement) {
  for (const item of items) {
    const hasChildren = item.items && item.items.length > 0;
    const node = document.createElement('div');

    let childrenEl = null;
    if (hasChildren) {
      childrenEl = document.createElement('div');
      childrenEl.className = 'toc-children';
      childrenEl.hidden    = true;
      _buildTocNodes(item.items, childrenEl);
    }

    const label = document.createElement('div');
    label.className = 'toc-item';

    const chevron = document.createElement('span');
    chevron.className   = 'toc-chevron';
    chevron.textContent = hasChildren ? '\u25B6' : '\u00a0';
    if (hasChildren) {
      chevron.addEventListener('click', (e) => {
        e.stopPropagation();
        childrenEl!.hidden  = !childrenEl!.hidden;
        chevron.textContent = childrenEl!.hidden ? '\u25B6' : '\u25BC';
      });
    }

    const span = document.createElement('span');
    span.className   = 'toc-item-label';
    span.textContent = item.title || '(untitled)';

    label.append(chevron, span);
    label.addEventListener('click', () => _navigateToOutlineItem(item));
    node.appendChild(label);
    if (childrenEl) node.appendChild(childrenEl);
    container.appendChild(node);
  }
}

async function _navigateToOutlineItem(item: OutlineNode) {
  if (!activeTab) return;
  const dest    = item.dest ?? item.url;
  if (!dest) return;
  const pageNum = await activeTab.viewer.resolveOutlineDest(dest);
  if (pageNum) {
    activeTab.viewer.scrollToPage(pageNum);
    pageInput.value = String(pageNum);
  }
}

// ── Toolbar sync helpers ───────────────────────────────────────

function syncToolButtons(tool: string) {
  document.querySelectorAll('.tool-btn').forEach(btn => {
    btn.classList.toggle('active', (btn as HTMLElement).dataset.tool === tool);
  });
}

function syncTextFormatButtons(annotator: Annotator) {
  btnBold.classList.toggle('active',      annotator?.textBold      ?? false);
  btnUnderline.classList.toggle('active', annotator?.textUnderline ?? false);
}

function syncSwatches(color: string | undefined) {
  if (!color) return;
  document.querySelectorAll('.swatch').forEach(s => {
    s.classList.toggle('active', (s as HTMLElement).dataset.color === color);
  });
  colorDot.style.background = color;
}

// ── Toolbar event wiring ───────────────────────────────────────

document.querySelectorAll('.tool-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const tool = (btn as HTMLElement).dataset.tool ?? '';
    if (activeTab?.annotator) activeTab.annotator.setTool(tool);
    syncToolButtons(tool);
  });
});

document.querySelectorAll('.swatch').forEach(s => {
  s.addEventListener('click', () => {
    const color = (s as HTMLElement).dataset.color ?? '';
    if (activeTab?.annotator) activeTab.annotator.setColor(color);
    syncSwatches(color);
    colorPanel.classList.add('hidden');
  });
});

document.getElementById('btn-undo')!.addEventListener('click',   () => activeTab?.annotator?.undo());
document.getElementById('btn-redo')!.addEventListener('click',   () => activeTab?.annotator?.redo());
document.getElementById('btn-fit')!.addEventListener('click',    fitWidth);
document.getElementById('btn-fit-h')!.addEventListener('click',  fitHeight);
document.getElementById('btn-rotate')!.addEventListener('click', (e) => rotate(e.shiftKey));
document.getElementById('btn-print')!.addEventListener('click',  () => window.print());

btnBold.addEventListener('click', () => {
  if (!activeTab?.annotator) return;
  const next = !activeTab.annotator.textBold;
  activeTab.annotator.setTextBold(next);
  btnBold.classList.toggle('active', next);
});

btnUnderline.addEventListener('click', () => {
  if (!activeTab?.annotator) return;
  const next = !activeTab.annotator.textUnderline;
  activeTab.annotator.setTextUnderline(next);
  btnUnderline.classList.toggle('active', next);
});

fontSizeInput.addEventListener('change', () => {
  if (activeTab?.annotator) activeTab.annotator.setTextFontSize(Number(fontSizeInput.value));
});

thicknessInput.addEventListener('input', () => {
  if (activeTab?.annotator) activeTab.annotator.setThickness(Number(thicknessInput.value));
});

document.getElementById('btn-prev-page')!.addEventListener('click', () => {
  if (activeTab) jumpToPage(activeTab.viewer.getVisiblePageNum() - 1);
});
document.getElementById('btn-next-page')!.addEventListener('click', () => {
  if (activeTab) jumpToPage(activeTab.viewer.getVisiblePageNum() + 1);
});
pageInput.addEventListener('change', () => jumpToPage(Number(pageInput.value)));

// ── Ctrl+scroll zoom ───────────────────────────────────────────

viewerHost.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  zoom(e.deltaY < 0 ? 0.1 : -0.1);
}, { passive: false });

// ── Keyboard shortcuts ─────────────────────────────────────────

document.addEventListener('keydown', async (e) => {
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && e.key === 'o') { e.preventDefault(); openFile(); return; }
  if (ctrl && e.shiftKey && e.key === 'S') { e.preventDefault(); saveTabCopy(activeTab); return; }
  if (ctrl && e.key === 's') { e.preventDefault(); saveTab(activeTab); return; }
  if (ctrl && e.key === 'w') { e.preventDefault(); requestCloseTab(activeTab); return; }
  if (ctrl && e.shiftKey && e.key === 'T') { e.preventDefault(); reopenLastTab(); return; }
  if (ctrl && (e.key === '=' || e.key === '+')) { e.preventDefault(); zoom(0.1); return; }
  if (ctrl && e.key === '-') { e.preventDefault(); zoom(-0.1); return; }
  if (ctrl && e.key === '0') { e.preventDefault(); fitWidth(); return; }
  if (ctrl && e.key === 'z') { e.preventDefault(); activeTab?.annotator?.undo(); return; }
  if (ctrl && (e.key === 'y' || (e.shiftKey && e.key === 'Z'))) { e.preventDefault(); activeTab?.annotator?.redo(); return; }
  if (ctrl && e.key === 'x') { e.preventDefault(); activeTab?.annotator?.cut(); return; }
  if (ctrl && e.key === 'v') { e.preventDefault(); activeTab?.annotator?.paste(); return; }
  if (ctrl && e.key === 'c') {
    const ann = activeTab?.annotator;
    if (ann && ann._selectedIdx !== null && Annotator._cuttableTypes.includes(ann.annotations[ann._selectedIdx]?.type)) {
      e.preventDefault(); ann.copy(); return;
    }
  }
  if (ctrl && e.key === 'p') { e.preventDefault(); window.print(); return; }
  if (ctrl && e.key === 'r') { e.preventDefault(); if (activeTab) _applyZoomNow(activeTab.viewer.scale); return; }
  if (ctrl && e.key === 'f') { e.preventDefault(); finder.open(); return; }

  if (e.key === 'Escape' && finder.isOpen()) { e.preventDefault(); finder.close(); return; }

  if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') return;

  if (e.key === 'Delete') { activeTab?.annotator?.deleteSelected(); return; }

  const toolMap = {
    d: 'draw', h: 'highlight', t: 'text', Escape: 'select',
    l: 'line', r: 'rect', o: 'oval', a: 'arrow', e: 'eraser',
  };
  const tool = (toolMap as Record<string, string>)[e.key];
  if (tool) {
    if (activeTab?.annotator) activeTab.annotator.setTool(tool);
    syncToolButtons(tool);
  }
});

// ── Custom title bar menus ─────────────────────────────────────

const _menuActions = {
  'open':        () => openFile(),
  'save':        () => saveTab(activeTab),
  'save-copy':   () => saveTabCopy(activeTab),
  'close-tab':   () => { if (activeTab) requestCloseTab(activeTab); },
  'reopen-tab':  () => reopenLastTab(),
  'quit':        () => window.close(),
  'zoom-50':     () => window.api.setUiZoom(0.5),
  'zoom-75':     () => window.api.setUiZoom(0.75),
  'zoom-100':    () => window.api.setUiZoom(1.0),
  'zoom-125':    () => window.api.setUiZoom(1.25),
  'zoom-150':    () => window.api.setUiZoom(1.5),
  'extension-id': () => _openExtensionIdModal(),
  'zoom-200':    () => window.api.setUiZoom(2.0),
  'fit-width':   () => fitWidth(),
  'fit-height':  () => fitHeight(),
  'devtools':    () => window.api.openDevTools(),
  'app-reload':  () => location.reload(),
};

function _closeAllDropdowns() {
  document.querySelectorAll('.titlebar-dropdown').forEach(d => d.classList.add('hidden'));
  document.querySelectorAll('.titlebar-menu-btn').forEach(b => b.classList.remove('open'));
}

// Toggle dropdown on menu button click
document.querySelectorAll('.titlebar-menu').forEach(menu => {
  const btn      = menu.querySelector('.titlebar-menu-btn')!;
  const dropdown = menu.querySelector('.titlebar-dropdown')!;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = !dropdown.classList.contains('hidden');
    _closeAllDropdowns();
    if (!isOpen) { dropdown.classList.remove('hidden'); btn.classList.add('open'); }
  });
});

// Close when clicking outside any menu
document.addEventListener('mousedown', (e) => {
  if (!(e.target as Element)?.closest('.titlebar-menu')) _closeAllDropdowns();
});

// Use mousedown on dropdowns so the action fires before any close-on-click logic
document.querySelectorAll('.titlebar-dropdown').forEach(dropdown => {
  dropdown.addEventListener('mousedown', (e) => {
    const btn = (e.target as Element)?.closest('[data-menu]') as HTMLElement | null;
    if (!btn) return;
    e.stopPropagation();
    _closeAllDropdowns();
    (_menuActions as Record<string, (() => void) | undefined>)[btn.dataset.menu ?? '']?.();
  });
});

// ── Menu events from main process (keyboard accelerators) ──────

window.api.onMenuEvent((event) => {
  switch (event) {
    case 'menu-open':         openFile(); break;
    case 'menu-save':         saveTab(activeTab); break;
    case 'menu-save-copy':    saveTabCopy(activeTab); break;
    case 'menu-close-tab':    if (activeTab) requestCloseTab(activeTab); break;
    case 'menu-reopen-tab':   reopenLastTab(); break;
    case 'menu-extension-id': _openExtensionIdModal(); break;
  }
});

// ── Extension ID modal ─────────────────────────────────────────

async function _openExtensionIdModal() {
  const input  = document.getElementById('ext-id-input')  as HTMLInputElement;
  const modal  = document.getElementById('ext-id-modal')!;

  const result = await window.api.getExtensionId();
  input.value  = result.ok ? (result.id ?? '') : '';

  modal.classList.remove('hidden');
  input.focus();
  input.select();
}

document.getElementById('ext-id-cancel')!.addEventListener('click', () => {
  document.getElementById('ext-id-modal')!.classList.add('hidden');
});

document.getElementById('ext-id-save')!.addEventListener('click', async () => {
  const input = document.getElementById('ext-id-input') as HTMLInputElement;
  const id    = input.value.trim();
  if (!id) return;
  const result = await window.api.setExtensionId(id);
  if (result.ok) {
    document.getElementById('ext-id-modal')!.classList.add('hidden');
  } else {
    alert('Failed to save: ' + result.error);
  }
});

// Receive file data when this window was opened for a dragged-out tab
window.api.onOpenFileData(async ({ filePath, buffer }) => {
  const existing = _findOpenTab(filePath);
  if (existing) { switchTab(existing); return; }
  const tab = createTab(filePath, buffer);
  renderTabBar();
  switchTab(tab);
  await _loadTabContent(tab);
});

// ── Combine PDFs ───────────────────────────────────────────────

let _combineOrder: Tab[] = [];

document.getElementById('btn-combine')!.addEventListener('click', () => {
  if (tabs.length < 2) { alert('Open at least 2 PDF files to combine.'); return; }
  _openCombineModal();
});
document.getElementById('combine-cancel')!.addEventListener('click', () => {
  document.getElementById('combine-modal')!.classList.add('hidden');
});
document.getElementById('combine-ok')!.addEventListener('click', _executeCombine);

function _openCombineModal() {
  _combineOrder = [];
  const list = document.getElementById('combine-list')!;
  list.innerHTML = '';
  tabs.forEach((tab, i) => {
    const item  = document.createElement('div');
    item.className   = 'combine-item';
    item.dataset.tabIdx = String(i);
    const badge  = document.createElement('span');
    badge.className  = 'combine-order';
    const nameEl = document.createElement('span');
    nameEl.className = 'combine-name';
    nameEl.textContent = tab.filePath?.split(/[\\/]/).pop() ?? 'Untitled';
    item.append(badge, nameEl);
    item.addEventListener('click', () => {
      const pos = _combineOrder.indexOf(tab);
      if (pos >= 0) { _combineOrder.splice(pos, 1); item.classList.remove('selected'); }
      else          { _combineOrder.push(tab);        item.classList.add('selected'); }
      _refreshCombineBadges(list);
    });
    list.appendChild(item);
  });
  document.getElementById('combine-modal')!.classList.remove('hidden');
}

function _refreshCombineBadges(list: HTMLElement) {
  list.querySelectorAll('.combine-item').forEach((item) => {
    const tab   = tabs[Number((item as HTMLElement).dataset.tabIdx)];
    const badge = item.querySelector('.combine-order')!;
    const pos   = _combineOrder.indexOf(tab);
    badge.textContent = pos >= 0 ? String(pos + 1) : '';
  });
}

async function _executeCombine() {
  if (_combineOrder.length < 2) { alert('Select at least 2 documents.'); return; }
  document.getElementById('combine-modal')!.classList.add('hidden');

  // For each dirty tab, prompt the user before combining.
  // Track which bytes to use per tab (may be updated by save/save-as).
  const bytesForTab = new Map();
  for (const tab of _combineOrder) {
    if (tab.dirty) {
      const name    = tab.filePath ? tab.filePath.replace(/.*[\\/]/, '') : 'Untitled';
      const hasPath = tab.filePath && /[\\/]/.test(tab.filePath);
      const buttons = ['Discard changes', ...(hasPath ? ['Save'] : []), 'Save As\u2026', 'Cancel'];
      const choice  = await window.api.showMessageBox({
        type:      'question',
        title:     'Unsaved Changes',
        message:   `\u201c${name}\u201d has unsaved annotations.`,
        detail:    'Choose how to handle them before combining.',
        buttons,
        defaultId: 0,
        cancelId:  buttons.indexOf('Cancel'),
      });
      const action = buttons[choice];
      if (action === 'Cancel') return;
      if (action === 'Save') {
        if (!await saveTab(tab)) return; // user cancelled the Replace dialog
      } else if (action === 'Save As\u2026') {
        if (!await saveTabCopy(tab)) return; // user cancelled the Save As dialog
      }
      // 'Discard': proceed with tab.pdfBytes as-is
    }
    bytesForTab.set(tab, tab.pdfBytes);
  }

  // Build combined PDF from the resolved bytes.
  const resultDoc = await PDFDocument.create();
  for (const tab of _combineOrder) {
    const srcDoc = await PDFDocument.load(bytesForTab.get(tab), { ignoreEncryption: true });
    const copied = await resultDoc.copyPages(srcDoc, srcDoc.getPageIndices());
    copied.forEach(p => resultDoc.addPage(p));
  }
  const bytes = await resultDoc.save();

  // The combined tab inherits the first document's directory as its default save location.
  const firstPath = _combineOrder[0]?.filePath;
  const firstDir  = (firstPath && /[\\/]/.test(firstPath))
    ? firstPath.replace(/[\\/][^\\/]*$/, '')
    : null;

  const tab = createTab('Combined.pdf', bytes);
  tab._suggestedDir  = firstDir;
  tab._suggestedName = 'combined.pdf';
  renderTabBar();
  switchTab(tab);
  await _loadTabContent(tab);
  markDirty(tab);
}

// ── Reorder Pages ──────────────────────────────────────────────

document.getElementById('btn-reorder')!.addEventListener('click', _openReorderModal);
document.getElementById('reorder-cancel')!.addEventListener('click', () => {
  document.getElementById('reorder-modal')!.classList.add('hidden');
});
document.getElementById('reorder-ok')!.addEventListener('click', _executeReorder);

async function _openReorderModal() {
  if (!activeTab) return;
  const tab       = activeTab;
  const count     = tab.viewer.pageCount;
  const container = document.getElementById('reorder-pages')!;

  container.innerHTML = '<p style="color:#888;font-size:13px;padding:8px">Loading thumbnails…</p>';
  document.getElementById('reorder-modal')!.classList.remove('hidden');

  // Move thumb one position left (-1) or right (+1), refreshing page labels.
  function moveThumb(th: HTMLElement, dir: number) {
    const siblings = [...container.children];
    const idx = siblings.indexOf(th);
    if (dir === -1 && idx === 0) return;
    if (dir ===  1 && idx === siblings.length - 1) return;
    if (dir === -1) {
      container.insertBefore(th, siblings[idx - 1]);
    } else {
      siblings[idx + 1].insertAdjacentElement('afterend', th);
    }
    container.querySelectorAll('.reorder-page-num').forEach((s, i) => {
      s.textContent = `Page ${i + 1}`;
    });
    th.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function selectThumb(th: HTMLElement) {
    container.querySelectorAll('.reorder-thumb').forEach(t => t.classList.remove('selected'));
    th.classList.add('selected');
  }

  container.innerHTML = '';
  for (let i = 0; i < count; i++) {
    const dataUrl = await tab.viewer.renderThumbnail(i + 1);
    const thumb   = document.createElement('div');
    thumb.className    = 'reorder-thumb';
    thumb.draggable    = true;
    thumb.dataset.orig = String(i);

    const img = document.createElement('img');
    img.src   = dataUrl;
    img.alt   = `Page ${i + 1}`;

    const num = document.createElement('span');
    num.className   = 'reorder-page-num';
    num.textContent = `Page ${i + 1}`;

    const controls = document.createElement('div');
    controls.className = 'reorder-controls';
    const btnL = document.createElement('button');
    btnL.className = 'reorder-arrow';
    btnL.title     = 'Move left';
    btnL.innerHTML = '&#8592;';
    const btnR = document.createElement('button');
    btnR.className = 'reorder-arrow';
    btnR.title     = 'Move right';
    btnR.innerHTML = '&#8594;';
    controls.append(btnL, btnR);

    thumb.append(img, num, controls);

    // Click to select (arrows handled separately)
    thumb.addEventListener('click', (e) => {
      if ((e.target as Element)?.closest('.reorder-arrow')) return;
      selectThumb(thumb);
    });

    btnL.addEventListener('click', (e) => { e.stopPropagation(); selectThumb(thumb); moveThumb(thumb, -1); });
    btnR.addEventListener('click', (e) => { e.stopPropagation(); selectThumb(thumb); moveThumb(thumb,  1); });

    thumb.addEventListener('dragstart', (e) => {
      e.dataTransfer!.setData('reorder-orig', String(thumb.dataset.orig));
      e.dataTransfer!.effectAllowed = 'move';
      thumb.classList.add('dragging');
    });
    thumb.addEventListener('dragend',  () => thumb.classList.remove('dragging'));
    thumb.addEventListener('dragover', (e) => { e.preventDefault(); thumb.classList.add('drag-over-r'); });
    thumb.addEventListener('dragleave', () => thumb.classList.remove('drag-over-r'));
    thumb.addEventListener('drop', (e) => {
      e.preventDefault();
      thumb.classList.remove('drag-over-r');
      const srcOrig = e.dataTransfer!.getData('reorder-orig');
      const dstOrig = thumb.dataset.orig;
      if (srcOrig === dstOrig) return;

      const srcEl = container.querySelector(`[data-orig="${srcOrig}"]`);
      if (!srcEl) return;

      const children = [...container.children];
      const srcIdx   = children.indexOf(srcEl);
      const dstIdx   = children.indexOf(thumb);
      if (srcIdx < dstIdx) {
        thumb.insertAdjacentElement('afterend', srcEl);
      } else {
        thumb.insertAdjacentElement('beforebegin', srcEl);
      }

      container.querySelectorAll('.reorder-page-num').forEach((span, idx) => {
        span.textContent = `Page ${idx + 1}`;
      });
    });

    container.appendChild(thumb);
  }
}

async function _executeReorder() {
  if (!activeTab) return;
  document.getElementById('reorder-modal')!.classList.add('hidden');

  const container = document.getElementById('reorder-pages')!;
  const newOrder  = [...container.querySelectorAll('.reorder-thumb')].map(el => Number((el as HTMLElement).dataset.orig));
  if (newOrder.every((v, i) => v === i)) return; // unchanged

  const tab = activeTab;
  const srcDoc    = await PDFDocument.load(tab.pdfBytes, { ignoreEncryption: true });
  const resultDoc = await PDFDocument.create();
  const pages     = await resultDoc.copyPages(srcDoc, newOrder);
  pages.forEach(p => resultDoc.addPage(p));
  const bytes = await resultDoc.save();

  tab.pdfBytes = bytes;
  tab.annotator!.clear();
  // Re-add loading overlay for the re-render
  const reloadEl = document.createElement('div');
  reloadEl.className = 'loading-overlay';
  reloadEl.innerHTML = '<div class="spinner"></div>';
  tab.pane.appendChild(reloadEl);
  tab.loadingEl = reloadEl;
  finder.invalidateTab(tab);
  await _loadTabContent(tab);
  markDirty(tab);
}

// ── Before-close: unsaved-changes dialog ───────────────────────

window.api.onBeforeClose(async () => {
  const dirtyTabs = tabs.filter(t => t.dirty);
  if (dirtyTabs.length === 0) { await window.api.forceClose(); return; }
  const msg = dirtyTabs.length === 1
    ? `"${dirtyTabs[0].filePath?.split(/[\\/]/).pop() || 'Untitled'}" has unsaved changes.`
    : `${dirtyTabs.length} files have unsaved changes.`;
  showCloseModal({ type: 'window' }, msg);
});

document.getElementById('close-cancel')!.addEventListener('click', () => {
  document.getElementById('close-modal')!.classList.add('hidden');
  _closeContext = null;
});

document.getElementById('close-discard')!.addEventListener('click', async () => {
  document.getElementById('close-modal')!.classList.add('hidden');
  const ctx = _closeContext;
  _closeContext = null;
  if (ctx?.type === 'tab') closeTab(ctx.tab);
  else                     await window.api.forceClose();
});

document.getElementById('close-save')!.addEventListener('click', async () => {
  document.getElementById('close-modal')!.classList.add('hidden');
  const ctx = _closeContext;
  _closeContext = null;
  if (ctx?.type === 'tab') {
    const ok = await saveTab(ctx.tab); // handles real files, virtual tabs, and sleeping tabs
    if (ok) closeTab(ctx.tab);
  } else {
    for (const tab of tabs.filter(t => t.dirty)) {
      const ok = tab.filePath ? await saveTab(tab) : await saveTabCopy(tab);
      if (!ok) return; // user cancelled a dialog — abort close
    }
    await window.api.forceClose();
  }
});

// ── Init ───────────────────────────────────────────────────────

// Sync colour dot to initial active swatch (default: red)
const initSwatch = document.querySelector('.swatch[data-color="#ff3333"]');
if (initSwatch) { colorDot.style.background = (initSwatch as HTMLElement).dataset.color ?? ''; initSwatch.classList.add('active'); }

emptyState.style.display = '';
