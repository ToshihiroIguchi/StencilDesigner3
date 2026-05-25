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

    // Inject both horizontal and vertical dimension lines via state evaluation
    // to ensure 100% reliable positioning, gaps, arrowheads, and labels
    await page.evaluate(() => {
      const app = (window as any).__app;
      if (app && app.history && app.history.state) {
        const state = app.history.state;
        const shapes = state.shapes;
        if (shapes.length > 0) {
          const boxShape = shapes[0];
          
          // Sort outer ring vertices to find top-left and top-right (for linear-h)
          const sortedY = [...boxShape.outer].sort((a, b) => a.y - b.y || a.x - b.x);
          const vTL = sortedY[0];
          const vTR = sortedY[1];
          
          // Sort outer ring vertices to find top-left and bottom-left (for linear-v)
          const sortedX = [...boxShape.outer].sort((a, b) => a.x - b.x || a.y - b.y);
          const vBL = sortedX[sortedX.length - 1]; // bottom-left or bottom-right
          
          // Ensure DIMENSIONS layer is created and visible
          let dimLayer = state.layers.find((l: any) => l.name === 'DIMENSIONS');
          if (!dimLayer) {
            dimLayer = {
              name: 'DIMENSIONS',
              color: '#aabbdd',
              linetype: 'CONTINUOUS',
              lineweight: -1,
              visible: true,
              locked: false,
              plot: false,
              isAperture: false
            };
            state.layers.push(dimLayer);
          } else {
            dimLayer.visible = true;
          }
          
          // Add horizontal dimension line
          state.dimensions.push({
            id: 'dim_test_h',
            kind: 'linear-h',
            anchor1: {
              kind: 'vertex',
              shapeId: boxShape.id,
              ringIndex: -1,
              vertexId: vTL.id,
              cachedPoint: { x: vTL.x, y: vTL.y }
            },
            anchor2: {
              kind: 'vertex',
              shapeId: boxShape.id,
              ringIndex: -1,
              vertexId: vTR.id,
              cachedPoint: { x: vTR.x, y: vTR.y }
            },
            offset: vTL.y - 3000, // 3mm above top edge
            layer: 'DIMENSIONS',
            frozen: false
          });
          
          // Add vertical dimension line
          // Find the actual bottom-left by sorting left vertices
          const leftVerts = [...boxShape.outer].filter(v => Math.abs(v.x - vTL.x) < 100);
          const vLeftBottom = leftVerts.sort((a, b) => b.y - a.y)[0];
          
          state.dimensions.push({
            id: 'dim_test_v',
            kind: 'linear-v',
            anchor1: {
              kind: 'vertex',
              shapeId: boxShape.id,
              ringIndex: -1,
              vertexId: vTL.id,
              cachedPoint: { x: vTL.x, y: vTL.y }
            },
            anchor2: {
              kind: 'vertex',
              shapeId: boxShape.id,
              ringIndex: -1,
              vertexId: vLeftBottom.id,
              cachedPoint: { x: vLeftBottom.x, y: vLeftBottom.y }
            },
            offset: vTL.x - 3000, // 3mm left of left edge
            layer: 'DIMENSIONS',
            frozen: false
          });
          
          app.requestRender();
        }
      }
    });
    await page.waitForTimeout(500);
  }

  // Deselect the box and fit view
  await page.keyboard.press('Home'); // Trigger Fit to content
  await page.waitForTimeout(500);

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
