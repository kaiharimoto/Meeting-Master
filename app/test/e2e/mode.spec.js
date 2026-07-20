'use strict';

// First-run mode chooser (mode.html) and the server-mode boot page
// (serverBoot.html), driven through a stubbed window.api.

const path = require('path');
const { pathToFileURL } = require('url');
const { test, expect } = require('@playwright/test');

const pageUrl = (name) =>
  pathToFileURL(path.resolve(__dirname, '..', '..', 'src', 'renderer', name)).href;

// ---- Mode chooser -----------------------------------------------------------

test.describe('mode chooser', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      window.__modeSet = [];
      window.api = {
        setMode: async (mode) => {
          window.__modeSet.push(mode);
          return { ok: true, mode };
        },
      };
    });
    await page.goto(pageUrl('mode.html'));
  });

  test('offers both roles and picks operator', async ({ page }) => {
    await expect(page.locator('#choose-operator')).toBeVisible();
    await expect(page.locator('#choose-server')).toBeVisible();

    await page.locator('#choose-operator').click();
    await expect(page.locator('#mode-status')).toContainText('operator');
    await expect.poll(() => page.evaluate(() => window.__modeSet)).toEqual(['operator']);

    // Both cards lock after a choice — no double-submits.
    await expect(page.locator('#choose-server')).toBeDisabled();
    await expect(page.locator('#choose-operator')).toHaveClass(/selected/);
  });

  test('picks home server mode', async ({ page }) => {
    await page.locator('#choose-server').click();
    await expect(page.locator('#mode-status')).toContainText('home server');
    await expect.poll(() => page.evaluate(() => window.__modeSet)).toEqual(['server']);
  });
});

// ---- Server boot page -------------------------------------------------------

test.describe('server boot page', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      window.__sidecarCbs = [];
      window.__pushSidecar = (state) => window.__sidecarCbs.forEach((cb) => cb(state));
      window.__retries = 0;
      window.__logsOpened = 0;
      window.api = {
        getSidecarState: async () => ({ state: 'starting', message: '', port: 8080 }),
        onSidecarState: (cb) => {
          window.__sidecarCbs.push(cb);
          return () => {};
        },
        retrySidecar: async () => {
          window.__retries += 1;
          return { state: 'starting' };
        },
        openServerLog: async () => {
          window.__logsOpened += 1;
          return { ok: true };
        },
        setMode: async () => ({ ok: true }),
      };
    });
    await page.goto(pageUrl('serverBoot.html'));
  });

  test('starting state shows the spinner, failure surfaces actions', async ({ page }) => {
    await expect(page.locator('#boot-title')).toHaveText('Starting the home server…');
    await expect(page.locator('#boot-spinner')).toBeVisible();
    await expect(page.locator('#boot-retry')).toBeHidden();

    await page.evaluate(() =>
      window.__pushSidecar({ state: 'failed', message: 'exit code 1 — see the log' })
    );

    await expect(page.locator('#boot-title')).toHaveText('The home server could not start');
    await expect(page.locator('#boot-message')).toContainText('exit code 1');
    await expect(page.locator('#boot-spinner')).toBeHidden();
    await expect(page.locator('#boot-retry')).toBeVisible();

    await page.locator('#boot-log').click();
    await expect.poll(() => page.evaluate(() => window.__logsOpened)).toBe(1);

    await page.locator('#boot-retry').click();
    await expect.poll(() => page.evaluate(() => window.__retries)).toBe(1);
    await expect(page.locator('#boot-title')).toHaveText('Starting the home server…');
  });

  test('conflict state explains the old install', async ({ page }) => {
    await page.evaluate(() =>
      window.__pushSidecar({
        state: 'conflict',
        message: 'Another Meeting Master server (v0.2.1) is already running on port 8080.',
      })
    );
    await expect(page.locator('#boot-title')).toHaveText('Another server is already running');
    await expect(page.locator('#boot-message')).toContainText('v0.2.1');
    await expect(page.locator('#boot-retry')).toBeVisible();
  });

  test('running state announces the dashboard handoff', async ({ page }) => {
    await page.evaluate(() => window.__pushSidecar({ state: 'running' }));
    await expect(page.locator('#boot-title')).toHaveText('Server is running');
    await expect(page.locator('#boot-message')).toContainText('dashboard');
  });
});
