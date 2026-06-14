import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FIXTURE_DIR = fileURLToPath(new URL('../../test/fixtures/dwg/', import.meta.url));

/** Loads the app, waits for it to boot, and dismisses the file-manager modal. */
async function gotoAndCloseModal(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => (window as any).__app !== undefined, { timeout: 15000 });
  const modal = page.locator('#file-manager-modal');
  if (await modal.isVisible()) {
    await page.evaluate(async () => {
      const app = (window as any).__app;
      const m = document.getElementById('file-manager-modal');
      if (app && m) { await app.newDoc(); m.style.display = 'none'; }
    });
    await page.waitForTimeout(200);
  }
  await page.evaluate(() => (window as any).__app?.resetForTests?.().catch(() => {}));
}

/** Subscribes to console/page errors and returns the collected message list. */
function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', (err) => { errors.push(err.message); });
  return errors;
}

/**
 * Drives the real drag-and-drop path: reads the fixture in Node, hands the bytes
 * to the page, and dispatches a synthetic drop carrying a File on `document`
 * (the app reads `e.dataTransfer.files[0]`).
 */
async function dropDwg(page: Page, fileName: string): Promise<void> {
  const bytes = Array.from(readFileSync(FIXTURE_DIR + fileName));
  await page.evaluate(
    ({ name, data }) => {
      const file = new File([new Uint8Array(data)], name, { type: 'application/octet-stream' });
      const dt = new DataTransfer();
      dt.items.add(file);
      // Firefox ignores `dataTransfer` passed to the DragEvent constructor, so attach
      // it as an own property — the app only reads `e.dataTransfer.files[0]`.
      for (const type of ['dragenter', 'dragover', 'drop']) {
        const evt = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(evt, 'dataTransfer', { value: dt });
        document.dispatchEvent(evt);
      }
    },
    { name: fileName, data: bytes },
  );
}

/** Reads the current shape count from app state. */
function shapeCount(page: Page): Promise<number> {
  return page.evaluate(() => (window as any).__app?.history?.state?.shapes?.length ?? 0);
}

/** Waits for either the import dialog to appear or shapes to land (no-dialog path), then confirms. */
async function waitForImportAndConfirm(page: Page): Promise<void> {
  const modal = page.locator('#dxf-import-modal');
  await page.waitForFunction(
    () => {
      const m = document.getElementById('dxf-import-modal');
      const dialogOpen = !!m && getComputedStyle(m).display !== 'none';
      const shapes = (window as any).__app?.history?.state?.shapes?.length ?? 0;
      return dialogOpen || shapes > 0;
    },
    { timeout: 30000 },
  );
  if (await modal.isVisible()) {
    await page.locator('#dxf-import-ok').click();
  }
}

test.describe('DWG import', () => {
  test('example_2018.dwg: drop → dialog → canvas with integer-µm shapes, no console errors', async ({ page }) => {
    test.setTimeout(60000); // WASM decode in a worker, run under parallel load
    const errors = collectErrors(page);
    await gotoAndCloseModal(page);
    expect(await shapeCount(page)).toBe(0);

    await dropDwg(page, 'example_2018.dwg');

    // A fresh document has no matching layers, so the import dialog must appear.
    const modal = page.locator('#dxf-import-modal');
    await expect(modal).toBeVisible({ timeout: 30000 });
    await expect(page.locator('#dxf-import-layers')).toContainText(/\(\d+ shapes\)/);

    await page.locator('#dxf-import-ok').click();

    // Geometry reached app state.
    await expect.poll(() => shapeCount(page)).toBeGreaterThan(0);

    // Every vertex is an integer (µm) and the bounding box is finite.
    const geom = await page.evaluate(() => {
      const shapes = (window as any).__app.history.state.shapes as Array<{
        outer: Array<{ x: number; y: number }>;
        holes: Array<Array<{ x: number; y: number }>>;
      }>;
      let allInt = true;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const s of shapes) {
        for (const ring of [s.outer, ...s.holes]) {
          for (const v of ring) {
            if (!Number.isInteger(v.x) || !Number.isInteger(v.y)) allInt = false;
            minX = Math.min(minX, v.x); minY = Math.min(minY, v.y);
            maxX = Math.max(maxX, v.x); maxY = Math.max(maxY, v.y);
          }
        }
      }
      return { allInt, bboxFinite: Number.isFinite(minX) && Number.isFinite(maxX) && maxX > minX && maxY > minY };
    });
    expect(geom.allInt).toBe(true);
    expect(geom.bboxFinite).toBe(true);

    expect(errors).toEqual([]);
  });

  test('Dynblocks.dwg: heavy file imports via worker without freezing the UI', async ({ page }) => {
    test.setTimeout(120000); // ~2.1 MB block-heavy DWG; slow WASM decode under parallel load
    await gotoAndCloseModal(page);

    // Start a requestAnimationFrame counter: it keeps ticking only if the main
    // thread is not blocked while the worker decodes the DWG.
    await page.evaluate(() => {
      (window as any).__rafTicks = 0;
      const tick = () => { (window as any).__rafTicks++; requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    });

    await dropDwg(page, 'Dynblocks.dwg');

    // The loading overlay signals the decode was offloaded asynchronously.
    await expect(page.locator('#loading-overlay')).toBeVisible({ timeout: 5000 });

    await waitForImportAndConfirm(page);

    // The main thread kept animating throughout the parse → no freeze.
    const ticks = await page.evaluate(() => (window as any).__rafTicks as number);
    expect(ticks).toBeGreaterThan(5);

    // Block expansion produced geometry.
    await expect.poll(() => shapeCount(page)).toBeGreaterThan(0);
  });
});
