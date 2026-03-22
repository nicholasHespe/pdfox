// Reamlet — Find bar (Ctrl+F)
// Searches text content across pages/tabs with exact, wildcard, and fuzzy modes.
// SPDX-License-Identifier: GPL-3.0-or-later

// @ts-ignore — pdfjs-dist is imported via direct path for Electron's file:// ESM loader
import * as pdfjsLib from '../../node_modules/pdfjs-dist/build/pdf.mjs';
import type { Tab, Match } from './types.js';

// ── Utilities ───────────────────────────────────────────────────

function applyTransform([a, b, c, d, e, f]: number[], x: number, y: number): [number, number] {
  return [a * x + c * y + e, b * x + d * y + f];
}

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const curr = [i];
    for (let j = 1; j <= n; j++) {
      curr[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j], curr[j - 1], prev[j - 1]);
    }
    prev = curr;
  }
  return prev[n];
}

// ── FindBar class ───────────────────────────────────────────────

export class FindBar {
  _getTabs: () => Tab[];
  _getActiveTab: () => Tab | null;
  _switchTab: (tab: Tab) => void;
  _allTabMatches: Map<number, Match[]>;
  _matches: Match[];
  _currentIdx: number;
  _query: string;
  _scope: string;
  _mode: string;
  _open: boolean;
  _searchTimer: ReturnType<typeof setTimeout> | null;
  _layers: WeakMap<HTMLDivElement, HTMLDivElement>;
  _allLayers: HTMLDivElement[];
  _bar: HTMLElement;
  _input: HTMLInputElement;
  _counter: HTMLElement;
  _prev: HTMLElement;
  _next: HTMLElement;
  _close: HTMLElement;
  _dropdown: HTMLElement;

  constructor({ getTabs, getActiveTab, switchTab }: { getTabs: () => Tab[]; getActiveTab: () => Tab | null; switchTab: (tab: Tab) => void }) {
    this._getTabs      = getTabs;
    this._getActiveTab = getActiveTab;
    this._switchTab    = switchTab;

    // Per-tab match results (populated in 'all' mode): tabId → Match[]
    this._allTabMatches = new Map();

    // Matches for the currently active tab (used for prev/next + highlights)
    this._matches    = [];
    this._currentIdx = -1;
    this._query      = '';
    this._scope      = 'current';
    this._mode       = 'exact';
    this._open       = false;
    this._searchTimer = null;

    // highlight layer cache
    this._layers    = new WeakMap();
    this._allLayers = [];

    // DOM refs
    this._bar      = document.getElementById('find-bar')!;
    this._input    = document.getElementById('find-input') as HTMLInputElement;
    this._counter  = document.getElementById('find-counter')!;
    this._prev     = document.getElementById('find-prev')!;
    this._next     = document.getElementById('find-next')!;
    this._close    = document.getElementById('find-close')!;
    this._dropdown = document.getElementById('find-dropdown')!;

    this._wireEvents();
  }

