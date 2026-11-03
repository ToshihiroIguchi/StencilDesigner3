import { test, expect } from '@playwright/test';

test('locking a layer makes its shapes unselectable and is undoable', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(500);
  await page.evaluate(() => (window as unknown as { __app?: { resetForTests?: () => Promise<void> } }).__app?.resetForTests?.().catch(() => {}));
  await page.waitForTimeout(200);

  const box = await page.locator('#main-canvas').boundingBox();
  expect(box).not.toBeNull();
  const b = box!;

  await page.keyboard.press('r');
  await page.mouse.move(b.x + 200, b.y + 200);
  await page.mouse.down();
  await page.mouse.move(b.x + 400, b.y + 350);
  await page.mouse.up();
  await page.waitForTimeout(200);

  const selCount = () => page.evaluate(
    () => (window as unknown as { __app: { history: { state: { selection: unknown[] } } } }).__app.history.state.selection.length,
  );

  await page.keyboard.press('v');
  await page.mouse.click(b.x + 300, b.y + 275);
  await page.mouse.click(b.x + 205, b.y + 205);
  expect(await selCount()).toBeGreaterThan(0);

  const lockBtn = page.locator('.layer-row[data-layer="0"] .lyr-lock');
  await expect(lockBtn).toHaveAttribute('aria-pressed', 'false');
  await lockBtn.click();
  await expect(lockBtn).toHaveAttribute('aria-pressed', 'true');
  expect(await selCount()).toBe(0);

  await page.mouse.click(b.x + 205, b.y + 205);
  await page.mouse.click(b.x + 300, b.y + 275);
  expect(await selCount()).toBe(0);

  await page.keyboard.press('Control+z');
  await expect(page.locator('.layer-row[data-layer="0"] .lyr-lock')).toHaveAttribute('aria-pressed', 'false');
});
