// Reamlet — Print Preview renderer
// SPDX-License-Identifier: GPL-3.0-or-later

// @ts-expect-error — pdfjs-dist direct path for Electron ESM
import * as _pdfjsLib from '../../node_modules/pdfjs-dist/build/pdf.mjs';
import type * as PDFJSLib from 'pdfjs-dist';
const pdfjsLib = _pdfjsLib as unknown as typeof PDFJSLib;
pdfjsLib.GlobalWorkerOptions.workerSrc =
  new URL('../../node_modules/pdfjs-dist/build/pdf.worker.mjs', import.meta.url).href;

// ── DOM refs ──────────────────────────────────────────────────
const previewArea    = document.getElementById('preview-area')!;
const selPrinter     = document.getElementById('sel-printer')      as HTMLSelectElement;
const btnPrinterPref = document.getElementById('btn-printer-pref') as HTMLButtonElement;
const inpCopies      = document.getElementById('inp-copies')       as HTMLInputElement;
const chkCollate     = document.getElementById('chk-collate')      as HTMLInputElement;
const inpPages       = document.getElementById('inp-pages')        as HTMLInputElement;
const selScale       = document.getElementById('sel-scale')        as HTMLSelectElement;
const selPps         = document.getElementById('sel-pps')          as HTMLSelectElement;
const selDuplex      = document.getElementById('sel-duplex')       as HTMLSelectElement;
const chkBooklet     = document.getElementById('chk-booklet')      as HTMLInputElement;
const btnPrint       = document.getElementById('btn-print')        as HTMLButtonElement;
const btnClose       = document.getElementById('btn-close')        as HTMLButtonElement;
const statusEl       = document.getElementById('status')!;
const btnZoomOut     = document.getElementById('btn-zoom-out')     as HTMLButtonElement;
const btnZoomIn      = document.getElementById('btn-zoom-in')      as HTMLButtonElement;
const zoomLabel      = document.getElementById('zoom-label')!;

// ── State ─────────────────────────────────────────────────────
let totalPages = 0;
let previewZoom = 1.0;
let printOrientation: 'portrait' | 'landscape' = 'portrait';

const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0];
const ZOOM_MIN = ZOOM_STEPS[0];
const ZOOM_MAX = ZOOM_STEPS[ZOOM_STEPS.length - 1];

function setPreviewZoom(z: number) {
  previewZoom = z;
  zoomLabel.textContent = `${Math.round(z * 100)}%`;
  btnZoomOut.disabled = z <= ZOOM_MIN;
  btnZoomIn.disabled  = z >= ZOOM_MAX;
  previewArea.style.zoom = String(z);
}

function fitToWidth() {
  if (pageData.length === 0) return;
  const padding   = 48; // 24px each side
  const availW    = previewArea.clientWidth - padding;
  const refW      = pageData[0].naturalW;
  const refH      = pageData[0].naturalH;
  const shortSide = Math.min(refW, refH);
  const longSide  = Math.max(refW, refH);
  const isBooklet = chkBooklet.checked;
  const paperW    = isBooklet
    ? (printOrientation === 'landscape' ? longSide : shortSide) * 2
    : (printOrientation === 'landscape' ? longSide : shortSide);
  const z = Math.min(Math.max(availW / paperW, ZOOM_MIN), ZOOM_MAX);
  setPreviewZoom(Math.round(z * 1000) / 1000);
}

btnZoomOut.addEventListener('click', () => {
  const prev = [...ZOOM_STEPS].reverse().find(s => s < previewZoom - 0.001);
  if (prev !== undefined) setPreviewZoom(prev);
});
btnZoomIn.addEventListener('click', () => {
  const next = ZOOM_STEPS.find(s => s > previewZoom + 0.001);
  if (next !== undefined) setPreviewZoom(next);
});

interface PageData {
  img: HTMLImageElement; // loaded at 1.5× scale
  naturalW: number;      // 1× CSS width (viewport.width / 1.5)
  naturalH: number;      // 1× CSS height
}
const pageData: PageData[] = []; // index 0 = page 1
const failedPages: number[] = []; // 1-based page numbers that failed to render as PNG
let _compositeUrls: string[] = []; // blob URLs for composite renders; revoked before each rebuild

