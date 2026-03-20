// PDFox — renderer entry point
// Manages tabs, keyboard shortcuts, and wires together viewer + annotator + saver.
// SPDX-License-Identifier: GPL-3.0-or-later

import { PDFViewer }  from './viewer.js';
import { Annotator }  from './annotator.js';
import { embedAnnotations } from './saver.js';

// ── State ──────────────────────────────────────────────────────

const tabs      = [];
let   activeTab = null;
let   _paneScrollCleanup = null; // removes the scroll listener for the current pane

// ── DOM refs ───────────────────────────────────────────────────

const tabBar         = document.getElementById('tab-bar');
const viewerHost     = document.getElementById('viewer-host');
const emptyState     = document.getElementById('empty-state');
const thicknessInput = document.getElementById('thickness');
const tocPanel       = document.getElementById('toc-panel');
const tocToggle      = document.getElementById('toc-toggle');
const tocTree        = document.getElementById('toc-tree');
const pageInput      = document.getElementById('page-input');
const pageTotal      = document.getElementById('page-total');
const btnBold        = document.getElementById('btn-bold');
const btnUnderline   = document.getElementById('btn-underline');

// ── Tab management ─────────────────────────────────────────────

function createTab(filePath, pdfData) {
  const id = Date.now();

  const pane  = document.createElement('div');
  pane.className = 'viewer-pane';
  const pages = document.createElement('div');
  pages.className = 'pdf-pages';
  pane.appendChild(pages);
  viewerHost.appendChild(pane);

  const viewer   = new PDFViewer(pages);
  const pdfBytes = pdfData instanceof Uint8Array ? pdfData.slice() : new Uint8Array(pdfData);

  const state = {
    id, filePath, pdfBytes, viewer,
    annotator: null,
    outline:   null,
    pane,
    dirty: false,
    tabEl: null,
  };
  tabs.push(state);
  return state;
}

function renderTabBar() {
  tabBar.innerHTML = '';
  tabs.forEach(t => {
    const el = document.createElement('div');
    el.className = 'tab' + (t === activeTab ? ' active' : '');
    el.dataset.id = t.id;

    const name = document.createElement('span');
    name.className = 'tab-name';
    const basename = t.filePath ? t.filePath.split(/[\\/]/).pop() : 'Untitled';
    name.textContent = (t.dirty ? '*' : '') + basename;

    const close = document.createElement('button');
    close.className = 'tab-close';
    close.textContent = '\u00d7';
    close.title = 'Close tab';
    close.addEventListener('click', (e) => { e.stopPropagation(); closeTab(t); });

    el.append(name, close);
    el.addEventListener('click', () => switchTab(t));
    tabBar.appendChild(el);
    t.tabEl = el;
  });
}

function switchTab(tab) {
  if (activeTab) activeTab.pane.classList.remove('active');
  activeTab = tab;
  tab.pane.classList.add('active');
  emptyState.style.display = 'none';
  renderTabBar();

  if (tab.annotator) {
    thicknessInput.value = tab.annotator.thickness;
    syncToolButtons(tab.annotator.tool);
    syncTextFormatButtons(tab.annotator);
  }

  // Update color swatch selection to match current annotator color
  syncSwatches(tab.annotator?.color);
  renderToc(tab.outline);
  updatePageDisplay(tab);
  attachScrollListener(tab);
}

function closeTab(tab) {
  const idx = tabs.indexOf(tab);
  if (idx === -1) return;
  if (_paneScrollCleanup) { _paneScrollCleanup(); _paneScrollCleanup = null; }
  tab.pane.remove();
  tabs.splice(idx, 1);
  if (activeTab === tab) {
    activeTab = null;
    const next = tabs[idx] || tabs[idx - 1];
    if (next) switchTab(next);
    else {
      emptyState.style.display = '';
      renderToc(null);
      updatePageDisplay(null);
    }
  }
  renderTabBar();
}

function markDirty(tab) {
  tab.dirty = true;
  renderTabBar();
}

// ── Open / Save ────────────────────────────────────────────────

async function openFile() {
  const result = await window.api.openFileDialog();
  if (!result) return;
  const { filePath, buffer } = result;

  const tab = createTab(filePath, buffer);
  await tab.viewer.load(tab.pdfBytes);
  tab.annotator = new Annotator(tab.viewer.pages);
  _patchAnnotatorForDirty(tab);
  tab.outline = await tab.viewer.getOutline();

  switchTab(tab);
  renderTabBar();
}

