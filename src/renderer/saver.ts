// Reamlet — save logic
// Embeds in-memory annotations into PDF bytes using pdf-lib.
// SPDX-License-Identifier: GPL-3.0-or-later

// @ts-expect-error — pdf-lib is imported via direct path for Electron's file:// ESM loader
import * as _pdfLib from '../../node_modules/pdf-lib/dist/pdf-lib.esm.js';
import type * as PDFLibNS from 'pdf-lib';
import type { Annotation, DrawAnnotation, HighlightAnnotation, TextAnnotation, ShapeAnnotation } from './types.js';
import type { PDFViewer } from './viewer.js';

// Cast the direct-path runtime import to the pdf-lib type surface
const { PDFDocument, PDFName, PDFArray, PDFNumber, PDFString, degrees, rgb, StandardFonts } =
  _pdfLib as unknown as typeof PDFLibNS;

type PDFDoc  = import('pdf-lib').PDFDocument;
type PDFPage = import('pdf-lib').PDFPage;

/**
 * Embed annotations into a PDF and return the modified bytes.
 * Also writes any user-applied page rotations into the PDF's /Rotate entry.
 */
export async function embedAnnotations(pdfBytes: Uint8Array, annotations: Annotation[], viewer: PDFViewer): Promise<Uint8Array> {
  const pdfDoc: PDFDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });

  // Write any form field values the user has edited
  const fieldValues = viewer?.fieldValues;
  if (fieldValues && Object.keys(fieldValues).length > 0) {
    try {
      const form = pdfDoc.getForm();
      for (const [name, value] of Object.entries(fieldValues)) {
        try {
          form.getTextField(name).setText(value == null ? '' : String(value));
          continue;
        } catch { /* ignore */ }
        try {
          const cb = form.getCheckBox(name);
          if (value) { cb.check(); } else { cb.uncheck(); }
          continue;
        } catch { /* ignore */ }
        try {
          const dd = form.getDropdown(name);
          if (value) dd.select(String(value));
        } catch { /* ignore */ }
      }
    } catch { /* PDF has no AcroForm — ignore */ }
  }

  for (let pageIdx = 0; pageIdx < pdfDoc.getPageCount(); pageIdx++) {
    const pageNum = pageIdx + 1;
    const pdfPage: PDFPage = pdfDoc.getPage(pageIdx);

    // Write user rotation into the PDF page's /Rotate entry
    const userRot = viewer.pageRotations?.[pageNum] || 0;
    if (userRot !== 0) {
      const existingRot = pdfPage.getRotation().angle;
      pdfPage.setRotation(degrees((existingRot + userRot) % 360));
    }

    const pageAnns = annotations.filter(a => a.pageNum === pageNum);
    if (pageAnns.length === 0) continue;

    const { width: pdfW, height: pdfH } = await viewer.getPageSize(pageNum);
    const totalRot = viewer.getTotalRotation(pageNum);

    for (const ann of pageAnns) {
      if      (ann.type === 'draw')          _addInkAnnotation      (pdfPage, ann,           pdfW, pdfH, totalRot);
      else if (ann.type === 'freeHighlight') _addInkAnnotation      (pdfPage, ann,           pdfW, pdfH, totalRot);
      else if (ann.type === 'highlight')     _addHighlightAnnotation(pdfPage, ann,           pdfW, pdfH, totalRot);
      else if (ann.type === 'text')          _addFreeTextAnnotation (pdfPage, ann,           pdfW, pdfH, totalRot);
      else if (ann.type === 'line')          _addLineAnnotation     (pdfPage, ann,           pdfW, pdfH, totalRot);
      else if (ann.type === 'arrow')         _addArrowAnnotation    (pdfPage, ann,           pdfW, pdfH, totalRot);
      else if (ann.type === 'rect')          _addSquareAnnotation   (pdfPage, ann,           pdfW, pdfH, totalRot);
      else if (ann.type === 'oval')          _addCircleAnnotation   (pdfPage, ann,           pdfW, pdfH, totalRot);
    }
  }

  return pdfDoc.save();
}

// ── Coordinate helpers ───────────────────────────────────────

