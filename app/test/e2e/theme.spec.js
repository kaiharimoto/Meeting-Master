'use strict';

// Theme system: OS-preference default, toggle flips data-theme, choice
// persists across reload (localStorage 'meetingmaster.theme.v1').

const path = require('path');
const { pathToFileURL } = require('url');
const { test, expect } = require('@playwright/test');

const INDEX_URL = pathToFileURL(
  path.resolve(__dirname, '..', '..', 'src', 'renderer', 'index.html')
).href;

const API_STUB = () => {
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
};

test('defaults to the OS preference (dark) and the toggle flips + persists', async ({ browser }) => {
  const context = await browser.newContext({ colorScheme: 'dark' });
  const page = await context.newPage();
  await page.addInitScript(API_STUB);
  await page.goto(INDEX_URL);

  // System-dark => dark theme before any user choice.
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  // Toggle -> light, persisted.
  await page.locator('#theme-toggle-btn').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await page.evaluate(() => localStorage.getItem('meetingmaster.theme.v1'))).toBe('light');

  // Reload keeps the explicit choice despite the dark OS preference.
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

  await context.close();
});

test('defaults to light on a light OS and toggles to dark', async ({ browser }) => {
  const context = await browser.newContext({ colorScheme: 'light' });
  const page = await context.newPage();
  await page.addInitScript(API_STUB);
  await page.goto(INDEX_URL);

  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.locator('#theme-toggle-btn').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  await context.close();
});