async function saveTab(tab) {
  if (!tab) return;
  const bytes = await embedAnnotations(tab.pdfBytes, tab.annotator.annotations, tab.viewer);
  const res   = await window.api.saveFile(tab.filePath, bytes.buffer);
  if (res.ok) {
    tab.pdfBytes = bytes;
    tab.dirty    = false;
    renderTabBar();
  } else if (res.error && res.error !== 'cancelled') {
    alert('Save failed: ' + res.error);
  }
}

// Save Copy: writes to a new path but updates the current tab (no new tab opened)
async function saveTabCopy(tab) {
  if (!tab) return;
  const bytes = await embedAnnotations(tab.pdfBytes, tab.annotator.annotations, tab.viewer);
  const res   = await window.api.saveFileCopy(bytes.buffer);
  if (res.ok) {
    tab.filePath = res.filePath;
    tab.pdfBytes = bytes;
    tab.dirty    = false;
    renderTabBar();
  }
}

function _patchAnnotatorForDirty(tab) {
  const orig  = tab.annotator.annotations;
  const proxy = new Proxy(orig, {
    set(target, prop, value) {
      target[prop] = value;
      if (typeof prop === 'string' && !isNaN(prop)) markDirty(tab);
      return true;
    },
  });
  tab.annotator.annotations = proxy;
}

// ── Zoom ───────────────────────────────────────────────────────

async function zoom(delta) {
  if (!activeTab) return;
  const v = activeTab.viewer;
  await v.setZoom(Math.round((v.scale + delta) * 100) / 100);
  activeTab.annotator.pages = v.pages;
  activeTab.annotator.redrawAll();
}

async function fitWidth() {
  if (!activeTab) return;
  const v    = activeTab.viewer;
  const vp   = await v.getViewport(1);
  const containerW = activeTab.pane.clientWidth - 32;
  await v.setZoom(containerW / (vp.width / v.scale));
  activeTab.annotator.pages = v.pages;
  activeTab.annotator.redrawAll();
}

async function fitHeight() {
  if (!activeTab) return;
  const v    = activeTab.viewer;
  const vp   = await v.getViewport(activeTab.viewer.getVisiblePageNum());
  const containerH = activeTab.pane.clientHeight - 32;
  await v.setZoom(containerH / (vp.height / v.scale));
  activeTab.annotator.pages = v.pages;
  activeTab.annotator.redrawAll();
}

// ── Rotate ─────────────────────────────────────────────────────

async function rotate(singlePage) {
  if (!activeTab) return;
  const v = activeTab.viewer;
  if (singlePage) {
    await v.rotatePage(v.getVisiblePageNum(), 90);
  } else {
    await v.rotateAll(90);
  }
  activeTab.annotator.pages = v.pages;
  activeTab.annotator.redrawAll();
}

// ── Page navigation ─────────────────────────────────────────────

function updatePageDisplay(tab) {
  if (!tab?.viewer) {
    pageInput.value  = 1;
    pageTotal.textContent = '/ 1';
    return;
  }
  const count  = tab.viewer.pageCount;
  const pageNum = tab.viewer.getVisiblePageNum();
  pageInput.max        = count;
  pageInput.value      = pageNum;
  pageTotal.textContent = `/ ${count}`;
}

function attachScrollListener(tab) {
  if (_paneScrollCleanup) _paneScrollCleanup();
  const handler = () => updatePageDisplay(tab);
  tab.pane.addEventListener('scroll', handler, { passive: true });
  _paneScrollCleanup = () => tab.pane.removeEventListener('scroll', handler);
}

function jumpToPage(pageNum) {
  if (!activeTab) return;
  const n = Math.max(1, Math.min(activeTab.viewer.pageCount, pageNum));
  activeTab.viewer.scrollToPage(n);
  pageInput.value = n;
}

// ── Table of Contents ──────────────────────────────────────────

function renderToc(outline) {
  tocTree.innerHTML = '';
  if (!outline || outline.length === 0) {
    tocPanel.classList.add('hidden');
    return;
  }
  tocPanel.classList.remove('hidden');
  tocPanel.classList.remove('collapsed');
  _buildTocNodes(outline, tocTree);
}

