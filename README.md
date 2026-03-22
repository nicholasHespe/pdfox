# Reamlet
A lightweight, standalone PDF viewer for Windows and macOS focused on speed and productivity. No bloat, no cloud, no accounts. Does one thing well.

---

## Download

### Windows
| | |
|---|---|
| **Installer** (recommended) | [Reamlet Setup — latest release](https://github.com/nicholasHespe/Reamlet/releases/latest) |
| **Portable** (no install needed) | [Reamlet portable — latest release](https://github.com/nicholasHespe/Reamlet/releases/latest) |

> Windows 10/11 x64. No runtime or dependencies required.

### macOS
| | |
|---|---|
| **DMG** (Intel + Apple Silicon) | [Reamlet — latest release](https://github.com/nicholasHespe/Reamlet/releases/latest) |

> macOS universal binary — runs natively on both Intel and Apple Silicon.

---

## Features

- **Multi-tab** — open multiple PDFs in one window; drag tabs to reorder or drag them into a separate window
- **Annotations** — draw, highlight, place text, and add shapes (line, rectangle, oval, arrow); undo/redo support
- **Find** — Ctrl+F / ⌘F search across the current document or all open tabs, with exact, wildcard (`*` `?`), and fuzzy match modes
- **Combine PDFs** — merge any open documents into a new tab in any order
- **Reorder pages** — drag page thumbnails or use arrow buttons to rearrange pages before saving
- **Table of contents** — collapsible bookmark panel for documents that have an outline
- **Form fields** — fill in interactive PDF form fields
- **Zoom & fit** — fit to width, per-page zoom, smooth Ctrl+scroll / ⌘+scroll
- **Rotation** — rotate all pages or individual pages; persisted per session
- **Save / Save As** — saves annotations directly into the PDF file so they open in any viewer
- **Memory-efficient** — inactive tabs are put to sleep automatically and wake on demand
- **Set as default** — install once, set Reamlet as your default PDF viewer and forget

---

## Keyboard Shortcuts

### File

| Shortcut | Action |
|---|---|
| `Ctrl+O` / `⌘O` | Open file(s) |
| `Ctrl+S` / `⌘S` | Save |
| `Ctrl+Shift+S` / `⌘⇧S` | Save copy (Save As) |
| `Ctrl+W` / `⌘W` | Close tab |
| `Ctrl+Shift+T` / `⌘⇧T` | Reopen last closed tab |
| `Ctrl+P` / `⌘P` | Print |

### View

| Shortcut | Action |
|---|---|
| `Ctrl+=` / `⌘=` | Zoom in |
| `Ctrl+-` / `⌘-` | Zoom out |
| `Ctrl+0` / `⌘0` | Fit to width |
| `Ctrl+Scroll` / `⌘Scroll` | Zoom in / out |
| `Ctrl+R` / `⌘R` | Refresh render |

### Find

| Shortcut | Action |
|---|---|
| `Ctrl+F` / `⌘F` | Open find bar |
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
| `Ctrl+Z` / `⌘Z` | Undo |
| `Ctrl+Y` / `⌘⇧Z` | Redo |

---

## Building from source

```
pnpm install
pnpm start           # run in development
pnpm run build-win   # Windows: NSIS installer + portable exe → dist/
pnpm run build-mac   # macOS:   universal DMG → dist/
```

Requires Node.js 18+ and [pnpm](https://pnpm.io) (`npm install -g pnpm`). Mac builds must be run on macOS.

---

## License

[GPL-3.0](LICENSE)