  _wireEvents() {
    this._input.addEventListener('input', () => {
      clearTimeout(this._searchTimer ?? undefined);
      this._searchTimer = setTimeout(() => this._search(), 150);
    });

    this._input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); this.close(); return; }
      if (e.key === 'Enter')  { e.preventDefault(); e.shiftKey ? this._navigate(-1) : this._navigate(1); }
    });

    this._prev.addEventListener('click', () => this._navigate(-1));
    this._next.addEventListener('click', () => this._navigate(1));
    this._close.addEventListener('click', () => this.close());

    // Scope toggles
    this._bar.querySelectorAll('[data-scope]').forEach(btn => {
      btn.addEventListener('click', () => {
        this._bar.querySelectorAll('[data-scope]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this._scope = (btn as HTMLElement).dataset.scope ?? 'current';
        if (this._scope === 'current') this._hideDropdown();
        this._search();
      });
    });

    // Mode toggles — clicking active reverts to exact
    this._bar.querySelectorAll('[data-mode]').forEach(btn => {
      btn.addEventListener('click', () => {
        const wasActive = btn.classList.contains('active');
        this._bar.querySelectorAll('[data-mode]').forEach(b => b.classList.remove('active'));
        if (!wasActive) {
          btn.classList.add('active');
          this._mode = (btn as HTMLElement).dataset.mode ?? 'exact';
        } else {
          this._mode = 'exact';
        }
        this._search();
      });
    });
  }

  // ── Public API ────────────────────────────────────────────────

  open() {
    if (!this._getActiveTab()) return;
    this._open = true;
    this._bar.classList.remove('hidden');
    this._input.focus();
    this._input.select();
    if (this._input.value.trim()) this._search();
  }

  close() {
    this._open = false;
    this._bar.classList.add('hidden');
    this._hideDropdown();
    this._clearHighlights();
    this._matches       = [];
    this._currentIdx    = -1;
    this._allTabMatches.clear();
    this._counter.textContent = '';
    this._input.blur();
  }

  isOpen() { return this._open; }

  invalidateTab(tab: Tab) {
    delete tab._findCache;
    this._allTabMatches.delete(tab.id);
    // Release find-layer divs for this tab's pages so canvas buffers can be GC'd.
    // Filter by isConnected — layers become detached when viewer.sleep() clears container.innerHTML.
    this._allLayers = this._allLayers.filter(l => l.isConnected);
  }

  onZoom() {
    if (this._open && this._matches.length > 0) this._renderHighlights();
  }

  // Called when the active tab changes
  onTabSwitch() {
    if (!this._open) return;
    const activeTab = this._getActiveTab();
    if (!activeTab) return;
    // Sync _matches to new active tab's results
    this._matches    = this._allTabMatches.get(activeTab.id) ?? [];
    this._currentIdx = this._matches.length > 0 ? 0 : -1;
    this._renderHighlights();
    this._updateCounter();
    this._updateDropdownActive();
  }

  // ── Text extraction ───────────────────────────────────────────

  async _getTextCache(tab: Tab) {
    if (!tab._findCache) tab._findCache = new Map();

    let pdfDoc  = tab.viewer.pdfDoc;
    let tempDoc = null;

    if (!pdfDoc) {
      tempDoc = await pdfjsLib.getDocument({ data: tab.pdfBytes.slice() }).promise;
      pdfDoc  = tempDoc;
    }

    const numPages = pdfDoc.numPages;
    for (let p = 1; p <= numPages; p++) {
      if (tab._findCache.has(p)) continue;
      const page = await pdfDoc.getPage(p);
      const tc   = await page.getTextContent();
      tab._findCache.set(p, {
        items: tc.items
          .filter((item: any) => item.str)
          .map((item: any) => ({
            str:    item.str,
            x:      item.transform[4],
            y:      item.transform[5],
            width:  item.width,
            height: item.height,
          })),
      });
    }

    if (tempDoc) tempDoc.destroy();
  }

  // ── Matching ──────────────────────────────────────────────────

  _buildMatcher(query: string, mode: string) {
    const norm = (s: string) => s.normalize('NFKC');
    const q    = norm(query);

    if (mode === 'wildcard') {
      const escaped = q
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.');
      let re;
      try { re = new RegExp(escaped, 'gi'); } catch { re = null; }
      return (str: string) => {
        if (!re) return [];
        const results = [];
        let m;
        re.lastIndex = 0;
        while ((m = re.exec(norm(str))) !== null) {
          results.push({ start: m.index, end: m.index + m[0].length });
          if (m[0].length === 0) re.lastIndex++;
        }
        return results;
      };
    }

    if (mode === 'fuzzy') {
      const threshold = q.length < 3 ? 0 : Math.max(1, Math.floor(q.length / 5));
      const qLen      = q.length;
      return (str: string) => {
        const s = norm(str).toLowerCase();
        const a = q.toLowerCase();
        const results = [];
        let i = 0;
        while (i <= s.length - qLen + threshold) {
          let found = false;
          for (let wLen = qLen - threshold; wLen <= qLen + threshold; wLen++) {
            if (i + wLen > s.length || wLen < 1) continue;
            if (levenshtein(a, s.slice(i, i + wLen)) <= threshold) {
              results.push({ start: i, end: i + wLen });
              i += wLen;
              found = true;
              break;
            }
          }
          if (!found) i++;
        }
        return results;
      };
    }

    // Exact (default) — case-insensitive, NFKC-normalized
    const ql = norm(q).toLowerCase();
    return (str: string) => {
      const results = [];
      const sl  = norm(str).toLowerCase();
      let   idx = 0;
      while ((idx = sl.indexOf(ql, idx)) !== -1) {
        results.push({ start: idx, end: idx + ql.length });
        idx += ql.length;
      }
      return results;
    };
  }

  async _searchTab(tab: Tab, matcher: (str: string) => { start: number; end: number }[]) {
    await this._getTextCache(tab);
    const matches: Match[]  = [];
    const cache    = tab._findCache!;
    const numPages = cache.size;

    for (let p = 1; p <= numPages; p++) {
      const entry = cache.get(p);
      if (!entry) continue;
      entry.items.forEach((item, itemIdx) => {
        matcher(item.str).forEach(({ start, end }) => {
          const len  = item.str.length || 1;
          const xOff = (start / len) * item.width;
          const xEnd = (end   / len) * item.width;
          matches.push({
            tabId:     tab.id,
            pageNum:   p,
            itemIdx,
            charStart: start,
            charEnd:   end,
            x:         item.x + xOff,
            y:         item.y,
            w:         xEnd - xOff,
            h:         item.height || 12,
          });
        });
      });
    }
    return matches;
  }

  // ── Core search ───────────────────────────────────────────────

  async _search() {
    const query = this._input.value.trim();
    this._query = query;
    this._clearHighlights();
    this._allTabMatches.clear();

    if (!query) {
      this._matches    = [];
      this._currentIdx = -1;
      this._counter.textContent = '';
      this._input.classList.remove('no-results');
      this._hideDropdown();
      return;
    }

    const activeTab = this._getActiveTab();
    if (!activeTab) return;

    const matcher     = this._buildMatcher(query, this._mode);
    const allTabs     = this._getTabs();
    // Current tab first
    const orderedTabs = this._scope === 'all'
      ? [activeTab, ...allTabs.filter(t => t !== activeTab)]
      : [activeTab];

    for (const tab of orderedTabs) {
      const m = await this._searchTab(tab, matcher);
      if (m.length > 0) this._allTabMatches.set(tab.id, m);
    }

    // Matches for navigation = current tab only
    this._matches    = this._allTabMatches.get(activeTab.id) ?? [];
    const visiblePage = activeTab.viewer.getVisiblePageNum?.() ?? 1;
    const startIdx    = this._matches.findIndex(m => m.pageNum >= visiblePage);
    this._currentIdx  = this._matches.length > 0 ? (startIdx !== -1 ? startIdx : 0) : -1;

    const totalMatches = [...this._allTabMatches.values()].reduce((s, m) => s + m.length, 0);
    this._input.classList.toggle('no-results', totalMatches === 0);
    this._updateCounter();
    this._renderHighlights();

    if (this._scope === 'all' && this._allTabMatches.size > 0) {
      this._buildDropdown(orderedTabs);
    } else {
      this._hideDropdown();
      if (this._matches.length > 0) this._jumpToMatch(this._matches[this._currentIdx]);
    }
  }

  // ── Dropdown (All docs mode) ──────────────────────────────────

  _buildDropdown(orderedTabs: Tab[]) {
    const activeTab = this._getActiveTab();
    this._dropdown.innerHTML = '';

    orderedTabs.forEach(tab => {
      const count = this._allTabMatches.get(tab.id)?.length ?? 0;
      if (count === 0) return;

      const row = document.createElement('div');
      row.className = 'find-doc-row' + (tab === activeTab ? ' active' : '');
      row.dataset.tabId = String(tab.id);

      const name = document.createElement('span');
      name.className = 'find-doc-name';
      name.textContent = tab.filePath
        ? tab.filePath.replace(/.*[\\/]/, '') // basename only
        : 'Untitled';

      const badge = document.createElement('span');
      badge.className = 'find-doc-count';
      badge.textContent = count === 1 ? '1 match' : `${count} matches`;

      row.append(name, badge);
      row.addEventListener('click', () => this._selectDocRow(tab));
      this._dropdown.appendChild(row);
    });

    this._dropdown.classList.remove('hidden');
  }

  async _selectDocRow(tab: Tab) {
    const activeTab = this._getActiveTab();
    if (tab !== activeTab) {
      await this._switchTab(tab);
      // onTabSwitch() will sync _matches; call renderHighlights after
      this._renderHighlights();
    }
    // Jump to first match in this tab
    this._matches    = this._allTabMatches.get(tab.id) ?? [];
    this._currentIdx = 0;
    this._updateDropdownActive();
    this._renderHighlights();
    this._updateCounter();
    if (this._matches.length > 0) this._jumpToMatch(this._matches[0]);
  }

  _updateDropdownActive() {
    const activeTab = this._getActiveTab();
    if (!activeTab) return;
    this._dropdown.querySelectorAll('.find-doc-row').forEach(row => {
      row.classList.toggle('active', (row as HTMLElement).dataset.tabId === String(activeTab.id));
    });
  }

  _hideDropdown() {
    this._dropdown.classList.add('hidden');
    this._dropdown.innerHTML = '';
  }

  // ── Navigation ────────────────────────────────────────────────

  _navigate(dir: number) {
    if (this._matches.length === 0) return;
    this._currentIdx = (this._currentIdx + dir + this._matches.length) % this._matches.length;
    this._renderHighlights();
    this._jumpToMatch(this._matches[this._currentIdx]);
    this._updateCounter();
  }

  async _jumpToMatch(match: Match) {
    const tab = this._getTabs().find(t => t.id === match.tabId);
    if (!tab) return;

    tab.viewer.scrollToPage(match.pageNum);

    requestAnimationFrame(() => {
      const pd = tab.viewer.pages[match.pageNum - 1];
      if (!pd) return;
      const layer = this._layers.get(pd.wrapper);
      if (!layer) return;
      const current = layer.querySelector('.find-highlight.current');
      if (current) current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }

  // ── Highlight rendering ───────────────────────────────────────

  _getOrCreateLayer(wrapper: HTMLDivElement) {
    if (!this._layers.has(wrapper)) {
      const layer = document.createElement('div');
      layer.className = 'find-layer';
      wrapper.appendChild(layer);
      this._layers.set(wrapper, layer);
      this._allLayers.push(layer);
    }
    return this._layers.get(wrapper);
  }

  _clearHighlights() {
    this._allLayers.forEach(layer => { layer.innerHTML = ''; });
  }

  _renderHighlights() {
    this._clearHighlights();

    const activeTab = this._getActiveTab();
    if (!activeTab) return;

    this._matches.forEach((match, i) => {
      const pd = activeTab.viewer.pages[match.pageNum - 1];
      if (!pd || !pd.viewportTransform) return;

      const layer = this._getOrCreateLayer(pd.wrapper);
      const vt    = pd.viewportTransform;

      // PDF y is from bottom-left; screen y is from top-left
      const [sx, sy] = applyTransform(vt, match.x,             match.y + match.h);
      const [ex, ey] = applyTransform(vt, match.x + match.w,   match.y);

      const div = document.createElement('div');
      div.className = 'find-highlight' + (i === this._currentIdx ? ' current' : '');
      div.style.left   = Math.min(sx, ex) + 'px';
      div.style.top    = Math.min(sy, ey) + 'px';
      div.style.width  = Math.abs(ex - sx) + 'px';
      div.style.height = Math.abs(ey - sy) + 'px';
      layer!.appendChild(div);
    });
  }

  _updateCounter() {
    if (this._scope === 'all') {
      const n = this._matches.length;
      this._counter.textContent = n === 0 ? '' : `${n} in doc`;
    } else {
      if (this._matches.length === 0) {
        this._counter.textContent = this._query ? 'No results' : '';
      } else {
        this._counter.textContent = `${this._currentIdx + 1} of ${this._matches.length}`;
      }
    }
    this._input.classList.toggle(
      'no-results',
      !!this._query && this._matches.length === 0 && this._allTabMatches.size === 0
    );
  }
}
