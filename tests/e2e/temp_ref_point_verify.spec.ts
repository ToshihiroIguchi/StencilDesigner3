import { test, expect } from '@playwright/test';

test('verify temporary reference point and snap tracker in the browser', async ({ page }) => {
  // Capture page logs and errors
  page.on('console', msg => console.log('BROWSER LOG:', msg.text()));
  page.on('pageerror', exception => console.log('BROWSER EXCEPTION:', exception.message));

  // 1. Go to the app page
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1000); // Allow IndexedDB and Canvas to initialize

  const canvas = page.locator('#main-canvas');
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();

  if (box) {
    console.log(`Canvas BoundingBox: x=${box.x}, y=${box.y}, w=${box.width}, h=${box.height}`);

    // 2. Click on the canvas center to focus the page
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(300);

    // 3. Switch to Select tool (V)
    await page.keyboard.press('v');
    await page.waitForTimeout(300);

    // 4. Move mouse to (300, 200) to trigger a mousemove event on the canvas
    await page.mouse.move(box.x + 300, box.y + 200);
    await page.waitForTimeout(300);

    // 5. Press 'g' to drop the temporary reference point at the snapped grid coordinate
    await page.keyboard.press('g');
    await page.waitForTimeout(300);

    // 6. Assert the relative coordinate container is visible in the UI
    const relCoordsContainer = page.locator('#footer-rel-coords');
    await expect(relCoordsContainer).toBeVisible();

    // 7. Move the mouse to another point (e.g. 400, 300) to see non-zero relative distances
    await page.mouse.move(box.x + 400, box.y + 300);
    await page.waitForTimeout(500); // Wait for rendering of guidelines and footer update

    // 8. Verify that the relative coordinate values update
    const rcText = await page.locator('#footer-rc').textContent();
    expect(rcText).toContain('dX:');
    expect(rcText).toContain('dY:');
    console.log('Relative coordinate updated successfully:', rcText);

    // 9. Capture a beautiful screenshot of the temporary guide axes and pink crosshairs
    await page.screenshot({ path: 'verify_temp_ref_point.png' });
    console.log('Successfully captured verify_temp_ref_point.png!');

    // 10. Press 'Escape' to clear the temporary reference point
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    // 11. Assert that the relative coordinates container is hidden again
    await expect(relCoordsContainer).toBeHidden();
    console.log('Successfully cleared temporary reference point and hid UI container.');
  }
});