// ── Printers ──────────────────────────────────────────────────
(async () => {
  const printers = await window.api.getPrinters();
  selPrinter.innerHTML = '';
  if (printers.length === 0) {
    const opt = document.createElement('option');
    opt.textContent = 'No printers found';
    selPrinter.appendChild(opt);
    btnPrint.disabled = true;
    return;
  }
  printers.forEach((p: { name: string; isDefault: boolean }) => {
    const opt = document.createElement('option');
    opt.value = p.name;
    opt.textContent = p.name;
    if (p.isDefault) opt.selected = true;
    selPrinter.appendChild(opt);
  });
})();

btnPrinterPref.addEventListener('click', () => {
  if (selPrinter.value) window.api.openPrinterPreferences(selPrinter.value);
});

// ── Page range parsing ────────────────────────────────────────
// Returns null for "all pages", or a Set<number> of selected page numbers.
function parsePageRange(str: string): Set<number> | null {
  const trimmed = str.trim();
  if (!trimmed) return null;
  const result = new Set<number>();
  for (const part of trimmed.split(',')) {
    const t = part.trim();
    const rangeMatch = t.match(/^(\d+)\s*[-\u2013]\s*(\d+)$/);
    if (rangeMatch) {
      const from = parseInt(rangeMatch[1]), to = parseInt(rangeMatch[2]);
      for (let p = Math.max(1, from); p <= Math.min(totalPages, to); p++) result.add(p);
    } else {
      const n = parseInt(t);
      if (!isNaN(n) && n >= 1 && n <= totalPages) result.add(n);
    }
  }
  return result;
}

// ── Booklet ordering ──────────────────────────────────────────
interface BookletSheet {
  front: [number, number]; // [leftPage, rightPage] — both 1-indexed; 0 = blank
  back:  [number, number];
}

function getBookletOrder(numPages: number): BookletSheet[] {
  const totalSlots = Math.ceil(numPages / 4) * 4;
  const numSheets  = totalSlots / 4;
  const sheets: BookletSheet[] = [];
  let low = 1, high = totalSlots;
  for (let i = 0; i < numSheets; i++) {
    // Per spec: front=[high, low], back=[low+1, high-1]
    // "right page is high, left page is low" in the spec, but we render [left=high, right=low]
    // which matches physical booklet layout (high=back_cover on left, low=front_cover on right)
    sheets.push({ front: [high, low], back: [low + 1, high - 1] });
    low  += 2;
    high -= 2;
  }
  return sheets;
}

// ── Composite image builder ───────────────────────────────────
// pageSlots: 1-indexed page numbers; 0 or >totalPages means blank
// cols: number of columns in the grid
// targetW/H: canvas output size in px
async function buildComposite(pageSlots: number[], cols: number, targetW: number, targetH: number): Promise<HTMLImageElement> {
  const rows = Math.ceil(pageSlots.length / cols);
  const canvas = document.createElement('canvas');
  canvas.width  = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, targetW, targetH);

  const slotW = targetW / cols;
  const slotH = targetH / rows;

  pageSlots.forEach((pageNum, idx) => {
    const col  = idx % cols;
    const row  = Math.floor(idx / cols);
    const slotX = col * slotW;
    const slotY = row * slotH;

    if (pageNum >= 1 && pageNum <= totalPages) {
      const { img, naturalW, naturalH } = pageData[pageNum - 1];
      const scale = Math.min(slotW / naturalW, slotH / naturalH);
      const dw = naturalW * scale, dh = naturalH * scale;
      ctx.drawImage(img, slotX + (slotW - dw) / 2, slotY + (slotH - dh) / 2, dw, dh);
    } else {
      // Blank slot — subtle fill and label so users know it's intentional
      ctx.fillStyle = '#f0f0f0';
      ctx.fillRect(slotX + 0.5, slotY + 0.5, slotW - 1, slotH - 1);
      ctx.font = `${Math.round(Math.min(slotW, slotH) * 0.07)}px system-ui, sans-serif`;
      ctx.fillStyle = '#bbb';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Blank', slotX + slotW / 2, slotY + slotH / 2);
    }
    // Faint slot border
    ctx.strokeStyle = '#ddd';
    ctx.lineWidth = 0.5;
    ctx.strokeRect(slotX + 0.25, slotY + 0.25, slotW - 0.5, slotH - 0.5);
  });

  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(b => b ? resolve(b) : reject(new Error('canvas.toBlob failed')), 'image/png')
  );
  const url = URL.createObjectURL(blob);
  _compositeUrls.push(url);
  const out = new Image();
  await new Promise<void>(resolve => { out.onload = () => resolve(); out.src = url; });
  return out;
}

