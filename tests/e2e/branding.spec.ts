import { test, expect, type Page } from '@playwright/test';

// ── ヘルパー関数 ────────────────────────────────────────────────────────────

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

// ── テストスイート ──────────────────────────────────────────────────────────

test.describe('動的ブランディング・設定の検証', () => {

  test('appName のみを指定した場合 - ロゴ、タブ名、および自動サニタイズされたデフォルト出力ファイル名の検証', async ({ page }) => {
    // config.json のリクエストをモックして、appName のみを指定したデータを返す
    await page.route('**/config.json', (route) => {
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          appName: 'CustomStencilCAD',
        }),
      });
    });

    await gotoAndCloseModal(page);

    // 1. 左上のロゴテキストが更新されていることを確認
    const logoText = page.locator('#app-logo-text');
    await expect(logoText).toHaveText('CustomStencilCAD');

    // 2. 隠しタイトルテキストが更新されていることを確認
    const hiddenTitle = page.locator('#app-title-hidden');
    await expect(hiddenTitle).toHaveText('CustomStencilCAD');

    // 3. ブラウザのタブ名が自動導出されていることを確認（デフォルト: "{docName} - {appName}" → "Untitled - CustomStencilCAD"）
    await expect(page).toHaveTitle('Untitled - CustomStencilCAD');

    // 4. DXF出力時に自動で小文字＆サニタイズされたファイル名が使われることを確認
    // 空ファイルだと出力エラーになるため、仮の矩形を1個描画する
    await page.click('[data-tool="rect"]');
    const canvas = page.locator('#main-canvas');
    const box = await canvas.boundingBox();
    if (box) {
      await page.mouse.move(box.x + 100, box.y + 100);
      await page.mouse.down();
      await page.mouse.move(box.x + 300, box.y + 250);
      await page.mouse.up();
    }

    // DXFエクスポートを実行し、提案されるファイル名を確認
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      (async () => {
        await page.click('#btn-file-menu');
        await page.click('.file-menu-item[data-action="export-dxf"]');
      })(),
    ]);
    expect(download.suggestedFilename()).toBe('customstencilcad.dxf');
  });

  test('全項目を指定した場合 - カスタムのタブ名テンプレートおよびファイル名の検証', async ({ page }) => {
    // config.json のリクエストをモックして、すべての項目を明示的に指定したデータを返す
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

    // 1. ロゴテキストの確認
    const logoText = page.locator('#app-logo-text');
    await expect(logoText).toHaveText('LaserCutterCAD');

    // 2. 指定されたカスタムのタブ名テンプレートが反映されていることを確認
    await expect(page).toHaveTitle('ようこそ LaserCutterCAD へ | Untitled');

    // 3. 仮の矩形を描画
    await page.click('[data-tool="rect"]');
    const canvas = page.locator('#main-canvas');
    const box = await canvas.boundingBox();
    if (box) {
      await page.mouse.move(box.x + 100, box.y + 100);
      await page.mouse.down();
      await page.mouse.move(box.x + 300, box.y + 250);
      await page.mouse.up();
    }

    // 4. 明示的に設定されたデフォルトファイル名でDXFが保存されることを確認
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