/**
 * Convert normalised canvas coords (0–1, y-down) to PDF pts (y-up),
 * accounting for page rotation.
 *
 * Rotation is the total display rotation (base PDF /Rotate + user rotation).
 * Formulas derived from inverting the PDF.js viewport transform:
 *   rot=0:   pdf = (nx·W,     (1-ny)·H)
 *   rot=90:  pdf = (ny·W,     nx·H)
 *   rot=180: pdf = ((1-nx)·W, ny·H)
 *   rot=270: pdf = ((1-ny)·W, (1-nx)·H)
 */
function toPdfCoords(nx: number, ny: number, pdfW: number, pdfH: number, rot: number): [number, number] {
  switch ((rot || 0) % 360) {
    case 90:  return [       ny * pdfW,        nx * pdfH];
    case 180: return [(1 - nx) * pdfW,        ny * pdfH];
    case 270: return [(1 - ny) * pdfW, (1 - nx) * pdfH];
    default:  return [       nx * pdfW, (1 - ny) * pdfH];
  }
}

function hexToRgb01(hex: string): { r: number; g: number; b: number } {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  return { r, g, b };
}

// ── Annotation writers ───────────────────────────────────────

function _addInkAnnotation(pdfPage: PDFPage, ann: DrawAnnotation, pdfW: number, pdfH: number, rot: number): void {
  const { r, g, b } = hexToRgb01(ann.color);

  const inkPoints = ann.points.flatMap(([nx, ny]: [number, number]) => {
    const [x, y] = toPdfCoords(nx, ny, pdfW, pdfH, rot);
    return [PDFNumber.of(x), PDFNumber.of(y)];
  });
  const inkListEntry = pdfPage.doc.context.obj(inkPoints);
  const inkList      = pdfPage.doc.context.obj([inkListEntry]);

  const pdfPts = ann.points.map(([nx, ny]: [number, number]) => toPdfCoords(nx, ny, pdfW, pdfH, rot));
  const xs  = pdfPts.map(([x]: [number, number]) => x);
  const ys  = pdfPts.map(([, y]: [number, number]) => y);
  const pad = ann.thickness;

  const annotDict = pdfPage.doc.context.obj({
    Type:    PDFName.of('Annot'),
    Subtype: PDFName.of('Ink'),
    Rect:    [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad],
    InkList: inkList,
    BS:      pdfPage.doc.context.obj({ W: ann.thickness }),
    C:       [r, g, b],
    CA:      PDFNumber.of(ann.type === 'freeHighlight' ? 0.4 : 1),
    F:       PDFNumber.of(4),
  });

  _appendAnnotation(pdfPage, annotDict);
}

function _addHighlightAnnotation(pdfPage: PDFPage, ann: HighlightAnnotation, pdfW: number, pdfH: number, rot: number): void {
  const { r, g, b } = hexToRgb01(ann.color);

  for (const rect of ann.rects) {
    // All four corners of the highlight rect in normalised coords
    const tl = toPdfCoords(rect.x,             rect.y,              pdfW, pdfH, rot);
    const tr = toPdfCoords(rect.x + rect.width, rect.y,             pdfW, pdfH, rot);
    const bl = toPdfCoords(rect.x,             rect.y + rect.height, pdfW, pdfH, rot);
    const br = toPdfCoords(rect.x + rect.width, rect.y + rect.height, pdfW, pdfH, rot);

    const allX = [tl[0], tr[0], bl[0], br[0]];
    const allY = [tl[1], tr[1], bl[1], br[1]];
    const x1 = Math.min(...allX), x2 = Math.max(...allX);
    const y1 = Math.min(...allY), y2 = Math.max(...allY);

    // QuadPoints: BL, BR, TL, TR in PDF space
    const qp = [x1, y1, x2, y1, x1, y2, x2, y2];

    const annotDict = pdfPage.doc.context.obj({
      Type:       PDFName.of('Annot'),
      Subtype:    PDFName.of('Highlight'),
      Rect:       [x1, y1, x2, y2],
      QuadPoints: qp,
      C:          [r, g, b],
      CA:         PDFNumber.of(0.4),
      F:          PDFNumber.of(4),
    });

    _appendAnnotation(pdfPage, annotDict);
  }
}

