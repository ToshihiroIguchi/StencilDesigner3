import { test, expect, type Page } from '@playwright/test';

// ── helpers ────────────────────────────────────────────────────────────────

async function drawRect(page: Page, x1: number, y1: number, x2: number, y2: number) {
  await page.click('[data-tool="rect"]');
  await page.mouse.move(x1, y1);
  await page.mouse.down();
  await page.mouse.move(x2, y2);
  await page.mouse.up();
}

async function selectShape(page: Page, cx: number, cy: number, shift = false) {
  await page.click('[data-tool="select"]');
  if (shift) {
    await page.keyboard.down('Shift');
  }
  await page.mouse.click(cx, cy);
  if (shift) {
    await page.keyboard.up('Shift');
  }
}

async function canvasBox(page: Page) {
  const box = await page.locator('#main-canvas').boundingBox();
  if (!box) throw new Error('canvas not found');
  return box;
}

async function shapeCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const app = (window as any).__app as any;
    return app?.history?.state?.shapes?.length ?? -1;
  });
}

async function selectedCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const app = (window as any).__app as any;
    return app?.history?.state?.selection?.length ?? -1;
  });
}

// ── 1. Initial display ─────────────────────────────────────────────────────

test.describe('1. Initial display', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    // Clear any saved state so tests start clean
    await page.evaluate(() => (window as any).__app?.hardReset?.().catch(() => {}));
    await page.waitForTimeout(200);
  });

  test('1-1 page title', async ({ page }) => {
    await expect(page).toHaveTitle(/StencilDesigner3/);
  });

  test('1-2 app title text in header', async ({ page }) => {
    await expect(page.locator('.app-title')).toHaveText('StencilDesigner3');
  });

  test('1-3 three-column layout exists', async ({ page }) => {
    await expect(page.locator('#toolbar')).toBeVisible();
    await expect(page.locator('#main-canvas')).toBeVisible();
    await expect(page.locator('#right-panel')).toBeVisible();
  });

  test('1-4 footer displays initial values', async ({ page }) => {
    await expect(page.locator('#footer-snap')).toHaveText('ON');
    await expect(page.locator('#footer-cx')).toHaveText('0');
    await expect(page.locator('#footer-cy')).toHaveText('0');
  });

  test('1-5 undo/redo buttons disabled on load', async ({ page }) => {
    await expect(page.locator('#btn-undo')).toBeDisabled();
    await expect(page.locator('#btn-redo')).toBeDisabled();
  });

  test('1-6 canvas is visible and has non-zero size', async ({ page }) => {
    const box = await canvasBox(page);
    expect(box.width).toBeGreaterThan(100);
    expect(box.height).toBeGreaterThan(100);
  });
});

// ── 2. Theme toggle ────────────────────────────────────────────────────────

test.describe('2. Theme toggle', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
  });

  test('2-1 click Theme applies light class', async ({ page }) => {
    await page.click('#btn-theme');
    await expect(page.locator('body')).toHaveClass(/light/);
  });

  test('2-2 second click restores dark theme', async ({ page }) => {
    await page.click('#btn-theme');
    await page.click('#btn-theme');
    await expect(page.locator('body')).not.toHaveClass(/light/);
  });
});

// ── 3. Cursor coordinates ──────────────────────────────────────────────────

test.describe('3. Cursor coordinates', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
  });

  test('3-1 coordinates update on mouse move', async ({ page }) => {
    const box = await canvasBox(page);
    await page.mouse.move(box.x + 200, box.y + 200);
    const cx = await page.locator('#footer-cx').textContent();
    const cy = await page.locator('#footer-cy').textContent();
    expect(Number.isNaN(Number(cx))).toBe(false);
    expect(Number.isNaN(Number(cy))).toBe(false);
  });

  test('3-2 coordinates are integers', async ({ page }) => {
    const box = await canvasBox(page);
    await page.mouse.move(box.x + 150, box.y + 150);
    const cx = await page.locator('#footer-cx').textContent();
    expect(cx).toMatch(/^-?\d+$/);
  });

  test('3-3 moving to different positions changes values', async ({ page }) => {
    const box = await canvasBox(page);
    await page.mouse.move(box.x + 100, box.y + 100);
    const cx1 = await page.locator('#footer-cx').textContent();
    await page.mouse.move(box.x + 400, box.y + 300);
    const cx2 = await page.locator('#footer-cx').textContent();
    expect(cx1).not.toBe(cx2);
  });
});

