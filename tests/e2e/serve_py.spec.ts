import { test, expect } from '@playwright/test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PYTHON = process.platform === 'win32' ? 'python' : 'python3';
const hasPython = spawnSync(PYTHON, ['--version']).status === 0;

test.skip(!hasPython, 'Python is not available');

async function startServe(port: number, extra: string[] = []): Promise<ChildProcess> {
  const proc = spawn(PYTHON, ['serve.py', '--no-browser', '--port', String(port), ...extra], { stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/`);
      if (r.ok) return proc;
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  proc.kill();
  throw new Error('serve.py did not start');
}

// Each parallel worker gets its own port, so the chromium and firefox projects never collide.
const portFor = (parallelIndex: number) => 8610 + parallelIndex;

test('serve.py serves ES modules and WASM with correct MIME types', async ({}, testInfo) => {
  const port = portFor(testInfo.parallelIndex);
  const proc = await startServe(port);
  try {
    const base = `http://127.0.0.1:${port}`;
    const assets = readdirSync('dist/assets');
    const js = assets.find((f) => /^index-.*\.js$/.test(f))!;
    const wasm = assets.find((f) => f.endsWith('.wasm'))!;

    expect((await fetch(`${base}/`)).headers.get('content-type')).toContain('text/html');
    expect((await fetch(`${base}/assets/${js}`)).headers.get('content-type')).toContain('text/javascript');
    expect((await fetch(`${base}/assets/${wasm}`)).headers.get('content-type')).toBe('application/wasm');
  } finally {
    proc.kill();
  }
});

test('serve.py explains how to get dist/ when it is missing', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'serve-empty-'));
  const r = spawnSync(PYTHON, ['serve.py', '--no-browser', '--port', '8699', '--dir', empty], { encoding: 'utf-8' });
  expect(r.status).toBe(1);
  expect(r.stderr).toContain('index.html');
  expect(r.stderr).toContain('Releases');
});

test('app served by serve.py works over an insecure context (no crypto.randomUUID)', async ({ page }, testInfo) => {
  const port = portFor(testInfo.parallelIndex);
  const proc = await startServe(port);
  try {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    // Plain HTTP on a LAN address is not a secure context, where randomUUID is undefined.
    await page.addInitScript(() => {
      Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true });
    });

    await page.goto(`http://127.0.0.1:${port}/`);
    await page.waitForLoadState('networkidle');
    expect(await page.evaluate(() => typeof crypto.randomUUID)).toBe('undefined');

    const before = await page.title();
    await page.locator('#btn-file-menu').click();
    await page.locator('[data-action="new-doc"]').click();
    await expect.poll(() => page.title()).not.toBe(before);
    expect(errors).toEqual([]);
  } finally {
    proc.kill();
  }
});
