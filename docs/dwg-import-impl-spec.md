# DWG Import Implementation Specification

This document provides concrete, code-level implementation specifications based on `docs/dwg-import-plan.md`.
It establishes exact types, APIs, coordinate transformations, block expansions, and verification procedures.

> Core Principles:
> - Geometric coordinates are **integer micrometers (µm)**. Floating-point sources (DWG coordinates) must be converted with `Math.round`.
> - Always call `normalize()` / `normalizeAll()` after geometric edits.
> - DWG is for I/O only. Internal geometry is strictly represented as `Polygon`.
> - Code, comments, documentation, UI strings, and identifiers must all be in standard English.
> - PR titles, PR descriptions, and commit messages must follow conventional commits in English.
> - Dependencies introduced by this feature are under GPL-3.0. Fulfill GPL compliance requirements alongside dependency introduction.

---

## 0. Verified Library Details

- Package: `@mlightcad/libredwg-web@^0.7.2` (GPL-3.0)
- Usage (wrapper API):
  ```ts
  import { LibreDwg, Dwg_File_Type } from '@mlightcad/libredwg-web';
  const libredwg = await LibreDwg.create(wasmDir); // wasmDir = directory containing libredwg-web.wasm
  const dwg = libredwg.dwg_read_data(new Uint8Array(buf), Dwg_File_Type.DWG);
  const db  = libredwg.convert(dwg);   // => DwgDatabase
  // ... conversion ...
  libredwg.dwg_free(dwg);              // always free in a finally block
  ```
- WASM binary: `node_modules/@mlightcad/libredwg-web/wasm/libredwg-web.wasm` (6.3 MB).
  - `LibreDwg.create(filepath)` passes `${filepath}/libredwg-web.wasm` to `locateFile`.
  - In the browser, resolve via Vite's asset URL (`?url`) and supply the corresponding directory path (see §5).
- Note: `dwg_read_data` returns an `error` bit flag. **Low-order bits indicate non-fatal warnings; data can still be extracted**. Treat import as successful whenever entities are retrieved.

---

## 1. Verified Type Schemas (Derived from `.d.ts`)

`DwgDatabase` returned by `libredwg.convert(dwg)`:

```ts
interface DwgDatabase {
  tables: {
    BLOCK_RECORD: { entries: DwgBlockRecordTableEntry[] };
    LAYER:        { entries: DwgLayerTableEntry[] };
    LTYPE: ...; STYLE: ...; /* Other tables unused */
  };
  objects: { ... };          // Unused by this feature
  header:  DwgHeader;        // For future $INSUNITS reference
  entities: DwgEntity[];     // Model space entities (convenience flat array)
  classes:  DwgClass[];
}
```

Base and primary entity interfaces:

```ts
interface DwgEntity {
  type: string;            // 'LINE' | 'LWPOLYLINE' | 'POLYLINE2D' | 'ARC' | ...
  handle: string;
  layer: string;
  colorIndex?: number;     // Negative value indicates layer is off; 256 = BYLAYER
  lineType?: string;
  lineweight?: number;
  isInPaperSpace?: boolean;// Skip paper space entities
  isVisible?: boolean;
  ownerBlockRecordSoftId: string;
}

interface DwgPoint2D { x: number; y: number; }
interface DwgPoint3D { x: number; y: number; z: number; }

interface DwgLineEntity extends DwgEntity {           // 'LINE'
  startPoint: DwgPoint3D; endPoint: DwgPoint3D;
}

interface DwgLWPolylineEntity extends DwgEntity {     // 'LWPOLYLINE'
  flag: number;                                       // bit0(=1): closed
  vertices: DwgLWPolylineVertex[];
  elevation: number;
}
interface DwgLWPolylineVertex extends DwgPoint2D { id: number; bulge: number; startWidth?: number; endWidth?: number; }

interface DwgPolyline2dEntity extends DwgEntity {     // 'POLYLINE2D'
  flag: number;                                       // bit0(=1): closed
  vertices: DwgVertex2dEntity[];                      // DwgVertex2dEntity extends DwgPoint3D, { bulge, id, ... }
  elevation: number;
}
interface DwgPolyline3dEntity extends DwgEntity {     // 'POLYLINE3D'
  flag: number; vertices: DwgVertex3dEntity[];        // DwgVertex3dEntity extends DwgPoint3D
}

interface DwgArcEntity extends DwgEntity {            // 'ARC'
  center: DwgPoint3D; radius: number; startAngle: number; endAngle: number;
}
interface DwgCircleEntity extends DwgEntity {         // 'CIRCLE'
  center: DwgPoint3D; radius: number;
}
interface DwgEllipseEntity extends DwgEntity {        // 'ELLIPSE'
  center: DwgPoint3D; majorAxisEndPoint: DwgPoint3D;  // Vector relative to center
  axisRatio: number; startAngle: number; endAngle: number;
}
interface DwgSplineEntity extends DwgEntity {         // 'SPLINE'
  degree: number; controlPoints: DwgPoint3D[]; fitPoints: DwgPoint3D[];
  knots: number[]; weights?: number[];
}
interface DwgInsertEntity extends DwgEntity {         // 'INSERT'
  name: string;                                       // Referenced block name
  insertionPoint: DwgPoint3D;
  xScale: number; yScale: number; zScale: number;
  rotation: number;                                   // In radians (§8)
  columnCount: number; rowCount: number;
  columnSpacing: number; rowSpacing: number;
  attribs: DwgAttribEntity[];
}

interface DwgBlockRecordTableEntry {                  // Block definition
  name: string;                                       // e.g. '*Model_Space', 'MYBLOCK'
  basePoint: DwgPoint3D;                              // Block origin
  entities: DwgEntity[];                              // Entities within block
}

interface DwgLayerTableEntry {
  name: string; colorIndex: number; color: number;
  lineType: string; frozen: boolean; off: boolean;
  locked: boolean; plotFlag: number; lineweight: number;
}
```

