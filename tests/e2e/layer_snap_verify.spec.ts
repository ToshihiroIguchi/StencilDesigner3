import { test, expect } from '@playwright/test';

test('verify snapping across different layers visually in the browser', async ({ page }) => {
  // Go to the running preview server
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1000); // Allow IndexedDB and Canvas to initialize

  // Ensure canvas is visible
  const canvas = page.locator('#main-canvas');
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();

  if (box) {
    // Clear state so tests start clean
    await page.evaluate(() => (window as any).__app?.resetForTests?.().catch(() => {}));
    await page.waitForTimeout(200);

    // 1. Draw static rectangle on Layer "0" (default) from (100, 100) to (300, 200)
    await page.keyboard.press('r'); // Activate Rectangle tool
    await page.mouse.move(box.x + 100, box.y + 100);
    await page.mouse.down();
    await page.mouse.move(box.x + 300, box.y + 200);
    await page.mouse.up();
    await page.waitForTimeout(300);

    // 2. Programmatically add a new layer "Layer-1" (magenta) and set it as active
    await page.evaluate(() => {
      const app = (window as any).__app;
      if (app && app.history && app.history.state) {
        const state = app.history.state;
        const newLayer = {
          name: 'Layer-1',
          color: '#ff00ff', // Magenta
          linetype: 'CONTINUOUS',
          lineweight: -1,
          visible: true,
          locked: false,
          plot: true,
          isAperture: false
        };
        // Add layer if it doesn't exist
        if (!state.layers.some((l: any) => l.name === 'Layer-1')) {
          state.layers.push(newLayer);
        }
        state.activeLayerName = 'Layer-1';
        app.requestRender();
      }
    });
    await page.waitForTimeout(300);

    // 3. Draw moving rectangle from (400, 300) to (600, 400).
    // Because Layer-1 is active, this shape will belong to Layer-1.
    await page.keyboard.press('r'); // Re-activate Rectangle tool
    await page.mouse.move(box.x + 400, box.y + 300);
    await page.mouse.down();
    await page.mouse.move(box.x + 600, box.y + 400);
    await page.mouse.up();
    await page.waitForTimeout(300);

    // 4. Switch to Select tool
    await page.keyboard.press('v'); // Activate Select tool
    await page.waitForTimeout(300);

    // 5. Click-drag the moving rectangle (Layer-1) from its center (500, 350)
    // We want to drag it near the bottom-right corner of the static rectangle (Layer "0") at (300, 200).
    await page.mouse.move(box.x + 500, box.y + 350); // Move to center of moving rectangle
    await page.mouse.down(); // Press and hold to start dragging
    await page.waitForTimeout(100);

    // Drag close to alignment (top-left of moving rect snaps to bottom-right of static rect)
    await page.mouse.move(box.x + 395, box.y + 245);
    await page.waitForTimeout(500); // Wait for rendering of snapping markers

    // 6. Capture screenshot showing snapping across layers
    await page.screenshot({ path: 'verify_layer_snapping.png' });
    console.log('Successfully captured verify_layer_snapping.png!');

    // Release mouse
    await page.mouse.up();
    await page.waitForTimeout(200);
  }
});
