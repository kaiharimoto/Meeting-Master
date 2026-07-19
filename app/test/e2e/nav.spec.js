'use strict';

// Sidebar navigation: screen switching between Meeting and Activity, sheet
// modals (History/Settings) opening from the nav, and hash persistence.

const path = require('path');
const { pathToFileURL } = require('url');
const { test, expect } = require('@playwright/test');

const INDEX_URL = pathToFileURL(
  path.resolve(__dirname, '..', '..', 'src', 'renderer', 'index.html')
).href;

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.api = {
      getConfig: async () => ({
        serverUrl: 'http://test',
        emailMode: 'home',
        pageSize: 'Letter',
        hasToken: true,
        configPath: '/dev/null',
      }),
      onJobProgress: () => () => {},
    };
  });
  await page.goto(INDEX_URL);
});

test('sidebar switches between Meeting and Activity screens', async ({ page }) => {
  const meeting = page.locator('#screen-meeting');
  const activity = page.locator('#screen-activity');

  // Boots on the Meeting screen.
  await expect(meeting).toBeVisible();
  await expect(activity).toBeHidden();
  await expect(page.locator('#nav-meeting')).toHaveClass(/active/);

  await page.locator('#nav-activity').click();
  await expect(activity).toBeVisible();
  await expect(meeting).toBeHidden();
  await expect(page.locator('#nav-activity')).toHaveClass(/active/);
  expect(page.url()).toContain('#activity');

  await page.locator('#nav-meeting').click();
  await expect(meeting).toBeVisible();
  await expect(activity).toBeHidden();
});

test('the pinned workflow ids all exist in the restructured shell', async ({ page }) => {
  // A canary against shell refactors silently dropping load-bearing ids.
  for (const id of [
    'meeting-title-input', 'card-list', 'add-card-btn', 'extract-review',
    'pick-audio-btn', 'edit-summary-btn', 'generate-pdf-btn', 'open-pdf-btn',
    'send-email-btn', 'status-line', 'new-meeting-btn', 'history-btn',
    'settings-btn', 'card-modal', 'extract-modal', 'summary-modal',
    'history-modal', 'settings-modal', 'server-pill', 'connection-info',
    'theme-toggle-btn', 'toast-region',
  ]) {
    expect(await page.locator(`#${id}`).count(), `#${id} missing`).toBe(1);
  }
});

test('History opens as a sheet from the sidebar and nav returns to Meeting', async ({ page }) => {
  await page.locator('#history-btn').click();
  await expect(page.locator('#history-modal')).toBeVisible();
  await expect(page.locator('#history-btn')).toHaveClass(/active/);

  // Navigating to a screen dismisses the sheet.
  await page.locator('#nav-meeting').click();
  await expect(page.locator('#history-modal')).toBeHidden();
  await expect(page.locator('#screen-meeting')).toBeVisible();
});

test('the ? overlay opens and closes', async ({ page }) => {
  await page.keyboard.press('?');
  await expect(page.locator('#shortcuts-modal')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#shortcuts-modal')).toBeHidden();

  // Typing ? inside an input must NOT open it.
  await page.locator('#meeting-title-input').click();
  await page.keyboard.type('what?');
  await expect(page.locator('#shortcuts-modal')).toBeHidden();
});