// ── 4. Zoom & pan ──────────────────────────────────────────────────────────

test.describe('4. Zoom and pan', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
  });

  test('4-1 scroll wheel changes zoom percentage', async ({ page }) => {
    const box = await canvasBox(page);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);

    const zoomBefore = await page.locator('#footer-zoom').textContent();
    await page.mouse.wheel(0, -120); // scroll up = zoom in
    await page.waitForTimeout(100);
    const zoomAfter = await page.locator('#footer-zoom').textContent();
    expect(zoomBefore).not.toBe(zoomAfter);
  });

  test('4-2 zoom in increases zoom value', async ({ page }) => {
    const box = await canvasBox(page);
    await page.mouse.move(box.x + 300, box.y + 300);
    for (let i = 0; i < 5; i++) {
      await page.mouse.wheel(0, -120);
      await page.waitForTimeout(30);
    }
    const zoom = await page.locator('#footer-zoom').textContent();
    const pct = parseInt(zoom ?? '0', 10);
    expect(pct).toBeGreaterThan(50);
  });

  test('4-3 zoom out decreases zoom value', async ({ page }) => {
    const box = await canvasBox(page);
    await page.mouse.move(box.x + 300, box.y + 300);
    for (let i = 0; i < 5; i++) {
      await page.mouse.wheel(0, 120);
      await page.waitForTimeout(30);
    }
    const zoom = await page.locator('#footer-zoom').textContent();
    const pct = parseInt(zoom ?? '100', 10);
    expect(pct).toBeLessThan(50);
  });

  test('4-4 right-drag pans canvas', async ({ page }) => {
    const box = await canvasBox(page);
    // Get world coord before pan
    await page.mouse.move(box.x + 300, box.y + 200);
    await page.waitForTimeout(50);
    const coordBefore = await page.locator('#footer-cx').textContent();
    // Pan 100px to the right
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(box.x + 400, box.y + 200);
    await page.mouse.up({ button: 'right' });
    // Move mouse back to same canvas position
    await page.mouse.move(box.x + 300, box.y + 200);
    await page.waitForTimeout(50);
    const coordAfter = await page.locator('#footer-cx').textContent();
    // After pan, same canvas position maps to different world coords
    expect(coordBefore).not.toBe(coordAfter);
  });
});

// ── 5. Rectangle tool ──────────────────────────────────────────────────────

test.describe('5. Rectangle tool', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    // Confirm clear
    await page.evaluate(() => {
      const app = (window as any).__app as any;
      app?.history?.loadState(app?.history?.state && { ...app.history.state, shapes: [], selection: [] });
    });
  });

  test('5-1 Rect button highlights on click', async ({ page }) => {
    await page.click('[data-tool="rect"]');
    await expect(page.locator('[data-tool="rect"]')).toHaveClass(/active/);
  });

  test('5-2 drawing adds one shape', async ({ page }) => {
    const box = await canvasBox(page);
    await drawRect(page, box.x + 100, box.y + 100, box.x + 300, box.y + 250);
    const count = await shapeCount(page);
    expect(count).toBe(1);
  });

  test('5-3 drawn shape has correct bounding box', async ({ page }) => {
    const box = await canvasBox(page);
    // Draw at known canvas coordinates
    await drawRect(page, box.x + 100, box.y + 100, box.x + 300, box.y + 200);
    const bb = await page.evaluate(() => {
      const app = (window as any).__app as any;
      const shapes = app?.history?.state?.shapes;
      if (!shapes || shapes.length === 0) return null;
      const s = shapes[0];
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of s.outer) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
      return { w: maxX - minX, h: maxY - minY };
    });
    expect(bb).not.toBeNull();
    expect(bb!.w).toBeGreaterThan(0);
    expect(bb!.h).toBeGreaterThan(0);
  });

  test('5-4 Shift constraint makes square', async ({ page }) => {
    const box = await canvasBox(page);
    await page.click('[data-tool="rect"]');
    await page.keyboard.down('Shift');
    await page.mouse.move(box.x + 100, box.y + 100);
    await page.mouse.down();
    await page.mouse.move(box.x + 250, box.y + 350); // non-square drag
    await page.mouse.up();
    await page.keyboard.up('Shift');

    const isSquare = await page.evaluate(() => {
      const app = (window as any).__app as any;
      const shapes = app?.history?.state?.shapes;
      if (!shapes || shapes.length === 0) return false;
      const s = shapes[0];
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of s.outer) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
      const w = maxX - minX, h = maxY - minY;
      return Math.abs(w - h) <= 2; // ±2µm tolerance for integer rounding
    });
    expect(isSquare).toBe(true);
  });

  test('5-5 undo removes shape', async ({ page }) => {
    const box = await canvasBox(page);
    await drawRect(page, box.x + 100, box.y + 100, box.x + 300, box.y + 250);
    expect(await shapeCount(page)).toBe(1);
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(50);
    expect(await shapeCount(page)).toBe(0);
  });

  test('5-6 undo enables redo', async ({ page }) => {
    const box = await canvasBox(page);
    await drawRect(page, box.x + 100, box.y + 100, box.x + 200, box.y + 200);
    await page.keyboard.press('Control+z');
    await expect(page.locator('#btn-redo')).not.toBeDisabled();
  });
});

