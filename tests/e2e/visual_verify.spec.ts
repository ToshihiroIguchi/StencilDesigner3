import { test, expect } from '@playwright/test';

test('visual verification for StencilDesigner3 improvements', async ({ page }) => {
  // Configure browser display pixel ratio if supported
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1000); // Allow IndexedDB and Canvas to fully initialize

  // Draw a quick box to test selection, properties and fit
  // Click at coordinate (150, 150) then (300, 250) on main canvas
  await page.keyboard.press('r'); // Activate Box tool
  const canvas = page.locator('#main-canvas');
  const box = await canvas.boundingBox();
  if (box) {
    await page.mouse.move(box.x + 200, box.y + 200);
    await page.mouse.down();
    await page.mouse.move(box.x + 400, box.y + 350);
    await page.mouse.up();
    await page.waitForTimeout(300);
  }

  // Deselect the box to view it clearly and test fit
  await page.keyboard.press('Home'); // Trigger Fit to content
  await page.waitForTimeout(300);

  // 1. Capture dark theme with origin marker, drawn box and footer Sel count
  await page.screenshot({ path: 'verify_initial_dpr.png' });

  // 2. Open keyboard shortcuts help modal
  await page.keyboard.press('?');
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'verify_help_dpr.png' });

  // 3. Close shortcut modal and switch to light theme
  await page.click('#shortcut-close');
  await page.click('#btn-theme');
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'verify_light_dpr.png' });
});