// ── Add a page wrapper to the preview ────────────────────────
// paperW/H are the paper dimensions; imgEl scales to fit inside.
function addPreviewPage(imgEl: HTMLImageElement, paperW: number, paperH: number) {
  imgEl.style.cssText = '';
  const wrapper = document.createElement('div');
  wrapper.className = 'print-page';
  wrapper.style.width  = `${paperW}px`;
  wrapper.style.height = `${paperH}px`;
  wrapper.appendChild(imgEl);
  previewArea.appendChild(wrapper);
}

// ── Build / refresh the preview ───────────────────────────────
async function renderPreview() {
  if (pageData.length === 0) return;

  // Revoke blob URLs from the previous render before rebuilding.
  _compositeUrls.forEach(u => URL.revokeObjectURL(u));
  _compositeUrls = [];

  previewArea.innerHTML = '';

  const isBooklet = chkBooklet.checked;
  const pps       = isBooklet ? 2 : (parseInt(selPps.value) || 1);
  const pageRange = parsePageRange(inpPages.value);

  // Reference dimensions (first page at 1× scale)
  const refW = pageData[0].naturalW;
  const refH = pageData[0].naturalH;

  // Paper dimensions: honour orientation toggle (booklet is always landscape)
  const shortSide = Math.min(refW, refH);
  const longSide  = Math.max(refW, refH);
  const paperW = (isBooklet || printOrientation === 'landscape') ? longSide : shortSide;
  const paperH = (isBooklet || printOrientation === 'landscape') ? shortSide : longSide;

  if (isBooklet) {
    // Booklet: always uses all pages; composites are landscape (2× wide)
    const sheets = getBookletOrder(totalPages);
    for (const sheet of sheets) {
      for (const side of ['front', 'back'] as const) {
        const [lp, rp] = sheet[side];
        const img = await buildComposite([lp, rp], 2, paperW * 2, paperH);
        addPreviewPage(img, paperW * 2, paperH);
      }
    }
  } else if (pps > 1) {
    // Pages per sheet: group visible pages into chunks, create composite
    const PPS_COLS: Record<number, number> = { 2: 2, 4: 2, 6: 3, 9: 3, 16: 4 };
    const cols = PPS_COLS[pps] ?? 2;

    const visible: number[] = [];
    for (let p = 1; p <= totalPages; p++) {
      if (pageRange === null || pageRange.has(p)) visible.push(p);
    }
    for (let i = 0; i < visible.length; i += pps) {
      const chunk = visible.slice(i, i + pps);
      while (chunk.length < pps) chunk.push(0); // pad with blanks
      const img = await buildComposite(chunk, cols, paperW, paperH);
      addPreviewPage(img, paperW, paperH);
    }
  } else {
    // Single page per sheet — show each page letterboxed on the selected paper size
    for (let p = 1; p <= totalPages; p++) {
      if (pageRange !== null && !pageRange.has(p)) continue;
      const { img } = pageData[p - 1];
      const clone = new Image();
      clone.src = img.src;
      addPreviewPage(clone, paperW, paperH);
    }
  }

  updateGreyscale();
}

function updateGreyscale() {
  const grey = (document.querySelector('input[name="color"]:checked') as HTMLInputElement)?.value === 'grey';
  previewArea.classList.toggle('greyscale', grey);
}

// ── Event wiring ──────────────────────────────────────────────
inpPages.addEventListener('input',    renderPreview);
selPps.addEventListener('change',     () => { if (!chkBooklet.checked) renderPreview(); });
chkBooklet.addEventListener('change', () => {
  if (chkBooklet.checked) {
    selPps.value    = '2';
    selDuplex.value = 'shortEdge';
    selPps.disabled = true;
  } else {
    selPps.value    = '1';
    selDuplex.value = 'simplex';
    selPps.disabled = false;
  }
  renderPreview();
});
document.querySelectorAll('input[name="color"]').forEach(el =>
  el.addEventListener('change', updateGreyscale));