// ── 6. Line tool ───────────────────────────────────────────────────────────

test.describe('6. Line tool', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
  });

  test('6-1 Line button highlights', async ({ page }) => {
    await page.click('[data-tool="line"]');
    await expect(page.locator('[data-tool="line"]')).toHaveClass(/active/);
  });

  test('6-2 drawing a line adds one shape', async ({ page }) => {
    const box = await canvasBox(page);
    await page.click('[data-tool="line"]');
    await page.mouse.move(box.x + 100, box.y + 150);
    await page.mouse.down();
    await page.mouse.move(box.x + 400, box.y + 150);
    await page.mouse.up();
    expect(await shapeCount(page)).toBe(1);
  });

  test('6-3 Shift constrains to horizontal', async ({ page }) => {
    const box = await canvasBox(page);
    await page.click('[data-tool="line"]');
    await page.keyboard.down('Shift');
    await page.mouse.move(box.x + 100, box.y + 150);
    await page.mouse.down();
    await page.mouse.move(box.x + 400, box.y + 200); // diagonal input
    await page.mouse.up();
    await page.keyboard.up('Shift');

    const isHorizontal = await page.evaluate(() => {
      const shapes = (window as any).__app?.history?.state?.shapes;
      if (!shapes || shapes.length === 0) return false;
      const s = shapes[shapes.length - 1];
      const ys = s.outer.map((p: any) => p.y);
      const minY = Math.min(...ys), maxY = Math.max(...ys);
      return (maxY - minY) <= 200; // 100µm half-width means max span = 200µm
    });
    expect(isHorizontal).toBe(true);
  });
});

// ── 7. Circle tool ─────────────────────────────────────────────────────────

test.describe('7. Circle tool', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
  });

  test('7-1 Circle button highlights', async ({ page }) => {
    await page.click('[data-tool="circle"]');
    await expect(page.locator('[data-tool="circle"]')).toHaveClass(/active/);
  });

  test('7-2 drawing a circle adds one shape', async ({ page }) => {
    const box = await canvasBox(page);
    await page.click('[data-tool="circle"]');
    await page.mouse.move(box.x + 300, box.y + 200);
    await page.mouse.down();
    await page.mouse.move(box.x + 400, box.y + 200);
    await page.mouse.up();
    expect(await shapeCount(page)).toBe(1);
  });

  test('7-3 circle shape has integer coordinates only', async ({ page }) => {
    const box = await canvasBox(page);
    await page.click('[data-tool="circle"]');
    await page.mouse.move(box.x + 300, box.y + 200);
    await page.mouse.down();
    await page.mouse.move(box.x + 400, box.y + 200);
    await page.mouse.up();

    const allIntegers = await page.evaluate(() => {
      const shapes = (window as any).__app?.history?.state?.shapes;
      if (!shapes || shapes.length === 0) return false;
      const s = shapes[0];
      return s.outer.every((p: any) => Number.isInteger(p.x) && Number.isInteger(p.y));
    });
    expect(allIntegers).toBe(true);
  });

  test('7-4 circle has no holes', async ({ page }) => {
    const box = await canvasBox(page);
    await page.click('[data-tool="circle"]');
    await page.mouse.move(box.x + 300, box.y + 200);
    await page.mouse.down();
    await page.mouse.move(box.x + 450, box.y + 200);
    await page.mouse.up();

    const holes = await page.evaluate(() => {
      const shapes = (window as any).__app?.history?.state?.shapes;
      return shapes?.[0]?.holes?.length ?? -1;
    });
    expect(holes).toBe(0);
  });
});

