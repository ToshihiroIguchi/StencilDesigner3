import { test, expect, type Page } from '@playwright/test';

async function openFresh(page: Page) {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(500);
  await page.evaluate(() => (window as unknown as { __app?: { resetForTests?: () => Promise<void> } }).__app?.resetForTests?.().catch(() => {}));
  await page.waitForTimeout(200);
}

async function addLayer(page: Page, name: string) {
  await page.locator('#btn-layer-add').click();
  await page.locator('#input-modal-field').fill(name);
  await page.locator('#input-modal-ok').click();
}

async function dismissMessage(page: Page): Promise<string> {
  const msg = page.locator('#message-modal-msg');
  await expect(msg).toBeVisible();
  const text = (await msg.textContent()) ?? '';
  await page.locator('#message-modal-ok').click();
  return text;
}

test('layer names are case-insensitive and DIMENSIONS is reserved', async ({ page }) => {
  await openFresh(page);

  await addLayer(page, 'Wall');
  await expect(page.locator('.layer-row[data-layer="Wall"]')).toHaveCount(1);

  await addLayer(page, 'WALL');
  expect(await dismissMessage(page)).toContain('already exists');
  await expect(page.locator('.layer-row')).toHaveCount(2);

  await addLayer(page, 'dimensions');
  expect(await dismissMessage(page)).toContain('reserved');
  await expect(page.locator('.layer-row')).toHaveCount(2);
});

test('dimension tool refuses to create items while the DIMENSIONS layer is hidden', async ({ page }) => {
  await openFresh(page);
  const box = (await page.locator('#main-canvas').boundingBox())!;
  const dimCount = () => page.evaluate(
    () => (window as unknown as { __app: { history: { state: { dimensions: unknown[] } } } }).__app.history.state.dimensions.length,
  );

  // Draw one dimension so that the DIMENSIONS layer is created.
  await page.keyboard.press('d');
  await page.mouse.click(box.x + 200, box.y + 300);
  await page.mouse.click(box.x + 400, box.y + 300);
  await page.mouse.click(box.x + 300, box.y + 250);
  await expect.poll(dimCount).toBe(1);

  const row = page.locator('.layer-row[data-layer="DIMENSIONS"]');
  await expect(row).toHaveCount(1);

  // DIMENSIONS cannot be renamed.
  await row.locator('.lyr-name').dblclick();
  expect(await dismissMessage(page)).toContain('cannot be renamed');
  // Clicking its name must not make it the drawing layer.
  expect(await page.evaluate(
    () => (window as unknown as { __app: { history: { state: { activeLayerName: string } } } }).__app.history.state.activeLayerName,
  )).toBe('0');

  // Hide it; the tool must now refuse and tell the user why.
  await row.locator('.lyr-vis').click();
  await page.keyboard.press('Escape');
  await page.keyboard.press('d');
  await page.mouse.click(box.x + 200, box.y + 400);
  await expect(page.locator('#footer-w')).toContainText('DIMENSIONS layer is hidden');
  expect(await dimCount()).toBe(1);

  // Lock (and show) it; the message changes to "locked".
  await row.locator('.lyr-vis').click();
  await row.locator('.lyr-lock').click();
  await page.mouse.click(box.x + 220, box.y + 420);
  await expect(page.locator('#footer-w')).toContainText('DIMENSIONS layer is locked');
  expect(await dimCount()).toBe(1);
});
