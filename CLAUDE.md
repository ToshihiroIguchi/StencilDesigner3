# StencilDesigner3 Project Guidelines

## Project Overview
A browser-based 2D CAD editor for stencil/screen-printing mask design.
Static web app (SPA, pure front-end) with DXF I/O. No backend required.

## Tech Stack
- **Build:** Vite + TypeScript (strict mode)
- **Geometry:** integer µm coordinates, Clipper-lib for boolean ops
- **DXF:** `dxf-parser` (import), custom LWPOLYLINE writer (export)
- **Storage:** localforage (IndexedDB)
- **Rendering:** HTML5 Canvas 2D
- **Tests:** Vitest (unit) + Playwright (E2E)

## Core Principles

### Integer geometry only
All coordinates are integers in micrometers (µm). No floating-point in geometric calculations.
Use `Math.round()` whenever converting from float sources (mouse coords, DXF).

### Topology safety
Always call `normalize()` after any geometric edit. A Polygon must have:
- `outer`: CCW ring, no self-intersections, no duplicates
- `holes`: CW rings, each inside outer

### DXF as I/O only
Never use DXF entities as internal geometry. Always convert to Polygon on import.

### Command-based state
Every user action must implement `Command { do(state), undo(state) }`.
View-only changes (zoom, pan) are NOT commands and not undoable.

### No floating-point in geometry
Bad:  `x = mouseX / zoom`  (float)
Good: `x = Math.round(mouseX / zoom)`  (integer)

## Architecture

```
src/
  types.ts          — Point, Ring, Polygon, AppState, Command interfaces
  normalize/        — Polygon cleanup (dedup, collinear removal, orientation)
  core/
    geometry.ts     — Shape factories (rectToPolygon, circleToPolygon, ...)
    selection.ts    — Hit testing and snap point finding
    transform.ts    — move/copy/delete/arrayCopy
    boolean.ts      — union/difference via Clipper-lib
  state/
    commands.ts     — Concrete Command implementations
    history.ts      — Undo/redo stack (max 50)
    autosave.ts     — IndexedDB persistence via localforage
  canvas/
    renderer.ts     — Canvas 2D rendering (grid, shapes, rulers, drafts)
  tools/
    base.ts         — BaseTool abstract class
    select.ts       — Selection and move via drag
    rect.ts         — Rectangle drawing
    line.ts         — Line drawing (as thin rectangle)
    circle.ts       — Circle drawing (N-gon approximation)
  dxf/
    importer.ts     — DXF text → Polygon[] pipeline
    exporter.ts     — Polygon[] → DXF LWPOLYLINE text
  ui/
    app.ts          — Main App class tying everything together
  main.ts           — Entry point
  styles.css        — 3-column layout CSS
```

## Coordinate System
- World: µm integers, Y+ = down (screen convention)
- Canvas: pixels, transformed by `zoom` and `(panX, panY)`
- `canvasToWorld(px, py, vt)` and `worldToCanvas(wx, wy, vt)` for conversion

## Prohibited
- No floating-point coordinates in Polygon/Ring/Point
- Do not skip `normalize()` after edits
- No `any` types unless interfacing with external JS libraries (mark with comment)
- Keep all code and comments in English

## Running
```sh
npm install
npm run dev        # Development server
npm run build      # Production build
npm run test:unit  # Vitest unit tests
npm run test:e2e   # Playwright E2E (requires built app or dev server)
```