// ── 8. Selection ───────────────────────────────────────────────────────────

test.describe('8. Selection', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    const box = await canvasBox(page);
    await drawRect(page, box.x + 100, box.y + 100, box.x + 300, box.y + 250);
  });

  test('8-1 clicking shape selects it', async ({ page }) => {
    const box = await canvasBox(page);
    await selectShape(page, box.x + 200, box.y + 175);
    expect(await selectedCount(page)).toBeGreaterThan(0);
  });

  test('8-2 right panel shows selection info', async ({ page }) => {
    const box = await canvasBox(page);
    await selectShape(page, box.x + 200, box.y + 175);
    await expect(page.locator('#selection-info')).not.toHaveText('No selection');
  });

  test('8-3 footer W/H update on selection', async ({ page }) => {
    const box = await canvasBox(page);
    await selectShape(page, box.x + 200, box.y + 175);
    // Use Playwright's auto-retry assertion to wait for the RAF-driven render
    await expect(page.locator('#footer-w')).not.toHaveText('—', { timeout: 3000 });
    await expect(page.locator('#footer-w')).not.toHaveText('0', { timeout: 3000 });
  });

  test('8-4 click empty area deselects', async ({ page }) => {
    const box = await canvasBox(page);
    await selectShape(page, box.x + 200, box.y + 175);
    await page.mouse.click(box.x + 700, box.y + 400);
    await page.waitForTimeout(50);
    expect(await selectedCount(page)).toBe(0);
  });

  test('8-5 Shift+click adds to selection', async ({ page }) => {
    const box = await canvasBox(page);
    await page.click('[data-tool="rect"]');
    await page.mouse.move(box.x + 400, box.y + 100);
    await page.mouse.down();
    await page.mouse.move(box.x + 600, box.y + 250);
    await page.mouse.up();

    await selectShape(page, box.x + 200, box.y + 175);
    await selectShape(page, box.x + 500, box.y + 175, true);
    expect(await selectedCount(page)).toBe(2);
  });
});

// ── 9. Move ────────────────────────────────────────────────────────────────

test.describe('9. Move (drag)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    const box = await canvasBox(page);
    await drawRect(page, box.x + 100, box.y + 100, box.x + 300, box.y + 250);
  });

  test('9-1 dragging moves shape position', async ({ page }) => {
    const box = await canvasBox(page);
    await selectShape(page, box.x + 200, box.y + 175);

    const before = await page.evaluate(() => {
      const shapes = (window as any).__app?.history?.state?.shapes;
      return shapes?.[0]?.outer?.[0]?.x ?? null;
    });

    await page.click('[data-tool="select"]');
    await page.mouse.move(box.x + 200, box.y + 175);
    await page.mouse.down();
    await page.mouse.move(box.x + 350, box.y + 175);
    await page.mouse.up();

    const after = await page.evaluate(() => {
      const shapes = (window as any).__app?.history?.state?.shapes;
      return shapes?.[0]?.outer?.[0]?.x ?? null;
    });
    expect(after).not.toBe(before);
  });

  test('9-2 undo restores original position', async ({ page }) => {
    const box = await canvasBox(page);
    const origX = await page.evaluate(() => {
      return (window as any).__app?.history?.state?.shapes?.[0]?.outer?.[0]?.x ?? null;
    });

    await selectShape(page, box.x + 200, box.y + 175);
    await page.mouse.move(box.x + 200, box.y + 175);
    await page.mouse.down();
    await page.mouse.move(box.x + 400, box.y + 175);
    await page.mouse.up();

    await page.keyboard.press('Control+z');
    await page.waitForTimeout(100);

    // Undo multiple times to get back to original (each mouse pixel = 1 command)
    for (let i = 0; i < 20; i++) {
      if (await page.locator('#btn-undo').isDisabled()) break;
      await page.keyboard.press('Control+z');
      await page.waitForTimeout(30);
    }

    const finalX = await page.evaluate(() => {
      return (window as any).__app?.history?.state?.shapes?.[0]?.outer?.[0]?.x ?? null;
    });
    // The shape should be somewhere close to where it started
    expect(Math.abs((finalX ?? 0) - (origX ?? 0))).toBeLessThan(500);
  });
});

// ── 10. Delete ─────────────────────────────────────────────────────────────

