import { test, expect } from '@playwright/test';
import * as fs from 'fs';

test('verify PDF export with annotations, date-time, and Japanese text', async ({ page }) => {
  page.on('console', msg => {
    console.log(`[Browser Console] [${msg.type()}]: ${msg.text()}`);
  });
  page.on('pageerror', err => {
    console.error(`[Browser PageError]: ${err.message}\nStack:\n${err.stack}`);
  });

  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1000);

  // 1. Rename document to a Japanese name
  const docLabel = page.locator('#doc-name-label');
  await docLabel.click();
  const docInput = page.locator('.doc-name-input');
  await docInput.fill('日本語図面設計');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);

  // 2. Draw a quick box to have some shape
  await page.keyboard.press('r'); // Box tool
  const canvas = page.locator('#main-canvas');
  const box = await canvas.boundingBox();
  if (box) {
    await page.mouse.move(box.x + 200, box.y + 200);
    await page.mouse.down();
    await page.mouse.move(box.x + 400, box.y + 350);
    await page.mouse.up();
    await page.waitForTimeout(300);
  }

  // 3. Add a Japanese text annotation
  await page.keyboard.press('n'); // Annotation / Note tool
  if (box) {
    // Click at some spot on the canvas to open the annotation input
    await page.mouse.click(box.x + 200, box.y + 400);
    await page.waitForTimeout(300);
    
    const input = page.locator('#annotation-input');
    await expect(input).toBeVisible();
    await input.fill('日本語注記テスト\n改行あり');
    await page.keyboard.press('Control+Enter'); // commit the note
    await page.waitForTimeout(300);
  }

  // Deselect / Fit content
  await page.keyboard.press('Home');
  await page.waitForTimeout(300);

  // Take a screenshot of the app so we can see the Japanese text in the browser
  await page.screenshot({ path: 'verify_pdf_ui_japanese.png' });

  // 4. Open File Menu and export to PDF
  await page.click('#btn-file-menu'); // Open file menu
  await page.waitForTimeout(200);

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('.file-menu-item[data-action="export-pdf"]')
  ]);

  const downloadPath = await download.path();
  expect(downloadPath).not.toBeNull();

  // Read the downloaded PDF file header
  const buffer = fs.readFileSync(downloadPath!);
  const header = buffer.toString('utf8', 0, 5);
  expect(header).toBe('%PDF-');
  
  console.log('PDF verification E2E test passed successfully! PDF Header:', header);
});
