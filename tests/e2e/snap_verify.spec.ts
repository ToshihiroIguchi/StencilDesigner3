import { test, expect } from '@playwright/test';

test('verify proximity smart snapping visually in the browser', async ({ page }) => {
  // Go to the running preview server
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1000); // Allow IndexedDB and Canvas to initialize

  // Ensure canvas is visible
  const canvas = page.locator('#main-canvas');
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();

  if (box) {
    // 1. Draw static rectangle from (100, 100) to (300, 200)
    await page.keyboard.press('r'); // Activate Rectangle tool
    await page.mouse.move(box.x + 100, box.y + 100);
    await page.mouse.down();
    await page.mouse.move(box.x + 300, box.y + 200);
    await page.mouse.up();
    await page.waitForTimeout(300);

    // 2. Draw moving rectangle from (400, 300) to (600, 400)
    await page.keyboard.press('r'); // Re-activate Rectangle tool
    await page.mouse.move(box.x + 400, box.y + 300);
    await page.mouse.down();
    await page.mouse.move(box.x + 600, box.y + 400);
    await page.mouse.up();
    await page.waitForTimeout(300);

    // 3. Switch to Select tool
    await page.keyboard.press('v'); // Activate Select tool
    await page.waitForTimeout(300);

    // 4. Click-drag the moving rectangle from its center (500, 350)
    // We want to drag it near the bottom-right corner of the static rectangle (300, 200).
    // The top-left corner of the moving rectangle is at (400, 300).
    // Moving the mouse by (-100, -100) translates it exactly there.
    // Let's drag it close to that (e.g. mouse to 500-100-5, 350-100-5 = 395, 245).
    await page.mouse.move(box.x + 500, box.y + 350); // Move to center of moving rectangle
    await page.mouse.down(); // Press and hold to start dragging
    await page.waitForTimeout(100);

    // Drag close to alignment (top-left of moving rect snaps to bottom-right of static rect)
    await page.mouse.move(box.x + 395, box.y + 245);
    await page.waitForTimeout(500); // Wait for rendering of snapping markers

    // 5. Capture screenshot of the active snapping state (showing orange dashed guideline & indicators)
    await page.screenshot({ path: 'verify_snapping.png' });
    console.log('Successfully captured verify_snapping.png!');

    // Release mouse
    await page.mouse.up();
    await page.waitForTimeout(200);
  }
});