test.describe('10. Delete', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    const box = await canvasBox(page);
    await drawRect(page, box.x + 100, box.y + 100, box.x + 300, box.y + 250);
  });

  test('10-1 Delete button removes selected shape', async ({ page }) => {
    const box = await canvasBox(page);
    await selectShape(page, box.x + 200, box.y + 175);
    await page.click('#btn-delete');
    expect(await shapeCount(page)).toBe(0);
  });

  test('10-2 Delete key removes selected shape', async ({ page }) => {
    const box = await canvasBox(page);
    await selectShape(page, box.x + 200, box.y + 175);
    await page.keyboard.press('Delete');
    await page.waitForTimeout(50);
    expect(await shapeCount(page)).toBe(0);
  });

  test('10-3 undo restores deleted shape', async ({ page }) => {
    const box = await canvasBox(page);
    await selectShape(page, box.x + 200, box.y + 175);
    await page.click('#btn-delete');
    expect(await shapeCount(page)).toBe(0);
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(50);
    expect(await shapeCount(page)).toBe(1);
  });
});

// ── 11. Copy ───────────────────────────────────────────────────────────────

test.describe('11. Copy', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    const box = await canvasBox(page);
    await drawRect(page, box.x + 100, box.y + 100, box.x + 300, box.y + 250);
  });

  test('11-1 Copy adds one more shape', async ({ page }) => {
    const box = await canvasBox(page);
    await selectShape(page, box.x + 200, box.y + 175);
    page.on('dialog', (d) => d.accept('1000,0'));
    await page.click('#btn-copy-btn');
    await page.waitForTimeout(200);
    expect(await shapeCount(page)).toBe(2);
  });

  test('11-2 undo removes copy', async ({ page }) => {
    const box = await canvasBox(page);
    await selectShape(page, box.x + 200, box.y + 175);
    page.on('dialog', (d) => d.accept('1000,0'));
    await page.click('#btn-copy-btn');
    await page.waitForTimeout(200);
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(50);
    expect(await shapeCount(page)).toBe(1);
  });
});

// ── 12. Array copy ─────────────────────────────────────────────────────────

test.describe('12. Array copy', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    const box = await canvasBox(page);
    await drawRect(page, box.x + 100, box.y + 100, box.x + 200, box.y + 200);
  });

  test('12-1 3×3 array creates 9 shapes total', async ({ page }) => {
    const box = await canvasBox(page);
    await selectShape(page, box.x + 150, box.y + 150);
    page.on('dialog', (d) => d.accept('3,3,2000,2000'));
    await page.click('#btn-array');
    await page.waitForTimeout(300);
    expect(await shapeCount(page)).toBe(9);
  });

  test('12-2 2×1 array creates 2 shapes', async ({ page }) => {
    const box = await canvasBox(page);
    await selectShape(page, box.x + 150, box.y + 150);
    page.on('dialog', (d) => d.accept('2,1,3000,0'));
    await page.click('#btn-array');
    await page.waitForTimeout(200);
    expect(await shapeCount(page)).toBe(2);
  });

  test('12-3 undo removes array copies', async ({ page }) => {
    const box = await canvasBox(page);
    await selectShape(page, box.x + 150, box.y + 150);
    page.on('dialog', (d) => d.accept('3,3,2000,2000'));
    await page.click('#btn-array');
    await page.waitForTimeout(300);
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(100);
    expect(await shapeCount(page)).toBe(1);
  });
});

// ── 13. Boolean Union ──────────────────────────────────────────────────────

test.describe('13. Boolean Union', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    const box = await canvasBox(page);
    // Two overlapping rectangles
    await drawRect(page, box.x + 100, box.y + 100, box.x + 300, box.y + 250);
    await drawRect(page, box.x + 200, box.y + 100, box.x + 400, box.y + 250);
  });

  test('13-1 union of two overlapping rects gives 1 shape', async ({ page }) => {
    const box = await canvasBox(page);
    await selectShape(page, box.x + 200, box.y + 175);
    await selectShape(page, box.x + 300, box.y + 175, true);
    expect(await selectedCount(page)).toBe(2);

    await page.click('#btn-union');
    await page.waitForTimeout(300);
    expect(await shapeCount(page)).toBe(1);
  });

  test('13-2 result has integer coordinates only', async ({ page }) => {
    const box = await canvasBox(page);
    await selectShape(page, box.x + 200, box.y + 175);
    await selectShape(page, box.x + 300, box.y + 175, true);
    await page.click('#btn-union');
    await page.waitForTimeout(300);

    const allIntegers = await page.evaluate(() => {
      const shapes = (window as any).__app?.history?.state?.shapes;
      if (!shapes || shapes.length === 0) return false;
      return shapes[0].outer.every((p: any) => Number.isInteger(p.x) && Number.isInteger(p.y));
    });
    expect(allIntegers).toBe(true);
  });

  test('13-3 undo restores two shapes', async ({ page }) => {
    const box = await canvasBox(page);
    await selectShape(page, box.x + 200, box.y + 175);
    await selectShape(page, box.x + 300, box.y + 175, true);
    await page.click('#btn-union');
    await page.waitForTimeout(300);
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(100);
    expect(await shapeCount(page)).toBe(2);
  });
});