function _buildTocNodes(items, container) {
  for (const item of items) {
    const hasChildren = item.items && item.items.length > 0;
    const node = document.createElement('div');

    // Build collapsible children container first (needed in closure)
    let childrenEl = null;
    if (hasChildren) {
      childrenEl = document.createElement('div');
      childrenEl.className = 'toc-children';
      childrenEl.hidden    = true; // collapsed by default
      _buildTocNodes(item.items, childrenEl);
    }

    const label = document.createElement('div');
    label.className = 'toc-item';

    const chevron = document.createElement('span');
    chevron.className   = 'toc-chevron';
    chevron.textContent = hasChildren ? '\u25B6' : '\u00a0'; // ▶ or nbsp
    if (hasChildren) {
      chevron.addEventListener('click', (e) => {
        e.stopPropagation();
        childrenEl.hidden   = !childrenEl.hidden;
        chevron.textContent = childrenEl.hidden ? '\u25B6' : '\u25BC'; // ▶ / ▼
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

async function _navigateToOutlineItem(item) {
  if (!activeTab) return;
  const pageNum = await activeTab.viewer.resolveOutlineDest(item.dest || item.url);
  if (pageNum) {
    activeTab.viewer.scrollToPage(pageNum);
    pageInput.value = pageNum;
  }
}

tocToggle.addEventListener('click', () => tocPanel.classList.toggle('collapsed'));

// ── Toolbar ────────────────────────────────────────────────────

function syncToolButtons(tool) {
  document.querySelectorAll('.tool-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tool === tool);
  });
}

function syncTextFormatButtons(annotator) {
  btnBold.classList.toggle('active',      annotator?.textBold      ?? false);
  btnUnderline.classList.toggle('active', annotator?.textUnderline ?? false);
}

function syncSwatches(color) {
  document.querySelectorAll('.swatch').forEach(s => {
    s.classList.toggle('active', s.dataset.color === color);
  });
}

document.querySelectorAll('.tool-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const tool = btn.dataset.tool;
    if (activeTab?.annotator) activeTab.annotator.setTool(tool);
    syncToolButtons(tool);
  });
});

document.querySelectorAll('.swatch').forEach(s => {
  s.addEventListener('click', () => {
    const color = s.dataset.color;
    if (activeTab?.annotator) activeTab.annotator.setColor(color);
    syncSwatches(color);
  });
});

document.getElementById('btn-open').addEventListener('click', openFile);
document.getElementById('btn-undo').addEventListener('click',   () => activeTab?.annotator?.undo());
document.getElementById('btn-redo').addEventListener('click',   () => activeTab?.annotator?.redo());
document.getElementById('btn-fit').addEventListener('click',    fitWidth);
document.getElementById('btn-fit-h').addEventListener('click',  fitHeight);
document.getElementById('btn-rotate').addEventListener('click', (e) => rotate(e.shiftKey));
document.getElementById('btn-print').addEventListener('click',  () => window.print());

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

thicknessInput.addEventListener('input', () => {
  if (activeTab?.annotator) activeTab.annotator.setThickness(Number(thicknessInput.value));
});

document.getElementById('btn-prev-page').addEventListener('click', () => {
  if (!activeTab) return;
  jumpToPage(activeTab.viewer.getVisiblePageNum() - 1);
});

document.getElementById('btn-next-page').addEventListener('click', () => {
  if (!activeTab) return;
  jumpToPage(activeTab.viewer.getVisiblePageNum() + 1);
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
  if (ctrl && e.key === 'w') { e.preventDefault(); closeTab(activeTab); return; }
  if (ctrl && (e.key === '=' || e.key === '+')) { e.preventDefault(); zoom(0.1); return; }
  if (ctrl && e.key === '-') { e.preventDefault(); zoom(-0.1); return; }
  if (ctrl && e.key === '0') { e.preventDefault(); fitWidth(); return; }
  if (ctrl && e.key === 'z') { e.preventDefault(); activeTab?.annotator?.undo(); return; }
  if (ctrl && (e.key === 'y' || (e.shiftKey && e.key === 'Z'))) { e.preventDefault(); activeTab?.annotator?.redo(); return; }
  if (ctrl && e.key === 'p') { e.preventDefault(); window.print(); return; }

  if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;

  const toolMap = {
    d: 'draw', h: 'highlight', t: 'text', Escape: 'select',
    l: 'line',  r: 'rect', o: 'oval', a: 'arrow', e: 'eraser',
  };
  const tool = toolMap[e.key];
  if (tool) {
    if (activeTab?.annotator) activeTab.annotator.setTool(tool);
    syncToolButtons(tool);
  }
});

// ── Menu events from main process ─────────────────────────────

window.api.onMenuEvent((event) => {
  switch (event) {
    case 'menu-open':       openFile(); break;
    case 'menu-save':       saveTab(activeTab); break;
    case 'menu-save-copy':  saveTabCopy(activeTab); break;
    case 'menu-close-tab':  if (activeTab) closeTab(activeTab); break;
  }
});

// ── Init ───────────────────────────────────────────────────────

emptyState.style.display = '';
