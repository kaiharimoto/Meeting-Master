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
      installUpdate: async () => {
        window.__installed += 1;
        // Tests flip this to exercise the refusal path (installNow() resolves
        // with {ok:false} when a job is running or a foreign server holds files).
        return window.__installResult || { ok: true, error: null };
      },
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

  await expect(page.locator('#app-version')).toHaveText('v0.2.1 → v0.3.0 — restart');
  await expect(page.locator('#app-version')).toHaveClass(/update-ready/);

  const toast = page.locator('.toast');
  await expect(toast).toBeVisible();
  await expect(toast).toContainText('Update ready — v0.3.0');

  // The action button triggers the install IPC.
  await toast.getByRole('button', { name: 'Restart to update' }).click();
  await expect.poll(() => page.evaluate(() => window.__installed)).toBe(1);
  await expect(toast).toBeHidden();
});

test('the version badge installs too — a dismissed toast is not a dead end', async ({ page }) => {
  await page.evaluate(() => window.__pushUpdate({
    type: 'state',
    state: { supported: true, checking: false, available: '0.3.0', downloaded: '0.3.0', error: null },
  }));

  // Dismiss the toast, as an operator mid-meeting would.
  await page.locator('.toast .toast-close').click();
  await expect(page.locator('.toast')).toHaveCount(0);

  // The footer badge is a real control and still installs.
  const badge = page.locator('#app-version');
  await expect(badge).toHaveAttribute('role', 'button');
  await badge.click();
  await expect.poll(() => page.evaluate(() => window.__installed)).toBe(1);

  // …and it is keyboard reachable.
  await badge.press('Enter');
  await expect.poll(() => page.evaluate(() => window.__installed)).toBe(2);
});

test('a refused install explains itself instead of doing nothing', async ({ page }) => {
  await page.evaluate(() => {
    window.__installResult = { ok: false, error: '2 job(s) still processing — try again when the pipeline is idle.' };
    window.__pushUpdate({
      type: 'state',
      state: { supported: true, checking: false, available: '0.3.0', downloaded: '0.3.0', error: null },
    });
  });

  await page.locator('.toast').getByRole('button', { name: 'Restart to update' }).click();
  const error = page.locator('.toast', { hasText: 'Could not install the update yet' });
  await expect(error).toBeVisible();
  await expect(error).toContainText('2 job(s) still processing');
});

test('the badge is inert when no update is pending', async ({ page }) => {
  const badge = page.locator('#app-version');
  await expect(badge).toHaveText('v0.2.1');
  await expect(badge).not.toHaveAttribute('role', 'button');
  await badge.click();
  expect(await page.evaluate(() => window.__installed)).toBe(0);
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