> Block expansion key takeaway: Look up `INSERT.name` in `tables.BLOCK_RECORD.entries` by `name`, and recursively expand its `entities`.
> Model space is itself a block (`*Model_Space`). Using `db.entities` provides all model space entities directly, making `db.entities` the natural starting point for top-level processing.

---

## 2. Existing Code Reuse and Extraction (Refactoring)

Extract the downstream processing of `importDxf()` in `src/dxf/importer.ts` into a shared function:

```ts
// Added and exported in src/dxf/importer.ts
export function buildImportResult(
  segments: Array<{ seg: [Vertex, Vertex]; layer: string }>,
  closedRings: Array<{ ring: Ring; layer: string }>,
  rawLayers: Array<Partial<Layer> & { name: string; colorIndex?: number; frozen?: boolean; lineType?: string; lineweight?: number; locked?: boolean; plot?: boolean }>,
): ImportResult
```

Transferred logic:
- Chaining open segments by layer via `chainSegments`
- Combining with `closedRings` → `classifyAndBuildPolygons`
- Constructing the layer table (`aciToHex`, `normalizeLinetype`, `REGMARK` → `isAperture`)
- Backfilling missing layers referenced by entities
- Return: `{ polygons: normalizeAll(polygons), layers, ignoredCounts }`

`importDxf()` is then refactored to delegate to `buildImportResult()`, leaving only entity-reading logic DXF-specific.

Reusable helpers (exported as needed):
- `mmToUm(v)`: `Math.round(v * 1000)`
- `arcToPoints(cx, cy, r, startDeg, endDeg, ccw)`: Degree-based with Y-negation
- `bulgeToArcPoints(p1x, p1y, p2x, p2y, bulge)`
- `expandPolylineVerts(verts, isClosed)`
- Coordinate convention: DWG/DXF is Y-up, internal geometry is Y-down. **Invert Y upon ingestion** (`vertex(mmToUm(x), mmToUm(-y))`).

---

## 3. New Modules

### 3.1 `src/dwg/libredwg.ts` — WASM Lazy Loader
```ts
import wasmUrl from '@mlightcad/libredwg-web/wasm/libredwg-web.wasm?url';
import type { LibreDwg as LibreDwgType } from '@mlightcad/libredwg-web';

let instance: LibreDwgType | null = null;

export async function getLibreDwg(): Promise<LibreDwgType> {
  if (instance) return instance;
  const { LibreDwg } = await import('@mlightcad/libredwg-web');
  const dir = wasmUrl.slice(0, wasmUrl.lastIndexOf('/'));
  instance = await LibreDwg.create(dir);
  return instance;
}
```
> `create(dir)` fetches `${dir}/libredwg-web.wasm`. When Vite appends hashes via `?url`, override `locateFile` to return `wasmUrl` directly if needed (see §5).