function _addFreeTextAnnotation(pdfPage: PDFPage, ann: TextAnnotation, pdfW: number, pdfH: number, rot: number): void {
  const { r, g, b } = hexToRgb01(ann.color);
  const [px, py] = toPdfCoords(ann.x, ann.y, pdfW, pdfH, rot);
  const boxH = ann.fontSize * 2 + 4;

  const da = `${r.toFixed(2)} ${g.toFixed(2)} ${b.toFixed(2)} rg /Helvetica ${ann.fontSize} Tf`;

  const annotDict = pdfPage.doc.context.obj({
    Type:     PDFName.of('Annot'),
    Subtype:  PDFName.of('FreeText'),
    Rect:     [px, py - boxH, px + 200, py],
    Contents: PDFString.of(ann.text),
    DA:       PDFString.of(da),
    F:        PDFNumber.of(4),
  });

  _appendAnnotation(pdfPage, annotDict);
}

function _addLineAnnotation(pdfPage: PDFPage, ann: ShapeAnnotation, pdfW: number, pdfH: number, rot: number): void {
  const { r, g, b } = hexToRgb01(ann.color);
  const [x1, y1] = toPdfCoords(ann.x1, ann.y1, pdfW, pdfH, rot);
  const [x2, y2] = toPdfCoords(ann.x2, ann.y2, pdfW, pdfH, rot);
  const pad = ann.thickness;
  const annotDict = pdfPage.doc.context.obj({
    Type:    PDFName.of('Annot'),
    Subtype: PDFName.of('Line'),
    Rect:    [Math.min(x1,x2)-pad, Math.min(y1,y2)-pad, Math.max(x1,x2)+pad, Math.max(y1,y2)+pad],
    L:       [x1, y1, x2, y2],
    BS:      pdfPage.doc.context.obj({ W: ann.thickness }),
    C:       [r, g, b],
    F:       PDFNumber.of(4),
  });
  _appendAnnotation(pdfPage, annotDict);
}

function _addArrowAnnotation(pdfPage: PDFPage, ann: ShapeAnnotation, pdfW: number, pdfH: number, rot: number): void {
  const { r, g, b } = hexToRgb01(ann.color);
  const [x1, y1] = toPdfCoords(ann.x1, ann.y1, pdfW, pdfH, rot);
  const [x2, y2] = toPdfCoords(ann.x2, ann.y2, pdfW, pdfH, rot);
  const pad = ann.thickness * 5;
  const annotDict = pdfPage.doc.context.obj({
    Type:    PDFName.of('Annot'),
    Subtype: PDFName.of('Line'),
    Rect:    [Math.min(x1,x2)-pad, Math.min(y1,y2)-pad, Math.max(x1,x2)+pad, Math.max(y1,y2)+pad],
    L:       [x1, y1, x2, y2],
    LE:      [PDFName.of('None'), PDFName.of('OpenArrow')],
    BS:      pdfPage.doc.context.obj({ W: ann.thickness }),
    C:       [r, g, b],
    F:       PDFNumber.of(4),
  });
  _appendAnnotation(pdfPage, annotDict);
}

function _addSquareAnnotation(pdfPage: PDFPage, ann: ShapeAnnotation, pdfW: number, pdfH: number, rot: number): void {
  const { r, g, b } = hexToRgb01(ann.color);
  const [x1, y1] = toPdfCoords(ann.x1, ann.y1, pdfW, pdfH, rot);
  const [x2, y2] = toPdfCoords(ann.x2, ann.y2, pdfW, pdfH, rot);
  const annotDict = pdfPage.doc.context.obj({
    Type:    PDFName.of('Annot'),
    Subtype: PDFName.of('Square'),
    Rect:    [Math.min(x1,x2), Math.min(y1,y2), Math.max(x1,x2), Math.max(y1,y2)],
    BS:      pdfPage.doc.context.obj({ W: ann.thickness }),
    C:       [r, g, b],
    F:       PDFNumber.of(4),
  });
  _appendAnnotation(pdfPage, annotDict);
}

