import { test, expect, type Page } from '@playwright/test';

// ── Helper functions ────────────────────────────────────────────────────────

async function gotoAndCloseModal(page: Page) {
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
}

// ── Test suite ──────────────────────────────────────────────────────────────

test.describe('Dynamic branding / config verification', () => {

  test('appName only - verifies logo, tab title, and auto-sanitized default output filename', async ({ page }) => {
    // Mock the config.json request to return data that specifies appName only
    await page.route('**/config.json', (route) => {
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          appName: 'CustomStencilCAD',
        }),
      });
    });

    await gotoAndCloseModal(page);

    // 1. Verify the top-left logo text is updated
    const logoText = page.locator('#app-logo-text');
    await expect(logoText).toHaveText('CustomStencilCAD');

    // 2. Verify the hidden title text is updated
    const hiddenTitle = page.locator('#app-title-hidden');
    await expect(hiddenTitle).toHaveText('CustomStencilCAD');

    // 3. Verify the browser tab title is auto-derived (default: "{docName} - {appName}" -> "Untitled - CustomStencilCAD")
    await expect(page).toHaveTitle('Untitled - CustomStencilCAD');

    // 4. Verify DXF export auto-uses a lowercased & sanitized filename
    // An empty file would cause an export error, so draw one temporary rectangle
    await page.click('[data-tool="rect"]');
    const canvas = page.locator('#main-canvas');
    const box = await canvas.boundingBox();
    if (box) {
      await page.mouse.move(box.x + 100, box.y + 100);
      await page.mouse.down();
      await page.mouse.move(box.x + 300, box.y + 250);
      await page.mouse.up();
    }

    // Run the DXF export and check the suggested filename
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      (async () => {
        await page.click('#btn-file-menu');
        await page.click('.file-menu-item[data-action="export-dxf"]');
      })(),
    ]);
    expect(download.suggestedFilename()).toBe('customstencilcad.dxf');
  });

  test('all fields specified - verifies custom tab title template and filename', async ({ page }) => {
    // Mock the config.json request to return data that explicitly specifies every field
    await page.route('**/config.json', (route) => {
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          appName: 'LaserCutterCAD',
          tabTitleTemplate: 'ようこそ {appName} へ | {docName}',
          defaultFilename: 'laser-project-file',
        }),
      });
    });

    await gotoAndCloseModal(page);

    // 1. Verify the logo text
    const logoText = page.locator('#app-logo-text');
    await expect(logoText).toHaveText('LaserCutterCAD');

    // 2. Verify the specified custom tab title template is applied
    await expect(page).toHaveTitle('ようこそ LaserCutterCAD へ | Untitled');

    // 3. Draw a temporary rectangle
    await page.click('[data-tool="rect"]');
    const canvas = page.locator('#main-canvas');
    const box = await canvas.boundingBox();
    if (box) {
      await page.mouse.move(box.x + 100, box.y + 100);
      await page.mouse.down();
      await page.mouse.move(box.x + 300, box.y + 250);
      await page.mouse.up();
    }

    // 4. Verify DXF is saved with the explicitly configured default filename
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      (async () => {
        await page.click('#btn-file-menu');
        await page.click('.file-menu-item[data-action="export-dxf"]');
      })(),
    ]);
    expect(download.suggestedFilename()).toBe('laser-project-file.dxf');
  });

});
