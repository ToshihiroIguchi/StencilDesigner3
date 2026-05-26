import { test, expect } from '@playwright/test';

test('verify spacebar panning, cursor transitions, and state updates', async ({ page }) => {
  // 1. Load the application
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1000); // Allow IndexedDB and Canvas to fully initialize

  const canvas = page.locator('#main-canvas');
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();

  if (!box) return;

  // Move mouse to the center of the canvas
  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;
  await page.mouse.move(centerX, centerY);

  // Get initial pan state
  const initialPan = await page.evaluate(() => {
    const app = (window as any).__app;
    return app ? { panX: app.history.state.panX, panY: app.history.state.panY } : null;
  });
  expect(initialPan).not.toBeNull();
  if (!initialPan) return;

  // 2. Press Space bar down to show grab cursor (✋)
  await page.keyboard.down(' ');
  await page.waitForTimeout(200);

  // Take screenshot of grab cursor state
  await page.screenshot({ path: 'verify_pan_01_grab.png' });

  // 3. Left-click down to show grabbing cursor (✊)
  await page.mouse.down();
  await page.waitForTimeout(200);

  // Take screenshot of grabbing cursor state
  await page.screenshot({ path: 'verify_pan_02_grabbing.png' });

  // 4. Drag mouse to pan (e.g. move by +150px right, +100px down)
  await page.mouse.move(centerX + 150, centerY + 100);
  await page.waitForTimeout(200);

  // 5. Release mouse and Space key
  await page.mouse.up();
  await page.keyboard.up(' ');
  await page.waitForTimeout(500);

  // Take screenshot of final panned state
  await page.screenshot({ path: 'verify_pan_03_final.png' });

  // Get final pan state
  const finalPan = await page.evaluate(() => {
    const app = (window as any).__app;
    return app ? { panX: app.history.state.panX, panY: app.history.state.panY } : null;
  });
  expect(finalPan).not.toBeNull();
  if (!finalPan) return;

  // Assert that panning coordinates updated correctly
  expect(finalPan.panX).toBe(initialPan.panX + 150);
  expect(finalPan.panY).toBe(initialPan.panY + 100);

  console.log('Panning verification succeeded!');
  console.log(`Initial pan: (${initialPan.panX}, ${initialPan.panY})`);
  console.log(`Final pan: (${finalPan.panX}, ${finalPan.panY})`);
});
