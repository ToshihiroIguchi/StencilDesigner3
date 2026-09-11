# DWG Import Feature Implementation Plan

Detailed plan for adding **DWG file loading (import)** functionality to StencilDesigner3.
DWG export is out of scope (import-only).

---

## 1. Goals and Scope

### Goals
- Enable opening DWG files inside the browser (no backend required, remaining a static SPA).
- Make **reading the vast majority of practical DWG files** the highest priority requirement (broad version coverage, entity coverage, block expansion, and robust error handling).
- Unify import results into the existing `ImportResult` format (`Polygon[]` + `Layer[]`) used by DXF import, sharing downstream pipelines (normalization, editing, persistence, and DXF export).

### Non-Goals
- DWG export (unneeded).
- File conversion features such as DXF to DWG.
- Geometrizing annotations (TEXT, MTEXT, DIMENSION, etc.) into shapes (not needed for mask design; counted in ignored summary only).

---

## 2. Chosen Library and Benchmark Rationale

### Library
- **`@mlightcad/libredwg-web`** (WebAssembly build of GNU LibreDWG, GPL-3.0, actively maintained).
- Default build is **DWG read-only** (DXF read/write, JSON, and DWG write are disabled, minimizing bundle size). Ideal for this use case.
- Calling `LibreDwg.create()` → `dwg_read_data(bytes, Dwg_File_Type.DWG)` → `convert()` yields a typed `DwgDatabase` (`entities`, `tables`, `header`, `objects`, `classes`).

### Benchmark Results (Empirical Summary; details in Appendix A)
- Distribution size: WASM binary 6.3 MB (**gzip 1.6 MB**) + raw glue JS 109 KB. Downloaded once and cached.
- WASM initialization: **56–99 ms** (once at startup; lazy-loaded so initial application launch is unaffected).
- Parse duration: **10–20 ms per file** for typical drawings; ~1.26 s for complex drawings with extensive internal objects (2.18 MB class).
  - The dominant factor is `convert()` (native-to-JS conversion), not DWG decoding itself.
  - Duration scales with **total internal object count (including block definitions)** rather than file byte size.

---

## 3. Legal Compliance (GPL-3.0 Compliance) — Critical Requirement

LibreDWG and `@mlightcad/libredwg-web` are licensed under **GPL-3.0**. Serving WASM to the browser constitutes binary conveyance to users, and sharing data structures via API calls makes the application a combined work. Consequently, **the distributed application as a whole must comply with GPL-3.0** (GPL-3 adoption is approved).

Actions taken:

1. **Project Relicensing**
   - The initial `LICENSE` was MIT. As the sole copyright holder (Toshihiro Iguchi), relicensing is permissible.
   - Replaced `LICENSE` with the full text of **GPL-3.0**.
   - Updated `"license"` in `package.json` to `"GPL-3.0-or-later"`.
   - Documented in README that this app is distributed under GPL-3.0-or-later due to the inclusion of LibreDWG.
   - Historical MIT status remains in Git history; release notes and README clarify that releases containing DWG features are distributed under GPL-3.0.

2. **Third-Party License Notices (NOTICE / THIRD-PARTY)**
   - Added `THIRD-PARTY-LICENSES.md` explicitly stating copyright notices, GPL-3.0, and upstream source URLs for LibreDWG and `@mlightcad/libredwg-web`.
   - Copyright and license notices bundled with WASM are preserved without removal or alteration.

3. **Provision of Corresponding Source (GPL §6)**
   - Provide Corresponding Source for distributed artifacts:
     - This application: The public GitHub repository fulfills the source provision requirement.
     - LibreDWG / WASM: Upstream public repository links (pinned versions) are included in `THIRD-PARTY-LICENSES.md` and the in-app About modal.
   - Deployment builds (GitHub Pages, etc.) include "Source Code" and "License" links in the About dialog or footer.

4. **CI and Release Integration**
   - Ensure `LICENSE` and `THIRD-PARTY-LICENSES.md` are bundled into distribution archives in the release workflow.

---

## 4. Robustness Strategy for "Reading Most DWG Files"

Concrete measures to prevent empty imports and parse failures.

### 4.1 Version Coverage
- LibreDWG automatically detects and reads R13 through R2018+ (as well as legacy R11/R12/R10 versions).
  - Empirically validated across AC1014 (R14), AC1015 (2000), AC1021 (2007), AC1027 (2013), and AC1032 (2018).
- No application-level version branching needed. Magic bytes (`AC10xx`) provide heuristic detection; attempt parsing regardless.

### 4.2 Entity Coverage (Broader than DXF Import)
Existing DXF import handles `LINE`, `ARC`, `CIRCLE`, `LWPOLYLINE`, and `POLYLINE`. DWG import expands this to:

| Entity | Handling |
|---|---|
| LINE | 2-vertex segment (reused from existing pipeline) |
| LWPOLYLINE / POLYLINE(2D) | Open → chained segments / Closed → rings (with bulge support; reused) |
| ARC / CIRCLE | Arc approximation (reused `arcToPoints`) |
| **ELLIPSE** | Polyline approximation of elliptical arcs (segmented via `getCircleSegments`) |
| **SPLINE** | Polyline approximation from control/fit points with chord-height tolerance |
| **INSERT (Block Reference)** | **Recursive expansion of block definitions** (see 4.3 below) — Essential |
| POINT | Optional (e.g. for alignment / registration marks) |
| SOLID / 3DFACE | Outline converted to ring (optional) |
| HATCH | Boundary path converted to ring (optional / low priority) |
| TEXT / MTEXT / DIMENSION / Other | Ignored (tallied in `ignoredCounts`) |

### 4.3 Block (INSERT) Expansion — Essential Requirement
**Real-world DWG files make heavy use of blocks. Without expanding INSERT entities, drawings frequently import as empty.** This is the cornerstone of reading most drawings.

- Look up block definitions from `tables.BLOCK_RECORD` and associated entities in `DwgDatabase`, and for each `INSERT`:
  - Compose a **transformation matrix** from translation (insertion point), `xScale/yScale/zScale`, and rotation angle.
  - Transform coordinates, convert via `mmToUm`, and negate Y.
  - Support **MINSERT (matrix replication)** with row/col/spacing.
  - **Recursively expand nested block references** (with circular reference guards and maximum recursion depth).
- To preserve the integer µm contract, apply `Math.round` after matrix evaluation.

### 4.4 Robust Error Handling
- The `error` return value from `dwg_read_data` is a **bit flag**. Low-order bits (warnings such as 4, 68) are **non-fatal**.
  - Policy: **Treat import as successful if at least one entity is recovered**. Display warnings in console and import dialog.
  - Only notify user of failure on severe errors (complete read failure or no data).
- When 0 entities are imported, present a clear explanation (e.g. unsupported entity types or unexpanded blocks) along with the `ignoredCounts` breakdown.
- Display fallback message on WASM load failure (CSP or network issues).
- Wrap individual entity conversion in `try/catch` to skip malformed entities without halting the entire import (partial recovery).

### 4.5 Unit Handling
- DXF import assumes millimeters (`mmToUm`). DWG import similarly treats model space units as mm (consistent with existing behavior).
- Future enhancement: inspect `header.$INSUNITS` for scale correction (e.g. inches). The initial version uses fixed mm, with post-import scaling available if needed.

---

## 5. Architecture and File Changes

```
src/dxf/importer.ts        Extract shared downstream pipeline into reusable function (refactor)
src/dwg/importer.ts        New: importDwg(buf) … DwgDatabase → ImportResult
src/dwg/blocks.ts          New: Block expansion and transformation matrix utilities
src/dwg/worker.ts          New: Off-thread parsing in Web Worker (prevents UI freeze on large drawings)
src/dwg/libredwg.ts        New: WASM lazy loader and locateFile resolver wrapper
src/ui/app.ts              Add .dwg to drop target, menu, and file input; add progress display
vite.config.*              Configure .wasm as a lazy chunk / static asset
LICENSE / package.json     Relicensed to GPL-3.0 (in Phase 1)
THIRD-PARTY-LICENSES.md    New (third-party license notices)
```

### Design Principles
- Extract the downstream stage of `importDxf` (segment chaining by layer → outer/hole classification → layer table assembly → `normalizeAll`) into `buildImportResult(segments, closedRings, rawLayers): ImportResult`, shared across DXF and DWG.
- `importDwg` simply inspects `DwgDatabase` and **emits segments and closedRings**. Coordinate transforms, bulge handling, and arc discretization reuse existing helpers (`arcToPoints`, `bulgeToArcPoints`, `expandPolylineVerts`, `mmToUm`, Y-negation).
- Assemble layer table from `tables.LAYER` (reusing `aciToHex` and `normalizeLinetype`).
- Always free WASM memory via `dwg_free()` in a `finally` block.

---

## 6. Tasks by Phase