### 3.2 `src/dwg/blocks.ts` — Transformation Matrices & Block Expansion
- 2x3 affine transformation matrix (µm integer rounding applied at the final stage).
- `INSERT` transforms: compose translation (`insertionPoint`) × rotation (`rotation`) × scale (`xScale/yScale`). Subtract `basePoint` before transforming.
- `MINSERT` (`columnCount/rowCount > 1`): replicate across row/column offsets.
- Recursive expansion (`visited: Set<blockName>` for cycle detection; maximum depth limit of 16).

```ts
export interface Mat { a: number; b: number; c: number; d: number; e: number; f: number; } // [[a, c, e], [b, d, f]]
export function identity(): Mat
export function multiply(m1: Mat, m2: Mat): Mat
export function apply(m: Mat, x: number, y: number): { x: number; y: number }
export function insertMatrix(ins: DwgInsertEntity, basePoint: DwgPoint3D): Mat
```

### 3.3 `src/dwg/importer.ts` — Core Ingestion
```ts
import type { ImportResult } from '../dxf/importer';
export async function importDwg(buf: ArrayBuffer): Promise<ImportResult>;
```
Pipeline:
1. `getLibreDwg()` → `dwg_read_data` → `convert` (`dwg_free` in a `finally` block).
2. Traverse `db.entities` (model space), filtering out `isInPaperSpace`.
3. Map each entity per §4 into `segments` and `closedRings` (converting coordinates to µm and inverting Y). Expand `INSERT` per §3.2 and recursively map child entities through the composed matrix.
4. Convert `db.tables.LAYER.entries` to `buildImportResult` format.
5. Return `buildImportResult(segments, closedRings, rawLayers)`.
6. Wrap entity conversions in `try/catch` to log errors, increment `ignoredCounts['_error']`, and continue.

---

## 4. Entity-to-Intermediate Representation Mapping

| Type | Mapping |
|---|---|
| `LINE` | `startPoint, endPoint` into a 2-vertex segment |
| `LWPOLYLINE` | `flag & 1` tests closure. Bulges via `bulgeToArcPoints`. Closed → `closedRings`, open → chained segments |
| `POLYLINE2D` | Same as LWPOLYLINE (vertices are `DwgVertex2dEntity` with `x, y, bulge`) |
| `POLYLINE3D` | Ignore z; x/y only; `flag & 1` tests closure |
| `ARC` | `arcToPoints(center.x, center.y, radius, startAngle, endAngle)` (convert radians to degrees via `* 180 / π`) → segment sequence |
| `CIRCLE` | `arcToPoints(..., 0, 360)` excluding duplicate endpoint → `closedRings` |
| `ELLIPSE` | Derive major axis length/angle from relative `majorAxisEndPoint`; derive minor axis via `axisRatio`. Subdivide parametrically over `startAngle` to `endAngle`. If full sweep, emit `closedRings` |
| `SPLINE` | Use `fitPoints` directly if present; otherwise evaluate `controlPoints` using de Boor / Catmull-Rom with chord-height subdivision. Closed flag emits `closedRings` |
| `INSERT` | Expand block per §3.2 (apply transform → recursively map child entities); ignore `attribs` |
| `POINT` | Ignored by default (optional registration mark support) |
| `SOLID` / `3DFACE` | Optional: corner vertices into rings |
| `HATCH` | Optional / low-priority: boundary paths into rings |
| Other (`TEXT`, `MTEXT`, `DIMENSION`, etc.) | Ignored; increment `ignoredCounts[type]` |

---

## 5. Vite / WASM Asset Configuration

- Direct URL resolution via `?url` import with `locateFile` override:
  ```ts
  instance = await LibreDwg.create();
  // Override locateFile via createModule if data: URL fallback occurs:
  // const { createModule } = await import('@mlightcad/libredwg-web/wasm/libredwg-web.js');
  // const mod = await createModule({ locateFile: () => wasmUrl });
  // instance = LibreDwg.createByWasmInstance(mod);
  ```
- Acceptance check: Ensure production builds isolate `libredwg-web.wasm` into a distinct asset chunk, omitted from the initial bundle.

---

## 6. Web Worker Architecture

- `src/dwg/worker.ts`: Receives `{ buf: ArrayBuffer }`, runs `importDwg`, and returns `ImportResult` (plain data) via `postMessage`. Errors return `{ error: string }`.
- Main thread spawns worker in `loadDwgFile`, displays progress spinner, and opens `showImportDialog(result)` upon completion.
- Ensure `ImportResult` is fully structured-cloneable (no functions, methods, or class instances).

