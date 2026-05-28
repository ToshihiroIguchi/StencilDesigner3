# Implementation Plan: All-Vertex Proximity Smart Snapping

Implement a modern, high-precision, automatic proximity-based snapping system when selecting and moving shapes. This replaces the old click-point-restricted snapping and fixes the "self-snapping" bug.

## User Review Required

> [!IMPORTANT]
> - **Self-Snapping Bug Resolution:** Dragged shapes will be completely excluded from the snapping targets. This is necessary because objects moving as a rigid body cannot snap to themselves, and omitting this caused severe jittering.
> - **Proximity Snapping Mechanics:** Any vertex of the selected shapes will automatically snap to any vertex/edge/center of stationary shapes or the grid when dragged close (within the snap radius). This matches modern UX patterns (Figma, Illustrator) and is highly intuitive.
> - **Dashed Guides Visualization:** A dashed line and indicator will highlight which moving vertex is snapping to which target point, providing instant visual feedback.

## Proposed Changes

We will modify three key components in a logically sequential order: snap core first, then the Select tool logic, and finally the canvas renderer to support new visual feedback.

---

### Component 1: Geometry & Snapping Core

#### [MODIFY] [snap.ts](file:///c:/Users/toshi/python/StencilDesinger3/src/core/snap.ts)
Introduce `findSelectionSnap` to calculate the optimal snapping offset for a set of moving shapes against stationary shapes and the grid.

- **Type Definition:**
  ```typescript
  export interface SelectionSnapResult {
    delta: { x: number; y: number }; // Snap translation to apply to selected shapes
    kind: SnapKind;
    movingPoint?: Point;             // The vertex on the moving shape that snapped
    targetPoint?: Point;             // The target point on the stationary shape/grid
    ref?: SnapRef;                   // The reference info for the stationary target
  }
  ```
- **Function Implementation:**
  ```typescript
  export function findSelectionSnap(
    movingShapes: Polygon[],
    dragStartWorld: Point,
    currentMouseWorld: Point,
    staticShapes: Polygon[],
    gridSize: number,
    snapRadius: number
  ): SelectionSnapResult
  ```
- **Behavior:**
  1. Calculate the raw mouse translation: `rawDx = currentMouseWorld.x - dragStartWorld.x`, `rawDy = currentMouseWorld.y - dragStartWorld.y`.
  2. For each vertex $v$ in the outer rings of `movingShapes`:
     - Apply raw displacement: $v_{dragged} = \{ x: v.x + rawDx, y: v.y + rawDy \}$.
     - Run `findSnap(v_{dragged}, staticShapes, gridSize, snapRadius)` to find the closest static target $t$ (excluding moving shapes).
     - Calculate the distance from the dragged vertex to the snap target: $d = dist(v_{dragged}, t.point)$.
     - If `t.kind !== 'grid'` and $d < snapRadius$, keep it as a snap candidate.
  3. Find the candidate with the smallest distance. If a valid candidate exists:
     - Snapped translation is: `deltaX = t.point.x - v.x`, `deltaY = t.point.y - v.y`.
     - Return the result with `delta`, `movingPoint: v`, `targetPoint: t.point`, and `ref: t.ref`.
  4. If no candidate exists, fall back to grid snapping:
     - Snap the mouse coordinate: `snappedMouse = snapToGrid(currentMouseWorld, gridSize)`.
     - `deltaX = snappedMouse.x - dragStartWorld.x`, `deltaY = snappedMouse.y - dragStartWorld.y`.
     - Return the result with `delta` and `kind: 'grid'`.

---

### Component 2: Selection Tool

#### [MODIFY] [select.ts](file:///c:/Users/toshi/python/StencilDesinger3/src/tools/select.ts)
Update `SelectTool` to leverage the new selection snap function and store detailed snap results for rendering.

- **State Additions:**
  - Add `private selectionSnap: SelectionSnapResult | null = null;` to track the active snap details for visual rendering.
- **MouseDown:**
  - Keep tracking `this.dragStartWorld` as the exact (unsnapped) world coordinate of the initial click.
- **MouseMove:**
  - Compute `selectionSnap` using `this.ctx.getSelectionSnap(movingShapes, dragStartWorld, currentMouseWorld)`.
  - Apply `selectionSnap.delta` to move the shapes progressively relative to `savedShapes`.
- **MouseUp / Cancel:**
  - Reset `selectionSnap = null` on completion.

---

### Component 3: Application Shell

#### [MODIFY] [app.ts](file:///c:/Users/toshi/python/StencilDesinger3/src/ui/app.ts)
Expose selection snapping to tools via the tool context.

- **Tool Context Update:**
  - Add `getSelectionSnap` to `ToolContext` in `src/tools/base.ts`.
  - Implement `getSelectionSnap(movingShapes, dragStartWorld, currentMouseWorld)` in `app.ts`. It will partition `state.shapes` into static shapes and moving shapes, then call `findSelectionSnap`.
- **Renderer Update:**
  - Pass the active selection snap info from `SelectTool` (obtained via a getter `getSelectionSnapResult()`) into the `renderer.render()` call.

---

### Component 4: Rendering & Visualization

#### [MODIFY] [renderer.ts](file:///c:/Users/toshi/python/StencilDesinger3/src/canvas/renderer.ts)
Draw smart guides when a selection snaps to a target shape's vertex/edge.

- **Renderer Extras:**
  - Add `selectionSnap?: SelectionSnapResult` to `RendererExtras` or pass it as a primary argument.
- **Drawing Logic:**
  - If `selectionSnap` is active and `selectionSnap.kind !== 'grid'`:
    - Draw a distinct snap target marker (e.g., green ⊠ or triangle) at the target point.
    - Draw a moving alignment marker (e.g., orange circle ◯) at the moving vertex.
    - Draw a **dashed guide line** connecting the two, giving the user immediate, beautiful feedback that the corners are aligned.

---

## Verification Plan

### Automated Tests
- Run unit tests for snapping:
  ```sh
  npm run test:unit src/core/snap.test.ts
  ```
- We will add dedicated unit tests in `tests/snap.test.ts` or `src/core/snap.test.ts` to verify `findSelectionSnap` behaves correctly under different translations and snaps to the nearest vertex.

### Manual Verification
1. Open the application in development mode (`npm run dev`).
2. Draw two rectangles side by side.
3. Select the first rectangle, grab it from the center, and drag it towards the second rectangle.
4. Verify that:
   - The moving rectangle's corner automatically snaps to the second rectangle's corner when it gets close.
   - An alignment guideline (dashed line) is shown between the snapped corners.
   - There is no self-snapping or jittering.
5. Zoom in and out to ensure the snap radius scales appropriately with the zoom level.