> **Status Note:** Phases 1–6 are fully implemented, verified, and merged into `main` (PR #3 through #7). See `dwg-import-impl-spec.md` for historical specifics.

### Phase 1 — Dependencies, Lazy-Loading Foundation, and GPL Compliance
- [x] `npm install @mlightcad/libredwg-web`
- [x] Update `LICENSE` to full GPL-3.0 text, update `package.json` license, add `THIRD-PARTY-LICENSES.md`, update README
- [x] `src/dwg/libredwg.ts`: Lazy `import()` of `LibreDwg.create()` and `.wasm` `locateFile` resolution
- [x] Verify `.wasm` is excluded from initial bundle and emitted as a lazy chunk in Vite

### Phase 2 — Core Conversion (DwgDatabase → ImportResult)
- [x] `src/dxf/importer.ts`: Extract downstream logic into `buildImportResult(...)` (DXF behavior preserved; validated by existing tests)
- [x] `src/dwg/importer.ts`: `importDwg(buf: ArrayBuffer): Promise<ImportResult>`
  - [x] Map LINE, ARC, CIRCLE, LWPOLYLINE, and POLYLINE (absorbing schema differences)
  - [x] Classify error codes into warnings vs. fatal; partial import with try/catch
  - [x] Collect `ignoredCounts`

### Phase 3 — Coverage Expansion (Reading Most Drawings)
- [x] `src/dwg/blocks.ts`: INSERT/MINSERT expansion (translation, scaling, rotation, recursion with cycle guard)
- [x] ELLIPSE approximation and SPLINE polyline approximation (SPLINE uses de Boor / centripetal Catmull-Rom + adaptive chord-height subdivision)
- [ ] (Optional) SOLID / 3DFACE / POINT / HATCH support (unhandled; tracked in `ignoredCounts`)
- [x] Explanation UI when 0 entities are imported

### Phase 4 — Web Worker Integration
- [x] `src/dwg/worker.ts`: Execute parsing (read, convert, transform) in a Web Worker and post back `ImportResult`
- [x] UI spinner / progress feedback and cancellation

### Phase 5 — UI Wiring (`src/ui/app.ts`)
- [x] Add `dwg` extension to drag-and-drop handler → `loadDwgFile(file)` (`file.arrayBuffer()`)
- [x] Add `.dwg` to file input `accept` filter and menu; implement `importDwg()` method
- [x] Reuse existing `showImportDialog(result)` upon completion
- [x] Add "Source Code" and "License" links to About dialog and footer (GPL §6)

### Phase 6 — Testing and Verification
- [x] Unit tests (Vitest): Validate entity counts, bounding boxes, layers, and block expansion across DWG versions (R14, 2000, 2007, 2013, 2018)
- [x] Regression tests ensuring drawings with heavy block usage do not import empty
- [x] Verify warning error codes are treated as successful imports
- [x] E2E tests (Playwright): `.dwg` drop → import dialog → canvas rendering
- [x] Production build verification: WASM is isolated into a lazy chunk and omitted from initial load
- [x] Distribution verification: Ensure LICENSE and THIRD-PARTY-LICENSES are bundled into release archives

---

## 7. Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Empty import due to unexpanded blocks | Drawing appears missing | Implement recursive INSERT expansion in Phase 3 |
| UI freeze on large drawings | Degraded user experience | Off-thread Web Worker parsing (Phase 4) |
| Initial bundle bloat | Slower initial page load | Lazy-load WASM only when a DWG file is opened |
| False failure on warning error codes | Rejection of valid files | Treat low-order error codes as warnings; allow partial import |
| Unit discrepancies (e.g. inches) | Dimensional errors | Default to millimeters; support `$INSUNITS` in future |
| WASM locateFile / CSP issues | Load failure | Verify asset paths and CSP settings; show fallback message |

---

## 8. Definition of Done
- Representative real-world DWG files across multiple versions (including heavy block usage) import accurately without producing empty results.
- Import results integrate seamlessly with existing editing, saving, and DXF export workflows.
- GPL-3.0 compliance (license text, third-party notices, source provision links) reflected in distribution builds.
- Large drawings do not cause UI freezes (Web Worker parsing).
- Existing DXF import behavior and tests remain unaffected.

---

## Appendix A: Raw Benchmark Data (Reference)

Library: `@mlightcad/libredwg-web@0.7.2`, Node 24 (V8). Best of 3 runs.

| File | Size | read | convert | Total | Model Space Entities |
|---|---|---|---|---|---|
| example_2018.dwg | 149 KB | 4.9 ms | 9.7 ms | 15 ms | 63 |
| example_2013.dwg | 147 KB | 6.5 ms | 8.1 ms | 15 ms | 63 |
| TS1.dwg | 418 KB | 4.7 ms | 5.3 ms | 10 ms | 28 |
| example_2000.dwg | 583 KB | 5.4 ms | 9.9 ms | 15 ms | 61 |
| example_r14.dwg | 440 KB | 5.8 ms | 11.8 ms | 18 ms | 61 |
| Dynblocks.dwg | 2.18 MB | 119 ms | 1141 ms | 1261 ms | 121 (numerous block definitions) |

- WASM initialization: 56–99 ms (one-time)
- Distribution: WASM 6.3 MB / gzip 1.6 MB; raw glue JS 109 KB
- `error code 4/68` during parsing are non-fatal warnings (data is retrieved normally)
