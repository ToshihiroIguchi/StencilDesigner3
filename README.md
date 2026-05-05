# StencilDesigner3

A browser-based 2D CAD editor for screen-printing stencil / solder-paste mask design.
No installation, no backend — open the page and start drawing.

> **Live demo:** [https://toshihiroiguchi.github.io/StencilDesigner3/](https://toshihiroiguchi.github.io/StencilDesigner3/)

---

## Table of Contents

- [Features](#features)
- [Screenshots](#screenshots)
- [Requirements](#requirements)
- [Installation](#installation)
- [Starting the App](#starting-the-app)
- [Build for Production](#build-for-production)
- [Running Tests](#running-tests)
- [Usage Guide](#usage-guide)
  - [Drawing Tools](#drawing-tools)
  - [Edit Operations](#edit-operations)
  - [Boolean Operations](#boolean-operations)
  - [DXF Import / Export](#dxf-import--export)
  - [Design Rule Check (DRC)](#design-rule-check-drc)
  - [View Controls](#view-controls)
  - [Keyboard Shortcuts](#keyboard-shortcuts)
- [Architecture](#architecture)
- [Tech Stack](#tech-stack)
- [Contributing](#contributing)
- [License](#license)

---

## Features

| Category | Details |
|---|---|
| **Drawing** | Rectangle, Circle (64-sided polygon approximation), free Polygon, Fillet tool |
| **Editing** | Move, Copy with offset, Array copy (nx × ny grid), Delete |
| **Boolean ops** | Union (merge), Difference (subtract) via Clipper-lib |
| **DXF I/O** | Import LWPOLYLINE / LINE entities from DXF; export all shapes as LWPOLYLINE |
| **DRC** | Minimum aperture check (narrowest passage width), minimum spacing check, overlap detection |
| **Properties** | Numeric X / Y position and W / H size editing in the right panel |
| **Grid** | Adaptive major grid + 1/5 sub-grid; snaps to grid, vertices, and midpoints |
| **Rulers** | Horizontal and vertical rulers with major and minor tick marks |
| **History** | 50-level undo / redo |
| **Persistence** | Auto-save to IndexedDB (survives page refresh) |
| **Theme** | Dark / Light mode toggle |
| **Coordinate system** | Integer µm (micrometers) throughout; no floating-point geometry |

---

## Requirements

| Tool | Version |
|---|---|
| [Node.js](https://nodejs.org/) | 18.x or later (20.x recommended) |
| npm | 9.x or later (bundled with Node.js) |
| Modern browser | Chrome 110+, Firefox 110+, Edge 110+ |

> **Note:** The app runs entirely in the browser. Node.js / npm are only needed to build and run the development server.

---

## Installation

### 1. Clone the repository

```bash
git clone https://github.com/ToshihiroIguchi/StencilDesigner3.git
cd StencilDesigner3
```

If you do not have Git, you can also download the ZIP from the GitHub repository page:
`Code → Download ZIP`, then extract and open a terminal in the extracted folder.

### 2. Install dependencies

```bash
npm install
```

This downloads all runtime and development dependencies listed in `package.json` into the `node_modules/` directory. An internet connection is required for the first run.

Expected output (abbreviated):

```
added 312 packages, and audited 313 packages in 12s
found 0 vulnerabilities
```

---

## Starting the App

### Development server (recommended for daily use)

```bash
npm run dev
```

Vite starts a hot-reloading development server. Open the URL shown in the terminal (typically **http://localhost:5173**) in your browser.

```
  VITE v5.x.x  ready in 300 ms

  ➜  Local:   http://localhost:5173/
  ➜  Network: use --host to expose
```

- Edits to source files are reflected in the browser instantly (Hot Module Replacement).
- The server stays running until you press `Ctrl + C`.

### Preview server (test the production build locally)

If you want to run the optimized production build locally before deploying:

```bash
npm run build      # Build first (outputs to dist/)
npm run preview    # Serve the built files
```

Open **http://localhost:4173** in your browser.

---

## Build for Production

```bash
npm run build
```

Output is written to the `dist/` directory. The contents of `dist/` are self-contained static files (HTML, JS, CSS, assets) that can be deployed to any static hosting service (GitHub Pages, Netlify, Vercel, S3, nginx, etc.).

### Build with a custom base path (e.g., GitHub Pages sub-directory)

```bash
VITE_BASE=/StencilDesigner3/ npm run build
```

This is used by the included GitHub Actions workflow (`.github/workflows/deploy.yml`) to deploy to `https://<username>.github.io/StencilDesigner3/`.

---

## Running Tests

### Unit tests (Vitest)

```bash
npm run test:unit
```

Runs 63 fast, headless unit tests covering geometry, normalization, DRC, state history, and the polygon tool.

```
 ✓ tests/unit/normalize.test.ts    (12 tests)
 ✓ tests/unit/transform.test.ts    (6 tests)
 ✓ tests/unit/drc.test.ts          (12 tests)
 ✓ tests/unit/geometry.test.ts     (11 tests)
 ✓ tests/unit/state.test.ts        (9 tests)
 ✓ tests/unit/polygon-tool.test.ts (13 tests)

 Test Files  6 passed (6)
       Tests  63 passed (63)
```

To run in watch mode (re-runs on file change):

```bash
npm run test:unit:watch
```

### End-to-end tests (Playwright)

E2E tests launch a real browser and exercise the full application UI. They require the production build to be available.

```bash
npm run build           # Build the app first
npm run test:e2e        # Run Playwright tests (Chromium + Firefox)
```

On the first run, Playwright will prompt you to install browser binaries:

```bash
npx playwright install --with-deps
```

HTML test reports are written to `playwright-report/`. Open `playwright-report/index.html` in a browser to view results.

### Run all tests

```bash
npm test
```

This runs unit tests followed by E2E tests.

---

## Usage Guide

### Drawing Tools

Select tools from the **left toolbar** or press the keyboard shortcut.

#### Select (V)
- **Click** a shape to select it.
- **Drag** on empty canvas to rubber-band-select multiple shapes.
- **Drag** a selected shape to move it.
- With a shape selected, the **right panel** shows X / Y / W / H inputs for precise positioning.

#### Rectangle (R)
- **Click** to set the first corner, then **drag** (or click again) to set the opposite corner.
- Release to commit the rectangle.

#### Circle (C)
- **Click** to set the center, **drag** to set the radius.
- Circles are stored as 64-sided polygons (standard CAD approximation).

#### Polygon (P)
- **Click** to add vertices one by one.
- Hover near the first vertex to see the close-snap highlight (white ring).
- **Enter** or **click the first vertex** to close and commit the polygon.
- **Backspace** removes the last placed vertex.
- **Esc** cancels the current polygon.

#### Fillet (F)
- Select a polygon, then switch to the Fillet tool.
- The right panel shows the fillet radius input (`R`, in µm).
- **Click** a vertex to apply the fillet to that corner.
- **Apply to all corners** button rounds every eligible corner at once.
- Use **mouse wheel** while hovering a vertex to adjust the radius in real time.
- Vertices are color-coded: green = applicable, yellow = skippable (too small), red = invalid (would cross edges).

### Edit Operations

#### Delete (Del)
Select one or more shapes, then press `Del` / `Backspace`, or click **Delete** in the toolbar.

#### Copy
Select shapes, click **Copy** in the toolbar, enter the offset in µm as `X,Y` (e.g. `1000,0` for 1 mm to the right).

#### Array
Select shapes, click **Array**, then enter `nx,ny,pitchX,pitchY` in µm (e.g. `3,4,2000,2000` for a 3 × 4 grid at 2 mm pitch).

### Boolean Operations

#### Union
Select **2 or more** shapes and click **Union**. All selected shapes are merged into a single polygon.

#### Difference
1. Click **Diff** in the toolbar.
2. Click the **BASE** shape (the one to keep).
3. Click the **CUT** shape (the one to subtract from BASE).
4. The CUT shape is removed from the BASE, leaving a hole.
5. Press **Esc** at any point to cancel.

### DXF Import / Export

#### Import
Click **Import** in the header and select a `.dxf` file.
Supported entities: `LWPOLYLINE`, `LINE`. Closed polylines and line loops are converted to polygons.

#### Export
Click **Export**. A `stencil.dxf` file is downloaded containing all shapes as `LWPOLYLINE` entities in one layer (`0`).

### Design Rule Check (DRC)

The DRC panel is always visible in the **right panel**. DRC runs automatically every time the canvas re-renders.

| Parameter | Default | Description |
|---|---|---|
| **Min aperture** | 30 µm | Minimum narrowest-passage width of a single shape. Catches thin arms in L-shapes that a bounding-box check would miss. |
| **Min spacing** | 30 µm | Minimum edge-to-edge distance between any two shapes. |

- **Error** (red dashed outline): aperture too small, or shapes overlap.
- **Warning** (yellow): shapes are closer than the min spacing threshold.
- Click an error in the DRC list to pan the view to the violation location.
- Settings are persisted to IndexedDB and survive page refresh.

### View Controls

| Action | Method |
|---|---|
| **Pan** | Middle-mouse drag, or hold `Space` + left-drag |
| **Zoom in / out** | Mouse wheel |
| **Fit to content** | Click **Fit** in header, or press `Home` |
| **Reset zoom to 100%** | Click the **Zoom%** label in the footer |
| **Toggle grid snap** | Click **Snap** in header |
| **Toggle theme** | Click **Theme** in header |
| **Undo** | `Ctrl+Z` (50 levels) |
| **Redo** | `Ctrl+Y` or `Ctrl+Shift+Z` |
| **Clear all** | Click **Clear** in header (confirmation required) |

### Keyboard Shortcuts

| Key | Action |
|---|---|
| `V` | Select tool |
| `R` | Rectangle tool |
| `C` | Circle tool |
| `P` | Polygon tool |
| `F` | Fillet tool |
| `Del` / `Backspace` | Delete selected shapes |
| `Ctrl+Z` | Undo |
| `Ctrl+Y` / `Ctrl+Shift+Z` | Redo |
| `Home` | Fit all shapes in view |
| `Esc` | Cancel current operation |
| `Enter` | Commit polygon (while drawing) |

---

## Architecture

```
src/
├── types.ts              — Point, Ring, Polygon, AppState, Command interfaces
├── normalize/            — Polygon cleanup (dedup, collinear removal, winding order)
├── core/
│   ├── geometry.ts       — Shape factories, snap, distance, DRC geometry helpers
│   ├── selection.ts      — Hit testing and snap point resolution
│   ├── transform.ts      — Move / copy / delete / array operations
│   ├── boolean.ts        — Union / difference via Clipper-lib
│   ├── fillet.ts         — Arc interpolation and fillet geometry
│   └── drc.ts            — Design rule checks (aperture, spacing, overlap)
├── state/
│   ├── commands.ts       — Command implementations (AddShape, Delete, Union, …)
│   ├── history.ts        — Undo / redo stack (max 50)
│   └── autosave.ts       — IndexedDB persistence via localforage
├── canvas/
│   └── renderer.ts       — Canvas 2D rendering (grid, rulers, shapes, DRC markers)
├── tools/
│   ├── base.ts           — BaseTool abstract class
│   ├── select.ts         — Selection, move, rubber-band
│   ├── rect.ts           — Rectangle drawing
│   ├── circle.ts         — Circle drawing
│   ├── polygon.ts        — Free polygon drawing
│   └── fillet.ts         — Fillet tool with vertex-click and radius adjustment
├── dxf/
│   ├── importer.ts       — DXF text → Polygon[] pipeline
│   └── exporter.ts       — Polygon[] → DXF LWPOLYLINE text
├── ui/
│   └── app.ts            — Main App class wiring tools, state, and UI
└── main.ts               — Entry point
```

**Key design decisions:**

- **Integer µm coordinates everywhere.** All `Point` values are integers in micrometers. Floating-point only appears transiently during mouse-to-world conversion (`Math.round` is applied immediately).
- **Command pattern.** Every user edit is a `Command { do, undo }`. View changes (zoom, pan) are not commands and are not undoable.
- **`normalize()` after every edit.** Ensures polygons always have a CCW outer ring, no duplicates, and no collinear points.

---

## Tech Stack

| Role | Library / Tool |
|---|---|
| Build tool | [Vite](https://vitejs.dev/) 5.x |
| Language | [TypeScript](https://www.typescriptlang.org/) 5.x (strict mode) |
| Rendering | HTML5 Canvas 2D |
| Boolean geometry | [Clipper-lib](https://github.com/junmer/clipper-lib) 6.x |
| DXF import | [dxf-parser](https://github.com/gdsestimating/dxf-parser) 1.x |
| DXF export | Custom LWPOLYLINE writer |
| Persistence | [localforage](https://localforage.github.io/localForage/) 1.x (IndexedDB) |
| Unit tests | [Vitest](https://vitest.dev/) 1.x |
| E2E tests | [Playwright](https://playwright.dev/) 1.x |
| CI / CD | GitHub Actions (unit tests, E2E tests, GitHub Pages deploy) |

---

## Contributing

1. Fork the repository and create a feature branch.
2. Make your changes — keep all coordinates as integers in µm, call `normalize()` after any geometric edit, and avoid `any` types.
3. Run `npm run test:unit` and confirm all 63 tests pass.
4. Open a pull request with a clear description of the change.

---

## License

MIT License

Copyright (c) 2024 Toshihiro Iguchi

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