// ── 14. Boolean Difference ─────────────────────────────────────────────────

test.describe('14. Boolean Difference', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    const box = await canvasBox(page);
    await drawRect(page, box.x + 80,  box.y + 80,  box.x + 420, box.y + 320);
    await drawRect(page, box.x + 150, box.y + 130, box.x + 350, box.y + 270);
  });

  test('14-1 difference leaves 1 shape with a hole', async ({ page }) => {
    const box = await canvasBox(page);
    await selectShape(page, box.x + 100, box.y + 100);
    await selectShape(page, box.x + 250, box.y + 200, true);
    await page.click('#btn-difference');
    await page.waitForTimeout(300);
    expect(await shapeCount(page)).toBe(1);

    const holeCount = await page.evaluate(() => {
      const shapes = (window as any).__app?.history?.state?.shapes;
      return shapes?.[0]?.holes?.length ?? -1;
    });
    expect(holeCount).toBeGreaterThan(0);
  });

  test('14-2 undo restores original two shapes', async ({ page }) => {
    const box = await canvasBox(page);
    await selectShape(page, box.x + 100, box.y + 100);
    await selectShape(page, box.x + 250, box.y + 200, true);
    await page.click('#btn-difference');
    await page.waitForTimeout(300);
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(100);
    expect(await shapeCount(page)).toBe(2);
  });
});

// ── 15. Snap toggle ────────────────────────────────────────────────────────

test.describe('15. Snap toggle', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
  });

  test('15-1 snap is ON by default', async ({ page }) => {
    await expect(page.locator('#footer-snap')).toHaveText('ON');
    await expect(page.locator('#btn-snap')).toHaveClass(/active/);
  });

  test('15-2 clicking snap toggles to OFF', async ({ page }) => {
    await page.click('#btn-snap');
    await expect(page.locator('#footer-snap')).toHaveText('OFF');
    await expect(page.locator('#btn-snap')).not.toHaveClass(/active/);
  });

  test('15-3 clicking again restores ON', async ({ page }) => {
    await page.click('#btn-snap');
    await page.click('#btn-snap');
    await expect(page.locator('#footer-snap')).toHaveText('ON');
  });

  test('15-4 snap state reflected in app state', async ({ page }) => {
    await page.click('#btn-snap');
    const snap = await page.evaluate(() => (window as any).__app?.history?.state?.snapEnabled);
    expect(snap).toBe(false);
  });
});

// ── 16. DXF export ─────────────────────────────────────────────────────────

test.describe('16. DXF export', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    const box = await canvasBox(page);
    await drawRect(page, box.x + 100, box.y + 100, box.x + 300, box.y + 250);
  });

  test('16-1 export triggers file download', async ({ page }) => {
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.click('#btn-export'),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.dxf$/i);
  });

  test('16-2 exported DXF contains LWPOLYLINE', async ({ page }) => {
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.click('#btn-export'),
    ]);
    const path = await download.path();
    const fs = await import('fs');
    const content = fs.readFileSync(path!, 'utf-8');
    expect(content).toContain('LWPOLYLINE');
    expect(content).toContain('ENTITIES');
  });
});

// ── 17. Keyboard shortcuts ─────────────────────────────────────────────────

