'use strict';

// Ctrl+K command palette. The two things that make it trustworthy are that it
// never offers a command the UI can't run right now, and that it never opens
// underneath something — both are asserted here.

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
  });
  await page.goto(INDEX_URL);
});

const palette = (page) => page.locator('#palette-modal');
const items = (page) => page.locator('#palette-list .palette-item');

test('Ctrl+K opens the palette, filters, and Enter runs the command', async ({ page }) => {
  await page.keyboard.press('Control+k');
  await expect(palette(page)).toBeVisible();
  await expect(page.locator('#palette-input')).toBeFocused();

  const before = await items(page).count();
  expect(before).toBeGreaterThan(5);

  await page.keyboard.type('history');
  await expect(items(page)).toHaveCount(1);
  await expect(items(page).first()).toHaveText('Meeting history');

  await page.keyboard.press('Enter');
  await expect(palette(page)).toBeHidden();
  await expect(page.locator('#history-modal')).toBeVisible();
});

test('arrow keys move the selection and the palette reports it to screen readers', async ({
  page,
}) => {
  await page.keyboard.press('Control+k');
  const first = items(page).nth(0);
  const second = items(page).nth(1);
  await expect(first).toHaveAttribute('aria-selected', 'true');

  await page.keyboard.press('ArrowDown');
  await expect(first).toHaveAttribute('aria-selected', 'false');
  await expect(second).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#palette-input')).toHaveAttribute(
    'aria-activedescendant',
    await second.getAttribute('id')
  );

  await page.keyboard.press('ArrowUp');
  await expect(first).toHaveAttribute('aria-selected', 'true');
});

test('a command whose button is disabled is not offered', async ({ page }) => {
  await page.keyboard.press('Control+k');
  // No PDF has been generated, so Send email is disabled in the UI.
  await expect(page.locator('#send-email-btn')).toBeDisabled();
  await page.keyboard.type('send email');
  await expect(items(page)).toHaveCount(0);
  await expect(page.locator('#palette-empty')).toBeVisible();

  // Enable it the way the app does and the command appears.
  await page.keyboard.press('Escape');
  await page.evaluate(() => {
    document.getElementById('send-email-btn').disabled = false;
  });
  await page.keyboard.press('Control+k');
  await page.keyboard.type('send email');
  await expect(items(page)).toHaveCount(1);
});

test('a collapsed panel still offers its commands', async ({ page }) => {
  // The setup stage collapses Generate & send. Its enabled buttons are still
  // things the operator can ask for by name.
  await expect(page.locator('#panel-generate')).toHaveClass(/is-collapsed/);
  await page.keyboard.press('Control+k');
  await page.keyboard.type('generate pdf');
  await expect(items(page)).toHaveCount(1);
});

test('a hidden button is not offered', async ({ page }) => {
  // rec-stop-btn only exists while recording.
  await expect(page.locator('#rec-stop-btn')).toBeHidden();
  await page.keyboard.press('Control+k');
  await page.keyboard.type('stop recording');
  await expect(items(page)).toHaveCount(0);
});

test('Ctrl+K works from inside a text field, and Escape returns focus there', async ({ page }) => {
  const title = page.locator('#meeting-title-input');
  await title.click();
  await page.keyboard.type('Q3 review');

  await page.keyboard.press('Control+k');
  await expect(palette(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(palette(page)).toBeHidden();
  await expect(title).toBeFocused();
  await expect(title).toHaveValue('Q3 review');
});

test('the palette does not stack on an already-open dialog', async ({ page }) => {
  await page.keyboard.press('q');
  await expect(page.locator('#card-modal')).toBeVisible();
  await page.keyboard.press('Control+k');
  await expect(palette(page)).toBeHidden();
  await expect(page.locator('#card-modal')).toBeVisible();
});

test('the palette paints above the live suggestions rail', async ({ page }) => {
  const z = await page.evaluate(() => {
    const read = (sel) => getComputedStyle(document.querySelector(sel)).zIndex;
    return { palette: read('#palette-modal'), rail: read('#live-rail') };
  });
  expect(Number(z.palette)).toBeGreaterThan(Number(z.rail));
  // …and stays below toasts, which outrank every surface.
  const toastZ = await page.evaluate(
    () => getComputedStyle(document.querySelector('#toast-region')).zIndex
  );
  expect(Number(z.palette)).toBeLessThan(Number(toastZ));
});

test('"Add a question" puts the cursor in the inline bar', async ({ page }) => {
  await page.keyboard.press('Control+k');
  await page.keyboard.type('add a question');
  await page.keyboard.press('Enter');
  await expect(palette(page)).toBeHidden();
  await expect(page.locator('#quick-question')).toBeFocused();
});
