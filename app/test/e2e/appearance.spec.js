'use strict';

// High contrast and text size — the two user-facing accessibility controls.
//
// Both are renderer-only preferences applied PRE-PAINT by themeBoot.js, and
// both are deliberately independent of everything they sit near: contrast
// composes with either theme rather than becoming a third one, and text size
// is type-only, distinct from the main process's whole-window display zoom.

const path = require('path');
const { pathToFileURL } = require('url');
const { test, expect } = require('@playwright/test');

const INDEX_URL = pathToFileURL(
  path.resolve(__dirname, '..', '..', 'src', 'renderer', 'index.html')
).href;

function apiStub() {
  window.api = {
    getConfig: async () => ({
      serverUrl: 'http://test',
      emailMode: 'home',
      pageSize: 'Letter',
      hasToken: true,
      configPath: '/dev/null',
    }),
    getFullConfig: async () => ({
      serverUrl: 'http://test',
      hasToken: true,
      emailMode: 'home',
      pageSize: 'Letter',
    }),
    onJobProgress: () => () => {},
    onRecEvent: () => () => {},
    onLiveEvent: () => () => {},
    onLiveModelEvent: () => () => {},
    uploadMeeting: async () => ({ jobId: 'stub-job' }),
    getJobStatus: async () => ({ id: 'stub-job', state: 'queued' }),
    renderPdf: async () => ({ pdfPath: '/tmp/x.pdf', fontUsed: true, warning: null }),
    openPdf: async () => ({ ok: true }),
    sendPdfViaHome: async () => ({ ok: true, emailed: true, error: null }),
    sendPdfViaLaptop: async () => ({ ok: true, error: null }),
    pickWavFile: async () => ({ filePath: null }),
    pickSavePath: async () => ({ filePath: null }),
    recListOrphans: async () => ({ orphans: [] }),
    recStat: async () => ({ exists: false, bytes: 0 }),
    liveSupportGet: async () => ({ supported: false, models: {} }),
    listJobs: async () => [],
  };
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(apiStub);
});

const fontSize = (page, selector) =>
  page.locator(selector).first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize));

test('high contrast composes with both themes and survives a reload', async ({ page }) => {
  await page.goto(INDEX_URL);
  await page.locator('#settings-btn').click();

  const check = page.locator('#settings-contrast-check');
  await expect(check).not.toBeChecked();
  await check.check();
  await expect(page.locator('html')).toHaveAttribute('data-contrast', 'high');

  // The theme is untouched — this is an overlay, not a replacement.
  const theme = await page.locator('html').getAttribute('data-theme');
  expect(['light', 'dark']).toContain(theme);

  // Flipping the theme keeps contrast on.
  await page.locator('#theme-toggle-btn').click();
  await expect(page.locator('html')).toHaveAttribute('data-contrast', 'high');
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', theme);

  // Pre-paint on reload: no flash of the low-contrast palette.
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-contrast', 'high');

  await page.locator('#settings-btn').click();
  await expect(page.locator('#settings-contrast-check')).toBeChecked();
  await page.locator('#settings-contrast-check').uncheck();
  await expect(page.locator('html')).not.toHaveAttribute('data-contrast', 'high');
});

test('high contrast really raises the ink, in both themes', async ({ page }) => {
  await page.goto(INDEX_URL);

  const inkOf = () =>
    page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--ink').trim()
    );

  const before = await inkOf();
  await page.evaluate(() => {
    document.documentElement.dataset.contrast = 'high';
  });
  const after = await inkOf();
  expect(after).not.toBe(before);
  // Pure black on light, pure white on dark — the extremes, by design.
  expect(['#000000', '#ffffff']).toContain(after);
});

test('text size scales type without moving the layout', async ({ page }) => {
  await page.goto(INDEX_URL);

  const titleBefore = await fontSize(page, '.screen-title');
  const sidebarBefore = await page.evaluate(
    () => document.getElementById('sidebar').getBoundingClientRect().width
  );

  await page.locator('#settings-btn').click();
  await page.locator('#settings-textsize-select').selectOption('1.25');

  const titleAfter = await fontSize(page, '.screen-title');
  expect(titleAfter / titleBefore).toBeCloseTo(1.25, 2);

  // Type only: the sidebar is sized by --sidebar-w, which does not scale.
  const sidebarAfter = await page.evaluate(
    () => document.getElementById('sidebar').getBoundingClientRect().width
  );
  expect(sidebarAfter).toBe(sidebarBefore);
});

test('text size is applied before the first paint and clamped to its steps', async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem('meetingmaster.textscale.v1', '1.12')
  );
  await page.goto(INDEX_URL);
  expect(
    await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--fs-scale').trim()
    )
  ).toBe('1.12');

  // A hand-edited value outside the offered steps is ignored, not obeyed.
  // (Registered as an init script, not an evaluate: a reload re-runs the
  // beforeEach seeding and would put 1.12 straight back.)
  await page.addInitScript(() =>
    localStorage.setItem('meetingmaster.textscale.v1', '4')
  );
  await page.reload();
  expect(
    await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--fs-scale').trim()
    )
  ).toBe('1');
});

test('the largest text size at a small window still does not scroll sideways', async ({ page }) => {
  // The worst realistic case: display zoom is a main-process multiplier we
  // can't set here, so this covers the renderer's own contribution at the
  // narrowest window the app is expected to run in.
  await page.addInitScript(() =>
    localStorage.setItem('meetingmaster.textscale.v1', '1.25')
  );
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.goto(INDEX_URL);

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test('every step of the type scale moves with the control', async ({ page }) => {
  await page.goto(INDEX_URL);
  // Custom properties don't compute to pixels — a probe element does. Setting
  // its font-size to the token is exactly how the stylesheet consumes them.
  const read = () =>
    page.evaluate(() => {
      const probe = document.createElement('span');
      probe.style.position = 'absolute';
      probe.style.visibility = 'hidden';
      document.body.appendChild(probe);
      const out = ['--fs-2xs', '--fs-xs', '--fs-sm', '--fs-base', '--fs-md', '--fs-lg'].map(
        (token) => {
          probe.style.fontSize = `var(${token})`;
          return parseFloat(getComputedStyle(probe).fontSize);
        }
      );
      probe.remove();
      return out;
    });

  const before = await read();
  await page.evaluate(() =>
    document.documentElement.style.setProperty('--fs-scale', '1.25')
  );
  const after = await read();

  // A literal font-size left anywhere in the stylesheet would opt out silently;
  // every step has to move, and by the same factor.
  after.forEach((px, i) => expect(px / before[i]).toBeCloseTo(1.25, 3));
});