---

## 7. UI Wiring (`src/ui/app.ts`)

- Add `dwg` extension check to file drop handler → call `this.loadDwgFile(file)`.
- Update file input `accept` filter to include `.dwg`. Add `importDwg()` handler to menu.
- `loadDwgFile(file)`: Read `file.arrayBuffer()`, delegate to worker, and pass result to `showImportDialog(result)`.
- On failure: display modal notification with reason and breakdown of `ignoredCounts`.
- Add "Source Code" and "License" links to About modal and footer (GPL §6).

---

## 8. Uncertainties Verified Empirically

All items verified through actual drawing fixtures (`example_2018.dwg`, etc.):

1. **Angular Units = Radians (Confirmed)**: `ARC.startAngle/endAngle`, `ELLIPSE.startAngle/endAngle`, and `INSERT.rotation` are all in radians. Converted to degrees for `arcToPoints` via `* 180 / π` (`RAD2DEG`). `INSERT.rotation` is supplied directly to the trigonometric matrix functions.
2. **Close Flags = Confirmed**: Bit 0 (`flag & 1`) indicates closure for `LWPOLYLINE` and `POLYLINE2D`.
3. **Block basePoint = Confirmed**: Subtracted during matrix evaluation (`insertMatrix`).
4. **`db.entities` Completeness = Confirmed**: Model space entities are populated directly in `db.entities`.
5. **`?url` + locateFile = Confirmed**: Vendored to `src/dwg/libredwg-web.wasm` and resolved via `?url` import with `createModule({ locateFile: () => wasmUrl })`.

---

## 9. GPL-3.0 Compliance

- [x] Replaced `LICENSE` with full GPL-3.0 text.
- [x] Set `"license": "GPL-3.0-or-later"` in `package.json`.
- [x] Added `THIRD-PARTY-LICENSES.md` documenting upstream repositories, versions, and GPL terms.
- [x] Documented GPL-3.0 terms and source repository availability in `README.md`.
- [x] Added source and license links in the application UI (About dialog and footer).
- [x] Release workflow explicitly packages `LICENSE` and `THIRD-PARTY-LICENSES.md` with distribution archives.

---

## 10. Testing

### Fixtures
Sourced from `mlightcad/libredwg-web` test suite:
- `example_r14.dwg`, `example_2000.dwg`, `example_2007.dwg`, `example_2013.dwg`, `example_2018.dwg`
- `Dynblocks.dwg`, `TS1.dwg`
Stored in `test/fixtures/dwg/`.

### Vitest Unit Tests (`src/dwg/*.test.ts`)
- [x] Successfully parse each supported DWG version without 0-entity regressions.
- [x] Verify integer µm bounding boxes and Y-inversion for LINE, LWPOLYLINE, ARC, and CIRCLE.
- [x] Block expansion verification on drawings with nested blocks.
- [x] Non-fatal warning error codes parse successfully.
- [x] Existing DXF tests pass without regressions after `buildImportResult` extraction.

### Playwright E2E Tests
- [x] `.dwg` file drop opens import dialog and renders shapes to canvas (`tests/e2e/dwg_import.spec.ts`).
- [x] Web Worker prevents UI freeze during large drawing parsing.

### Production Build Verification
- [x] Production build separates WASM into a lazy asset chunk.
- [x] Distribution bundle packages LICENSE and THIRD-PARTY-LICENSES.

---

## 11. Acceptance Criteria (DoD)
- Multi-version and block-heavy DWG files import correctly without returning empty results.
- Import results interoperate with downstream editing, persistence, and DXF export workflows.
- Existing DXF import functionality remains fully intact.
- UI remains responsive during parsing.
- GPL-3.0 compliance items deployed in distribution.

---

## 12. Recommended Commit Breakdown
1. `refactor(dxf): extract buildImportResult from importDxf`
2. `chore: add @mlightcad/libredwg-web and relicense to GPL-3.0`
3. `feat(dwg): add wasm loader and DwgDatabase->Polygon importer`
4. `feat(dwg): recursive INSERT/block expansion`
5. `feat(dwg): add ellipse/spline approximation`
6. `perf(dwg): run parsing in a web worker`
7. `feat(ui): wire .dwg drop/menu import`
8. `test(dwg): fixtures and version/block coverage`