function _addCircleAnnotation(pdfPage: PDFPage, ann: ShapeAnnotation, pdfW: number, pdfH: number, rot: number): void {
  const { r, g, b } = hexToRgb01(ann.color);
  const [x1, y1] = toPdfCoords(ann.x1, ann.y1, pdfW, pdfH, rot);
  const [x2, y2] = toPdfCoords(ann.x2, ann.y2, pdfW, pdfH, rot);
  const annotDict = pdfPage.doc.context.obj({
    Type:    PDFName.of('Annot'),
    Subtype: PDFName.of('Circle'),
    Rect:    [Math.min(x1,x2), Math.min(y1,y2), Math.max(x1,x2), Math.max(y1,y2)],
    BS:      pdfPage.doc.context.obj({ W: ann.thickness }),
    C:       [r, g, b],
    F:       PDFNumber.of(4),
  });
  _appendAnnotation(pdfPage, annotDict);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function _appendAnnotation(pdfPage: PDFPage, annotDict: any): void {

  const ref    = pdfPage.doc.context.register(annotDict);
  const annots = pdfPage.node.get(PDFName.of('Annots'));
  if (annots instanceof PDFArray) {
    annots.push(ref);
  } else {

    pdfPage.node.set(PDFName.of('Annots'), pdfPage.doc.context.obj([ref]));
  }
}

// ── Footer ───────────────────────────────────────────────────

export interface FooterConfig {
  left:     string;
  center:   string;
  right:    string;
  fontSize: number;
}

/**
 * Draw a 3-column footer on every page and return the modified bytes.
 * Tokens {page} and {total} are replaced with the current page number and total.
 */
export async function embedFooter(pdfBytes: Uint8Array, config: FooterConfig): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const font   = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const total  = pdfDoc.getPageCount();
  const black  = rgb(0, 0, 0);
  const margin = 40;
  const yPos   = 20;

  for (let i = 0; i < total; i++) {
    const page        = pdfDoc.getPage(i);
    const { width: pdfW } = page.getSize();
    const resolve     = (t: string) =>
      t.replace(/\{page\}/g, String(i + 1)).replace(/\{total\}/g, String(total));

    const l = resolve(config.left);
    const c = resolve(config.center);
    const r = resolve(config.right);

    if (l) {
      page.drawText(l, { x: margin, y: yPos, size: config.fontSize, font, color: black });
    }
    if (c) {
      const tw = font.widthOfTextAtSize(c, config.fontSize);
      page.drawText(c, { x: (pdfW - tw) / 2, y: yPos, size: config.fontSize, font, color: black });
    }
    if (r) {
      const tw = font.widthOfTextAtSize(r, config.fontSize);
      page.drawText(r, { x: pdfW - margin - tw, y: yPos, size: config.fontSize, font, color: black });
    }
  }

  return pdfDoc.save();
}

// ── Watermark ────────────────────────────────────────────────

export interface WatermarkConfig {
  text:     string;
  fontSize: number;
  opacity:  number;  // 0.0–1.0
  angle:    number;  // degrees
}

/**
 * Draw a centred, rotated text watermark on every page and return the modified bytes.
 */
export async function embedWatermark(pdfBytes: Uint8Array, config: WatermarkConfig): Promise<Uint8Array> {
  const pdfDoc     = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const font       = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const grey       = rgb(0.5, 0.5, 0.5);
  const angleRad   = (config.angle * Math.PI) / 180;
  const lines      = config.text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const lineHeight = config.fontSize * 1.3;

  for (let i = 0; i < pdfDoc.getPageCount(); i++) {
    const page = pdfDoc.getPage(i);
    const { width: pdfW, height: pdfH } = page.getSize();

    lines.forEach((line, li) => {
      const textWidth  = font.widthOfTextAtSize(line, config.fontSize);
      // Perpendicular offset (CCW 90° from text direction) to space lines
      const perpOffset = (li - (lines.length - 1) / 2) * lineHeight;

      // Centre each line at page centre then offset perpendicularly
      const x = pdfW / 2
        - (textWidth / 2)        * Math.cos(angleRad)
        + (config.fontSize / 2)  * Math.sin(angleRad)
        - perpOffset             * Math.sin(angleRad);
      const y = pdfH / 2
        - (textWidth / 2)        * Math.sin(angleRad)
        - (config.fontSize / 2)  * Math.cos(angleRad)
        + perpOffset             * Math.cos(angleRad);

      page.drawText(line, {
        x,
        y,
        size:    config.fontSize,
        font,
        color:   grey,
        opacity: config.opacity,
        rotate:  degrees(config.angle),
      });
    });
  }

  return pdfDoc.save();
}
