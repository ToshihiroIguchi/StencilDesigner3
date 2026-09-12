# StencilDesigner3 Project Guidelines (Gemini Session)

## Project Overview
A browser-based 2D CAD editor for screen-printing mask design.
Static web app (SPA, pure front-end) with DXF / DWG import and DXF / PDF export. No backend required.

## Tech Stack
- **Build:** Vite + TypeScript (strict mode)
- **Geometry:** integer µm coordinates, Clipper-lib for boolean ops
- **DXF:** `dxf-parser` (import), `@tarikjabiri/dxf` / custom LWPOLYLINE & MTEXT writer (export)
- **DWG:** GNU LibreDWG via `@mlightcad/libredwg-web` (WebAssembly worker)
- **PDF:** `jspdf` (vector export with Noto Sans JP font embedding)
- **Fonts:** `opentype.js` (Big Shoulders Stencil Display to aperture polygons)
- **Storage:** localforage (IndexedDB multi-document store & autosave)
- **Rendering:** HTML5 Canvas 2D
- **Tests:** Vitest (unit) + Playwright (E2E)

## Core Principles

### 1. Integer geometry only
All coordinates are integers in micrometers (µm). No floating-point in geometric calculations.
Use `Math.round()` whenever converting from float sources (mouse coords, DXF).

### 2. Topology safety
Always call `normalize()` after any geometric edit. A Polygon must have:
- `outer`: CCW ring, no self-intersections, no duplicates
- `holes`: CW rings, each inside outer

### 3. DXF as I/O only
Never use DXF entities as internal geometry. Always convert to Polygon on import.

### 4. Command-based state
Every user action must implement `Command { do(state), undo(state) }`.
View-only changes (zoom, pan) are NOT commands and not undoable.

### 5. No floating-point in geometry
- Bad:  `x = mouseX / zoom`  (float)
- Good: `x = Math.round(mouseX / zoom)`  (integer)

---

## Architecture

```
src/
  types.ts          — Point, Ring, Polygon, AppState, Command, Dimension, Annotation
  config.ts         — Application branding and file configuration
  normalize/        — Polygon cleanup (dedup, collinear removal, orientation)
  core/
    geometry.ts     — Shape factories, distance, DRC geometry helpers
    selection.ts    — Hit testing and snap point finding
    transform.ts    — move/resize/copy/delete/array
    boolean.ts      — union/difference via Clipper-lib
    fillet.ts       — fillet corner rounding
    cut.ts          — line-based polygon slicing
    drc.ts          — Design Rule Check (aperture, spacing, overlap)
    snap.ts         — Proximity smart snapping
    anchor-from-snap.ts — Snap to dimension anchor resolution
    dimension-resolve.ts — Dynamic dimension anchor tracking
    centerline-geometry.ts — Parallel edge centerline computation
    font-loader.ts  — OpenType font loading
    text-to-polygon.ts — Font glyph to aperture polygon conversion
    format.ts       — Coordinate formatting and mm/µm unit conversions
    vertex.ts       — Persistent vertex identity management
  state/
    commands.ts     — Concrete Command implementations
    history.ts      — Undo/redo stack (max 50)
    autosave.ts     — Preferences persistence via localforage
    docStore.ts     — Multi-document IndexedDB persistence and auto-save
  canvas/
    renderer.ts     — Canvas 2D rendering (grid, shapes, rulers, dimensions, DRC markers)
  tools/
    base.ts         — BaseTool abstract class & ToolContext
    select.ts       — Selection and move with proximity snap guidelines
    rect.ts         — Rectangle drawing and numeric placement
    circle.ts       — Circle drawing (64-gon approximation)
    polygon.ts      — Free polygon drawing
    fillet.ts       — Fillet corner rounding tool
    text.ts         — Text-to-polygon placement tool
    cut.ts          — Slice / cut shapes along a line
    measure.ts      — Distance measurement tool
    dimension.ts    — Linear dimensioning (horizontal / vertical)
    centerline.ts   — Edge-to-edge centerline tool
    arrow.ts        — Leader arrow tool
    annotation.ts   — Text note annotation tool
    textarea-overlay.ts — Floating in-place text entry overlay helper
  dxf/
    importer.ts     — DXF text → Polygon[] pipeline
    exporter.ts     — Polygon[] → DXF LWPOLYLINE & MTEXT text
    aci.ts          — AutoCAD Color Index (ACI) lookup table
  dwg/
    libredwg.ts     — Lazy WASM loader for GNU LibreDWG
    importer.ts     — DWG database → Polygon[] pipeline
    blocks.ts       — Affine transforms & recursive block expansion
    worker.ts       — Web Worker DWG decoding
  pdf/
    exporter.ts     — Vector A4 PDF export via jsPDF
  ui/
    app.ts          — Main App class tying everything together
    fileManager.ts  — Document manager modal controller
    layerPanel.ts   — Layer list and controls UI
    menus.ts        — Dropdown menus (File, Zoom presets)
    modals.ts       — Generic modal dialogs
    panelBindings.ts — Two-way properties panel bindings
    rightPanel.ts   — Right panel section visibility manager
  main.ts           — Entry point
  styles.css        — Application styling
```

---

## Coordinate System
- World: µm integers, Y+ = down (screen convention)
- Canvas: pixels, transformed by `zoom` and `(panX, panY)`
- `canvasToWorld(px, py, vt)` and `worldToCanvas(wx, wy, vt)` for conversion

## Prohibited
- No floating-point coordinates in Polygon/Ring/Point
- Do not skip `normalize()` after edits
- No `any` types unless interfacing with external JS libraries (mark with comment)
- Conduct all chat interactions with the user in Japanese. Code, comments, documentation, UI strings, and identifiers must all be in standard English.
- Git commit messages and pull request content (titles AND bodies) must be written entirely in English. Do not include Japanese in commit messages or PR descriptions, even when quoting Japanese source/doc text — paraphrase such references in English instead.
- When using high-cost models (e.g., Fable, Opus), restrict their usage to planning, orchestration, and high-difficulty implementation tasks. For all other tasks, utilize subagents.

---

## Running Commands
```sh
npm install
npm run dev        # Development server
npm run build      # Production build
npm run test:unit  # Vitest unit tests
npm run test:e2e   # Playwright E2E (requires built app or dev server)
```
