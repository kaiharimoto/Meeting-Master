'use strict';

// Laptop auto-update UI: the sidebar version label becomes an update
// indicator and a "Restart to update" toast appears when a download is ready.
// Driven through a stubbed window.api (onAppUpdate push + getUpdateState).

const path = require('path');
const { pathToFileURL } = require('url');
const { test, expect } = require('@playwright/test');

const INDEX_URL = pathToFileURL(
  path.resolve(__dirname, '..', '..', 'src', 'renderer', 'index.html')
).href;

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.__updateCbs = [];
    window.__pushUpdate = (payload) => window.__updateCbs.forEach((cb) => cb(payload));
    window.__installed = 0;
    window.api = {
      getConfig: async () => ({
        serverUrl: 'http://test', emailMode: 'home', pageSize: 'Letter',
        hasToken: true, configPath: '/dev/null',
      }),
      onJobProgress: () => () => {},
      getAppInfo: async () => ({ version: '0.2.1', platform: 'win32' }),
      onAppUpdate: (cb) => { window.__updateCbs.push(cb); return () => {}; },
      getUpdateState: async () => ({
        supported: true, checking: false, available: null, downloaded: null, error: null,
      }),
      installUpdate: async () => { window.__installed += 1; return { ok: true, error: null }; },
    };
  });
  await page.goto(INDEX_URL);
});

test('downloaded update shows the footer indicator and a restart toast', async ({ page }) => {
  await expect(page.locator('#app-version')).toHaveText('v0.2.1');

  await page.evaluate(() => window.__pushUpdate({
    type: 'state',
    state: { supported: true, checking: false, available: '0.3.0', downloaded: '0.3.0', error: null },
  }));

  await expect(page.locator('#app-version')).toHaveText('v0.2.1 → v0.3.0 ready');
  await expect(page.locator('#app-version')).toHaveClass(/update-ready/);

  const toast = page.locator('.toast');
  await expect(toast).toBeVisible();
  await expect(toast).toContainText('Update ready — v0.3.0');

  // The action button triggers the install IPC.
  await toast.getByRole('button', { name: 'Restart to update' }).click();
  await expect.poll(() => page.evaluate(() => window.__installed)).toBe(1);
  await expect(toast).toBeHidden();
});

test('the same downloaded version only toasts once', async ({ page }) => {
  const push = () => page.evaluate(() => window.__pushUpdate({
    type: 'state',
    state: { supported: true, checking: false, available: '0.3.0', downloaded: '0.3.0', error: null },
  }));
  await push();
  await expect(page.locator('.toast')).toHaveCount(1);
  await push();
  await push();
  await expect(page.locator('.toast')).toHaveCount(1);
});

test('the Settings sheet exposes the fonts folder button', async ({ page }) => {
  await page.locator('#settings-btn').click();
  await expect(page.locator('#settings-modal')).toBeVisible();
  await expect(page.locator('#open-fonts-btn')).toBeVisible();
});