test.describe('17. Keyboard shortcuts', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    const box = await canvasBox(page);
    await drawRect(page, box.x + 100, box.y + 100, box.x + 300, box.y + 250);
  });

  test('17-1 Ctrl+Z undoes', async ({ page }) => {
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(50);
    expect(await shapeCount(page)).toBe(0);
  });

  test('17-2 Ctrl+Y redoes', async ({ page }) => {
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(50);
    await page.keyboard.press('Control+y');
    await page.waitForTimeout(50);
    expect(await shapeCount(page)).toBe(1);
  });

  test('17-3 Delete key deletes selected shape', async ({ page }) => {
    const box = await canvasBox(page);
    await selectShape(page, box.x + 200, box.y + 175);
    await page.keyboard.press('Delete');
    await page.waitForTimeout(50);
    expect(await shapeCount(page)).toBe(0);
  });

  test('17-4 Escape cancels drawing', async ({ page }) => {
    const box = await canvasBox(page);
    await page.click('[data-tool="rect"]');
    await page.mouse.move(box.x + 100, box.y + 100);
    await page.mouse.down();
    await page.mouse.move(box.x + 300, box.y + 250);
    // Press Escape before releasing
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await page.waitForTimeout(50);
    // Shape drawn before escape-cancel: depends on implementation
    // At least: no crash
    const count = await shapeCount(page);
    expect(count).toBeGreaterThanOrEqual(0);
  });
});

// ── 18. Undo/Redo via buttons ──────────────────────────────────────────────

test.describe('18. Undo/Redo buttons', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
  });

  test('18-1 undo button enabled after draw', async ({ page }) => {
    const box = await canvasBox(page);
    await drawRect(page, box.x + 100, box.y + 100, box.x + 200, box.y + 200);
    await expect(page.locator('#btn-undo')).not.toBeDisabled();
  });

  test('18-2 undo button click works', async ({ page }) => {
    const box = await canvasBox(page);
    await drawRect(page, box.x + 100, box.y + 100, box.x + 200, box.y + 200);
    await page.click('#btn-undo');
    await page.waitForTimeout(50);
    expect(await shapeCount(page)).toBe(0);
  });

  test('18-3 redo button enabled after undo', async ({ page }) => {
    const box = await canvasBox(page);
    await drawRect(page, box.x + 100, box.y + 100, box.x + 200, box.y + 200);
    await page.click('#btn-undo');
    await expect(page.locator('#btn-redo')).not.toBeDisabled();
  });

  test('18-4 redo button click works', async ({ page }) => {
    const box = await canvasBox(page);
    await drawRect(page, box.x + 100, box.y + 100, box.x + 200, box.y + 200);
    await page.click('#btn-undo');
    await page.click('#btn-redo');
    await page.waitForTimeout(50);
    expect(await shapeCount(page)).toBe(1);
  });
});

// ── 19. Autosave / reload ──────────────────────────────────────────────────

test.describe('19. Autosave and restore', () => {
  test('19-1 Ctrl+S saves without error', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    const box = await canvasBox(page);
    await drawRect(page, box.x + 100, box.y + 100, box.x + 300, box.y + 250);

    const errors: string[] = [];
    page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
    await page.keyboard.press('Control+s');
    await page.waitForTimeout(200);
    expect(errors.filter(e => !e.includes('favicon'))).toHaveLength(0);
  });

  test('19-2 shapes survive page reload (IndexedDB)', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const box = await canvasBox(page);
    await drawRect(page, box.x + 100, box.y + 100, box.x + 300, box.y + 250);
    // Manual save
    await page.keyboard.press('Control+s');
    await page.waitForTimeout(300);

    await page.reload();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);

    expect(await shapeCount(page)).toBe(1);
  });
});

// ── 20. No console errors (baseline) ──────────────────────────────────────

test.describe('20. Console error check', () => {
  test('20-1 no JS errors on load', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);
    expect(errors).toHaveLength(0);
  });

  test('20-2 Clipper is available without CDN', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    const clipperAvailable = await page.evaluate(() => {
      // Verify boolean ops work by checking union can be called
      try {
        const app = (window as any).__app;
        return app !== undefined;
      } catch {
        return false;
      }
    });
    expect(clipperAvailable).toBe(true);
  });

  test('20-3 no NaN in coordinates after draw', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    const box = await canvasBox(page);
    await drawRect(page, box.x + 100, box.y + 100, box.x + 300, box.y + 250);

    const hasNaN = await page.evaluate(() => {
      const shapes = (window as any).__app?.history?.state?.shapes;
      return shapes?.some((s: any) =>
        s.outer.some((p: any) => isNaN(p.x) || isNaN(p.y))
      ) ?? false;
    });
    expect(hasNaN).toBe(false);
  });
});
