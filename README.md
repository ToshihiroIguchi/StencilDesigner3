# StencilDesigner3

A browser-based 2D CAD editor for screen-printing stencil / solder-paste mask design.
No installation, no backend — open the page and start drawing.

> **Live demo:** [https://toshihiroiguchi.github.io/StencilDesigner3/](https://toshihiroiguchi.github.io/StencilDesigner3/)

---

## Table of Contents

- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Starting the App](#starting-the-app)
- [Build for Production](#build-for-production)
- [Running Tests](#running-tests)
- [Usage Guide](#usage-guide)
  - [Drawing Tools](#drawing-tools)
  - [Annotations and Dimensions](#annotations-and-dimensions)
  - [Edit Operations](#edit-operations)
  - [Boolean Operations](#boolean-operations)
  - [Document Management & File I/O](#document-management--file-io)
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
| **Drawing** | Rectangle (Box), Circle (64-sided polygon approximation), free Polygon, Fillet tool, Text tool (stencil font converted to aperture polygons via opentype.js), Slice tool (cut polygons along a straight line) |
| **Editing** | Move, Duplicate / Array dialog (nx × ny grid with pitch), Clipboard operations (Cut, Copy, Paste, Duplicate), Delete |
| **Annotations / Dimensions** | Interactive linear dimensions (horizontal & vertical with smart anchors tracking geometry), Centerlines between parallel edges, Leader arrows, Text notes (exported to DXF as MTEXT), Distance measurement tool |
| **Boolean ops** | Union (merge), Difference (subtract) via Clipper-lib |
| **DXF I/O** | Import LWPOLYLINE / LINE entities from DXF; export all shapes as LWPOLYLINE and text notes as MTEXT |
| **DWG import** | Import DWG drawings (LINE / LWPOLYLINE / POLYLINE / ARC / CIRCLE / ELLIPSE / SPLINE, plus INSERT / MINSERT block expansion) via the bundled GNU LibreDWG (WebAssembly), decoded off the main thread in a Web Worker |
| **PDF export** | Production-ready vector PDF export (A4 auto-orientation, scale ratio & scale bar, layers, dimensions, notes, Japanese font embedding via Noto Sans JP) |
| **DRC** | Minimum aperture check (narrowest passage width), minimum spacing check, overlap detection |
| **Properties** | Numeric X / Y position and W / H size editing in the right panel |
| **Grid & Snapping** | Adaptive major grid + 1/5 sub-grid; smart proximity corner-to-corner snapping, vertex/edge/center/midpoint snap, temporary reference point (G / O) |
| **Rulers** | Horizontal and vertical rulers with major and minor tick marks |
| **Document management** | Multi-document manager (IndexedDB docStore), document renaming, storage usage tracking, local `.stencil` file save & open |
| **History** | 50-level undo / redo |
| **Persistence** | Auto-save to IndexedDB (survives page refresh) |
| **Theme & Units** | Dark / Light mode toggle; switchable display units (mm / µm) |
| **Coordinate system** | Integer µm (micrometers) throughout; no floating-point geometry |

---

## Requirements

| Tool | Version |
|---|---|
| [Node.js](https://nodejs.org/) | 18.x or later (20.x recommended) |
| npm | 9.x or later (bundled with Node.js) |
| Modern browser | Chrome 110+, Firefox 110+, Edge 110+ |
| [Python](https://www.python.org/) | 3.7 or later (optional — only needed for the Python HTTP server method) |

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

### Python built-in HTTP server (no Node.js required at runtime)

If you have Python 3 installed but prefer not to keep Node.js running, you can serve the
pre-built static files with Python's built-in HTTP server.

**Step 1 — Build the production files** (requires Node.js / npm, one-time)

```bash
npm run build
```

Output is written to the `dist/` directory.

**Step 2 — Start the Python HTTP server**

```bash
# Windows (Command Prompt / PowerShell)
python -m http.server 8000 --directory dist

# macOS / Linux
python3 -m http.server 8000 --directory dist
```

Open **http://localhost:8000** in your browser.

> **Note:** The `--directory` flag requires Python 3.7 or later.
> For older versions, `cd dist` first, then run `python3 -m http.server 8000`.

**Specify a different port**

```bash
python -m http.server 9090 --directory dist
```

Open **http://localhost:9090**.

**Stop the server**

Press `Ctrl + C` in the terminal.

### Running on a Python-only machine (no Node.js at all)

The build step above needs Node.js, but the **target machine that actually runs the app
does not**. You can build the `dist/` folder once on any machine that has Node.js, then
copy it to a Python-only machine and serve it there. The app is fully self-contained —
`dist/` has no external runtime dependencies.

**Step 1 — Obtain the `dist/` folder** (choose one)

- **Download a pre-built archive (recommended — no Node.js needed)** from the
  [Releases page](https://github.com/ToshihiroIguchi/StencilDesigner3/releases).
  Each release includes a `stencildesigner3-dist-<version>.zip` asset that is built
  automatically by GitHub Actions and ready to serve as-is.

  ```bash
  unzip stencildesigner3-dist-v1.0.0.zip   # extracts a dist/ folder
  ```

- **Build it yourself** on a machine with Node.js:

  ```bash
  npm install
  npm run build
  ```

**Step 2 — Transfer `dist/` to the Python-only machine**

Copy the entire `dist/` directory by any means — USB drive, `scp`, a shared folder,
or a zip archive. No other files from the repository are needed.

```bash
# Example: zip on the build machine, unzip on the target
zip -r dist.zip dist        # build machine
unzip dist.zip              # target machine
```

(If you downloaded the release archive in Step 1, it already contains `dist/` — just
copy that folder over.)

**Step 3 — Serve it with Python on the target machine**

```bash
# Windows (Command Prompt / PowerShell)
python -m http.server 8000 --directory dist

# macOS / Linux
python3 -m http.server 8000 --directory dist
```

Open **http://localhost:8000** in your browser. Node.js is never installed on this machine.

> **Tip:** To let other machines on the same network reach it, the built-in server already
> binds to all interfaces by default; open `http://<this-machine-ip>:8000` from another device.

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

Runs 241 fast, headless unit tests covering geometry, normalization, DRC, layers, DXF / DWG I/O, PDF export, state history, and tools.

```
 ✓ tests/unit/...                  (19 test files)

 Test Files  19 passed (19)
       Tests  241 passed (241)
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

#### Text (T)
- Switch to the Text tool or press `T`.
- Configure the text size (cap-height in mm) and letter spacing in the right panel.
- Click the canvas to open an in-place text entry box.
- Press **Enter** to convert the text into stencil aperture polygons using the bundled *Big Shoulders Stencil Display* font, or **Esc** to cancel.

#### Fillet (F)
- Select a polygon, then switch to the Fillet tool.
- The right panel shows the fillet radius input (`R`, in µm).
- **Click** a vertex to apply the fillet to that corner.
- **Apply to all corners** button rounds every eligible corner at once.
- Use **mouse wheel** while hovering a vertex to adjust the radius in real time.
- Vertices are color-coded: green = applicable, yellow = skippable (too small), red = invalid (would cross edges).

#### Slice / Cut (K)
- Switch to the Slice tool or press `K`.
- **Click and drag** a cutting line across any shapes you want to split.
- Hold **Shift** while dragging to constrain the cutting angle in 15° increments.
- Release the mouse button to split the intersected polygons along the line.

### Annotations and Dimensions

#### Measure (M)
- Click the first point on the canvas, then move the mouse to measure the distance, $\Delta X$, and $\Delta Y$ to the second point in real time.
- Hold **Shift** to snap to 45° angle increments.
- Press **Esc** to clear the measurement.

#### Dimension (D)
- Click the first anchor point (snaps to vertex, midpoint, or edge).
- Click the second anchor point (hold **Shift** for 45° angle constraint).
- Move the mouse and click to place the dimension line offset (horizontal or vertical).
- Dimensions feature **smart anchors**: when connected to polygon vertices or edges, dimensions dynamically track the shape as it is moved or edited.

#### Centerline (L)
- Click the first edge of a shape.
- Click a second, parallel edge.
- A dashed centerline is generated midway between the two edges.

#### Arrow (A)
- Click and drag from the start point to the tip of the arrow.
- Hold **Shift** for 45° angle constraint.
- Creates an associative leader arrow line.

#### Note / Annotation (N)
- Click on the canvas to place a text note.
- Enter your note text (supports multi-line with Shift+Enter).
- Notes are displayed on the canvas, included in PDF exports, and exported to DXF as `MTEXT` entities.

### Edit Operations

#### Delete (Del)
Select one or more shapes, then press `Del` / `Backspace`, or click **Delete** in the toolbar.

#### Copy & Array Duplicate
- Click **Copy** in the toolbar or press `Ctrl+D` to open the duplicate dialog.
- Specify copies ($n_x \times n_y$) and pitch ($P_x, P_y$) in µm to replicate selected shapes across a rectangular grid.

#### Clipboard Operations
- **Select All:** `Ctrl+A`
- **Copy:** `Ctrl+C` copies selected shapes to the internal clipboard.
- **Cut:** `Ctrl+X` copies and deletes selected shapes.
- **Paste:** `Ctrl+V` pastes shapes with a slight offset.

### Boolean Operations

#### Union
Select **2 or more** shapes and click **Union**. All selected shapes are merged into a single polygon.

#### Difference
1. Click **Diff** in the toolbar.
2. Click the **BASE** shape (the one to keep).
3. Click the **CUT** shape (the one to subtract from BASE).
4. The CUT shape is removed from the BASE, leaving a hole.
5. Press **Esc** at any point to cancel.

### Document Management & File I/O

Import and export actions live in the **File** menu in the header. You can also **drag and drop** a `.dxf`, `.dwg`, or `.stencil` file onto the canvas.

#### Document Management
- **New Document:** Creates a blank document in the local workspace.
- **Open Document…:** Opens the document manager modal listing all local documents stored in IndexedDB, with storage space usage and per-document delete/rename options.
- **Open from Disk…:** Loads a previously saved `.stencil` or `.json` file from local disk.
- **Document Renaming:** Click the document name label in the header to rename the active document.

#### Import DXF
Choose **Import DXF…** from the File menu (or drop a `.dxf` file).
Supported entities: `LWPOLYLINE`, `LINE`. Closed polylines and line loops are converted to polygons.

#### Import DWG
Choose **Import DWG…** from the File menu (or drop a `.dwg` file). DWG files are decoded by the bundled GNU LibreDWG (WebAssembly) in a Web Worker, so the UI stays responsive on large drawings. Supported entities: `LINE`, `LWPOLYLINE`, `POLYLINE` (2D / 3D), `ARC`, `CIRCLE`, `ELLIPSE`, `SPLINE`, and `INSERT` / `MINSERT` block references (recursively expanded). Unsupported entity types are skipped and reported. All geometry is converted to integer-µm polygons through the same pipeline as DXF.

#### Export DXF
Choose **Export DXF** from the File menu to download shapes as `LWPOLYLINE` entities and notes as `MTEXT` entities on their corresponding layers. (DWG export is not supported.)

#### Export as PDF
Choose **Export as PDF** from the File menu to generate a clean, vector A4 document:
- Automatically selects portrait or landscape orientation based on drawing aspect ratio.
- Renders visible shape layers with their configured line types and colors.
- Embeds linear dimensions, centerlines, arrows, and multi-line notes.
- Includes a title bar, layer legend, scale ratio, and an adaptive scale bar respecting the chosen display unit (`mm` or `µm`).
- Dynamically loads and embeds Japanese font support (*Noto Sans JP*) when annotations or layer names contain Japanese characters.

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
| **Zoom in / out** | Mouse wheel, or `+` / `-` keys, or footer `+` / `−` buttons |
| **Zoom presets** | Click the **Zoom** label in the footer to select 5, 10, 50, 100, 500 px/mm, or Fit |
| **Fit to content** | Click **Fit** in header, or press `Home` |
| **Reset zoom** | Press `0` key |
| **Toggle grid snap** | Click **Snap** in header, or press `S` / `F9` |
| **Toggle units** | Click the **Unit** label in footer to switch between `mm` and `µm` |
| **Temporary reference point** | Press `G` to set a reference point at the cursor; press `O` to clear (displays $\Delta X, \Delta Y$ in footer) |
| **Toggle theme** | Click **Theme** in header |
| **Undo** | `Ctrl+Z` (50 levels) |
| **Redo** | `Ctrl+Y` or `Ctrl+Shift+Z` |
| **Reset document** | Click **Reset** in header (confirmation required) |
| **Help** | Click **Help** in header, or press `?` |

### Keyboard Shortcuts

| Key | Action |
|---|---|
| `V` | Select tool |
| `R` | Box / Rectangle tool |
| `C` | Circle tool |
| `P` | Polygon tool |
| `F` | Fillet tool |
| `T` | Text tool |
| `K` | Slice / Cut tool |
| `M` | Measure tool |
| `D` | Dimension tool |
| `L` | Centerline tool |
| `A` | Arrow tool |
| `N` | Note / Annotation tool |
| `Del` / `Backspace` | Delete selected shapes |
| `Ctrl+A` | Select all shapes |
| `Ctrl+C` | Copy selection to clipboard |
| `Ctrl+X` | Cut selection to clipboard |
| `Ctrl+V` | Paste clipboard selection |
| `Ctrl+D` | Array duplicate dialog |
| `Ctrl+Z` | Undo |
| `Ctrl+Y` / `Ctrl+Shift+Z` | Redo |
| `S` / `F9` | Toggle snap on / off |
| `G` / `O` | Set / clear temporary reference point |
| `Home` | Fit all shapes in view |
| `+` / `-` | Zoom in / out |
| `0` | Reset zoom |
| `Esc` | Cancel current operation, deselect, clear temporary reference point |
| `Enter` | Commit polygon or text placement |
| `?` | Show keyboard shortcuts help modal |

---

## Architecture

```
src/
├── types.ts              — Point, Ring, Polygon, AppState, Command, Dimension, Annotation
├── config.ts             — Application branding and file-naming configuration
├── normalize/            — Polygon cleanup (dedup, collinear removal, winding order)
├── core/
│   ├── geometry.ts       — Shape factories, snap, distance, DRC geometry helpers
│   ├── selection.ts      — Hit testing and snap point resolution
│   ├── transform.ts      — Move / resize / copy / delete / array operations
│   ├── boolean.ts        — Union / difference via Clipper-lib
│   ├── fillet.ts         — Arc interpolation and fillet geometry
│   ├── cut.ts            — Slice/cut polygon splitting along lines
│   ├── drc.ts            — Design rule checks (aperture, spacing, overlap)
│   ├── snap.ts           — Proximity smart snapping core
│   ├── anchor-from-snap.ts — Associative dimension anchor resolution from snaps
│   ├── dimension-resolve.ts — Runtime anchor tracking for dynamic dimensions
│   ├── centerline-geometry.ts — Midline calculation between parallel edges
│   ├── font-loader.ts    — Lazy OpenType font loader (Big Shoulders Stencil)
│   ├── text-to-polygon.ts — Glyphs to aperture polygon conversion
│   ├── format.ts         — Coordinate and unit formatting (mm / µm)
│   └── vertex.ts         — Persistent vertex identity management
├── state/
│   ├── commands.ts       — Command implementations (AddShape, Delete, Move, Resize, Cut, …)
│   ├── history.ts        — Undo / redo stack (max 50)
│   ├── autosave.ts       — Application preferences persistence via localforage
│   └── docStore.ts       — Multi-document IndexedDB persistence and auto-save
├── canvas/
│   └── renderer.ts       — Canvas 2D rendering (grid, rulers, shapes, dimensions, DRC markers)
├── tools/
│   ├── base.ts           — BaseTool abstract class and ToolContext
│   ├── select.ts         — Selection, move, rubber-band, proximity guide lines
│   ├── rect.ts           — Rectangle / box drawing and numeric placement
│   ├── circle.ts         — Circle drawing and numeric placement
│   ├── polygon.ts        — Free polygon drawing
│   ├── fillet.ts         — Fillet tool with vertex-click and radius adjustment
│   ├── text.ts           — Text-to-polygon stencil placement tool
│   ├── cut.ts            — Slice / cut tool for splitting shapes with a line
│   ├── measure.ts        — Interactive two-point measurement tool
│   ├── dimension.ts      — Associative linear dimension tool (H / V)
│   ├── centerline.ts     — Centerline tool between parallel edges
│   ├── arrow.ts          — Leader arrow drawing tool
│   ├── annotation.ts     — Text note annotation tool
│   └── textarea-overlay.ts — Floating in-place text entry overlay helper
├── dxf/
│   ├── importer.ts       — DXF text → Polygon[] pipeline
│   ├── exporter.ts       — Polygon[] → DXF LWPOLYLINE / MTEXT text
│   └── aci.ts            — AutoCAD Color Index (ACI) lookup table
├── dwg/
│   ├── libredwg.ts       — Lazy WASM loader for GNU LibreDWG
│   ├── importer.ts       — DWG database → Polygon[] conversion
│   ├── blocks.ts         — Affine transforms and INSERT block expansion
│   └── worker.ts         — Off-main-thread DWG decoding (Web Worker)
├── pdf/
│   └── exporter.ts       — Vector PDF generation via jsPDF with font embedding
├── ui/
│   ├── app.ts            — Main App class wiring tools, state, and UI
│   ├── fileManager.ts    — Document manager modal controller
│   ├── layerPanel.ts     — Layer management UI (visibility, locking, colors)
│   ├── menus.ts          — Dropdown menus (File, Zoom presets)
│   ├── modals.ts         — Generic dialogs (alerts, prompts, confirm)
│   ├── panelBindings.ts  — Two-way bindings for right-side properties panel
│   └── rightPanel.ts     — Dynamic right panel section visibility
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
| DXF export | Custom LWPOLYLINE / MTEXT writer with [@tarikjabiri/dxf](https://github.com/tarikjabiri/dxf) |
| DWG import | [GNU LibreDWG](https://www.gnu.org/software/libredwg/) via [@mlightcad/libredwg-web](https://github.com/mlightcad/libredwg-web) (WebAssembly) |
| PDF export | [jsPDF](https://github.com/parallax/jsPDF) 4.x with Noto Sans JP font embedding |
| Font & glyphs | [opentype.js](https://opentype.js.org/) 2.x (*Big Shoulders Stencil Display*) |
| Persistence | [localforage](https://localforage.github.io/localForage/) 1.x (IndexedDB) |
| Unit tests | [Vitest](https://vitest.dev/) 1.x |
| E2E tests | [Playwright](https://playwright.dev/) 1.x |
| CI / CD | GitHub Actions (unit tests, E2E tests, GitHub Pages deploy) |

---

## Contributing

1. Fork the repository and create a feature branch.
2. Make your changes — keep all coordinates as integers in µm, call `normalize()` after any geometric edit, and avoid `any` types.
3. Run `npm run test:unit` and confirm all 241 tests pass.
4. Open a pull request with a clear description of the change.

---

## License

Copyright (c) 2026 Toshihiro Iguchi

StencilDesigner3 is licensed under the **GNU General Public License v3.0 or later
(GPL-3.0-or-later)**. See the [`LICENSE`](./LICENSE) file for the full text.

This project bundles [GNU LibreDWG](https://www.gnu.org/software/libredwg/) (via
[`@mlightcad/libredwg-web`](https://github.com/mlightcad/libredwg-web)) to read
DWG files. LibreDWG is distributed under the GPL-3.0, and shipping it as part of
the served application makes the combined work subject to the GPL. The project was
previously distributed under the MIT License; releases that include the DWG import
feature are distributed under GPL-3.0-or-later.

The complete corresponding source for the distributed application is this
repository. The corresponding source for the bundled third-party components is
listed, with upstream links, in [`THIRD-PARTY-LICENSES.md`](./THIRD-PARTY-LICENSES.md).
