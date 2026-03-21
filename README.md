# PDFox
A lightweight, standalone PDF viewer for Windows focused on speed and productivity. No bloat, no cloud, no accounts. Does one thing well.

---

## Download

| | |
|---|---|
| **Installer** (recommended) | [PDFox Setup — latest release](https://github.com/nicholasHespe/pdfox/releases/latest) |
| **Portable** (no install needed) | [PDFox portable — latest release](https://github.com/nicholasHespe/pdfox/releases/latest) |

> Windows 10/11 x64 only. No runtime or dependencies required.

---

## Features

- **Multi-tab** — open multiple PDFs in one window; drag tabs to reorder or drag them into a separate window
- **Annotations** — draw, highlight, place text, and add shapes (line, rectangle, oval, arrow); undo/redo support
- **Find** — Ctrl+F search across the current document or all open tabs, with exact, wildcard (`*` `?`), and fuzzy match modes
- **Combine PDFs** — merge any open documents into a new tab in any order
- **Reorder pages** — drag page thumbnails or use arrow buttons to rearrange pages before saving
- **Table of contents** — collapsible bookmark panel for documents that have an outline
- **Form fields** — fill in interactive PDF form fields
- **Zoom & fit** — fit to width, per-page zoom, smooth Ctrl+scroll
- **Rotation** — rotate all pages or individual pages; persisted per session
- **Save / Save As** — saves annotations directly into the PDF file so they open in any viewer
- **Memory-efficient** — inactive tabs are put to sleep automatically and wake on demand
- **Set as default** — install once, right-click any PDF and choose *Open with PDFox*, set as default and forget

---

## Keyboard Shortcuts

### File

| Shortcut | Action |
|---|---|
| `Ctrl+O` | Open file(s) |
| `Ctrl+S` | Save |
| `Ctrl+Shift+S` | Save copy (Save As) |
| `Ctrl+W` | Close tab |
| `Ctrl+Shift+T` | Reopen last closed tab |
| `Ctrl+P` | Print |

### View

| Shortcut | Action |
|---|---|
| `Ctrl+=` / `Ctrl++` | Zoom in |
| `Ctrl+-` | Zoom out |
| `Ctrl+0` | Fit to width |
| `Ctrl+Scroll` | Zoom in / out |
| `Ctrl+R` | Refresh render |

### Find

| Shortcut | Action |
|---|---|
| `Ctrl+F` | Open find bar |
| `Enter` | Next match |
| `Shift+Enter` | Previous match |
| `Escape` | Close find bar |

### Annotations

| Shortcut | Action |
|---|---|
| `Escape` | Select tool |
| `D` | Draw (freehand) |
| `H` | Highlight |
| `T` | Text |
| `L` | Line |
| `R` | Rectangle |
| `O` | Oval |
| `A` | Arrow |
| `E` | Eraser |
| `Ctrl+Z` | Undo |
| `Ctrl+Y` / `Ctrl+Shift+Z` | Redo |

---

## Building from source

```
npm install
npm start          # run in development
npm run build-win  # build installer + portable exe → dist/
```

Requires Node.js 18+ and npm.

---

## License

[GPL-3.0](LICENSE)
