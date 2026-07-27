'use strict';

// The autosave receipt. Every edit already wrote to localStorage; the point of
// the indicator is that the operator can SEE that, and that it doesn't lie —
// it only appears after a save has actually happened.

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
      uploadMeeting: async () => ({ jobId: 'stub-job' }),
      getJobStatus: async () => ({ id: 'stub-job', state: 'queued' }),
      renderPdf: async () => ({ pdfPath: '/tmp/x.pdf', fontUsed: true, warning: null }),
      openPdf: async () => ({ ok: true }),
      sendPdfViaHome: async () => ({ ok: true, emailed: true, error: null }),
      sendPdfViaLaptop: async () => ({ ok: true, error: null }),
      pickWavFile: async () => ({ filePath: null }),
      pickSavePath: async () => ({ filePath: null }),
    };
  });
  await page.goto(INDEX_URL);
});

test('nothing is claimed until something is actually saved', async ({ page }) => {
  await expect(page.locator('#save-indicator')).toBeHidden();
});

test('typing a title shows the receipt, which settles to a timestamp', async ({ page }) => {
  const indicator = page.locator('#save-indicator');
  await page.locator('#meeting-title-input').fill('Q3 Vendor Contract Review');

  await expect(indicator).toBeVisible();
  await expect(indicator).toHaveText('Saved');

  // …then settles to a "Saved HH:MM" stamp so a later glance still answers "when?".
  await expect(indicator).toHaveText(/^Saved \d{2}:\d{2}$/, { timeout: 4000 });

  // And the state really is on disk.
  const saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('meetingmaster.meeting.v1'))
  );
  expect(saved.details.title).toBe('Q3 Vendor Contract Review');
});

test('adding a question through the quick bar reports a save too', async ({ page }) => {
  await page.locator('#quick-question').click();
  await page.keyboard.type('Does this persist?');
  await page.keyboard.press('Enter');
  await expect(page.locator('#save-indicator')).toHaveText(/^Saved/);
});