document.querySelectorAll('input[name="orientation"]').forEach(el =>
  el.addEventListener('change', () => {
    printOrientation = (document.querySelector('input[name="orientation"]:checked') as HTMLInputElement).value as 'portrait' | 'landscape';
    fitToWidth();
    renderPreview();
  }));

btnClose.addEventListener('click', () => window.close());

window.addEventListener('wheel', (e: WheelEvent) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  if (e.deltaY < 0) { const next = ZOOM_STEPS.find(s => s > previewZoom + 0.001);            if (next !== undefined) setPreviewZoom(next); }
  if (e.deltaY > 0) { const prev = [...ZOOM_STEPS].reverse().find(s => s < previewZoom - 0.001); if (prev !== undefined) setPreviewZoom(prev); }
}, { passive: false });

btnPrint.addEventListener('click', async () => {
  const copies      = Math.max(1, parseInt(inpCopies.value) || 1);
  const grey        = (document.querySelector('input[name="color"]:checked') as HTMLInputElement)?.value === 'grey';
  const scaleVal    = selScale.value;
  const scaleFactor = (scaleVal === 'fit' || scaleVal === '100') ? 100 : parseInt(scaleVal);
  const duplexMode  = selDuplex.value as 'simplex' | 'longEdge' | 'shortEdge';
  const landscape   = chkBooklet.checked || printOrientation === 'landscape';

  if (failedPages.length > 0) {
    const n = failedPages.length;
    const ok = confirm(`${n} page${n === 1 ? '' : 's'} (${failedPages.join(', ')}) failed to render and will print blank. Continue anyway?`);
    if (!ok) return;
  }

  btnPrint.disabled = true;
  statusEl.textContent = 'Printing…';
  try {
    const result = await window.api.executePrint({
      deviceName: selPrinter.value,
      copies,
      color:      !grey,
      collate:    chkCollate.checked,
      duplexMode,
      scaleFactor,
      landscape,
    });
    if (!result.ok) {
      statusEl.textContent = `Print failed: ${result.error ?? 'unknown error'}`;
      btnPrint.disabled = false;
      return;
    }
  } catch (err) {
    statusEl.textContent = `Print error: ${(err as Error).message}`;
    btnPrint.disabled = false;
    return;
  }
  window.close();
});

// ── Receive PDF data from main ─────────────────────────────────
window.api.onPdfData(async ({ buffer }) => {
  statusEl.textContent = 'Rendering pages…';

  let pdfDoc;
  try {
    const bytes = new Uint8Array(buffer);
    pdfDoc = await pdfjsLib.getDocument({ data: bytes }).promise;
  } catch (err) {
    statusEl.textContent = `Failed to load PDF: ${(err as Error).message}`;
    return;
  }
  totalPages = pdfDoc.numPages;

  try {
    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
      const page     = await pdfDoc.getPage(pageNum);
      const viewport = page.getViewport({ scale: 1.5 });
      const canvas   = document.createElement('canvas');
      canvas.width   = viewport.width;
      canvas.height  = viewport.height;
      await page.render({ canvasContext: canvas.getContext('2d')!, viewport }).promise;

      const dataUrl  = canvas.toDataURL('image/png');
      const img      = new Image();
      await new Promise<void>(resolve => {
        img.onload  = () => resolve();
        img.onerror = () => { failedPages.push(pageNum); resolve(); };
        img.src = dataUrl;
      });

      pageData.push({
        img,
        naturalW: viewport.width  / 1.5,
        naturalH: viewport.height / 1.5,
      });
      statusEl.textContent = `Rendering… ${pageNum}/${totalPages}`;
    }
  } catch (err) {
    statusEl.textContent = `Rendering error: ${(err as Error).message}`;
    return;
  }

  if (failedPages.length > 0) {
    statusEl.textContent = `${totalPages} page${totalPages === 1 ? '' : 's'} — warning: ${failedPages.length} page${failedPages.length === 1 ? '' : 's'} failed to render (pages ${failedPages.join(', ')}) and will print blank`;
  } else {
    statusEl.textContent = `${totalPages} page${totalPages === 1 ? '' : 's'}`;
  }
  fitToWidth();
  renderPreview();
});
