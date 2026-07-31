'use strict';

// Transcription progress: the percentage has always existed as text in three
// places but was never drawn as a bar. The bar is ADDITIVE — the text stays,
// because it also carries the ETA and the Activity stepper asserts on it.

const path = require('path');
const { pathToFileURL } = require('url');
const { test, expect } = require('@playwright/test');

const INDEX_URL = pathToFileURL(
  path.resolve(__dirname, '..', '..', 'src', 'renderer', 'index.html')
).href;

function apiStub() {
  window.__progress = 41;
  window.api = {
    getConfig: async () => ({
      serverUrl: 'http://test',
      emailMode: 'home',
      pageSize: 'Letter',
      hasToken: true,
      configPath: '/dev/null',
    }),
    onJobProgress: () => () => {},
    onRecEvent: () => () => {},
    onLiveEvent: () => () => {},
    onLiveModelEvent: () => () => {},
    getJobStatus: async () => ({
      id: 'job-1',
      state: 'transcribing',
      progress: window.__progress,
      transcript: null,
      summary: null,
    }),
    uploadMeeting: async () => ({ jobId: 'job-1' }),
    renderPdf: async () => ({ pdfPath: '/tmp/x.pdf', fontUsed: true, warning: null }),
    openPdf: async () => ({ ok: true }),
    sendPdfViaHome: async () => ({ ok: true, emailed: true, error: null }),
    sendPdfViaLaptop: async () => ({ ok: true, error: null }),
    pickWavFile: async () => ({ filePath: null }),
    pickSavePath: async () => ({ filePath: null }),
    recListOrphans: async () => ({ orphans: [] }),
    recStat: async () => ({ exists: false, bytes: 0 }),
    liveSupportGet: async () => ({ supported: false, models: {} }),
    getPreflight: async () => ({ server: { ok: true } }),
    listJobs: async () => [],
  };
  localStorage.setItem(
    'meetingmaster.meeting.v1',
    JSON.stringify({ job: { id: 'job-1', state: 'transcribing', progress: 41 } })
  );
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(apiStub);
  await page.goto(INDEX_URL);
});

test('a transcribing job draws an accessible progress bar', async ({ page }) => {
  const meter = page.locator('#status-meter');
  await expect(meter).toBeVisible();
  await expect(meter).toHaveAttribute('role', 'progressbar');
  await expect(meter).toHaveAttribute('aria-valuenow', '41');
  await expect(meter).toHaveAttribute('aria-valuemin', '0');
  await expect(meter).toHaveAttribute('aria-valuemax', '100');
  await expect(page.locator('#status-meter-fill')).toHaveCSS('width', /\d/);
});

test('the percentage and ETA stay in the status text alongside the bar', async ({ page }) => {
  await expect(page.locator('#status-text')).toContainText('41%');
});

test('the Activity stepper still reports the raw percentage', async ({ page }) => {
  // activity.spec.js asserts this exact text; the bar must not replace it.
  await page.locator('#nav-activity').click();
  await expect(
    page.locator('.pipe-step').nth(2).locator('.pipe-sub')
  ).toHaveText('41%');
});

test('the bar disappears when no job is running', async ({ page }) => {
  // Init scripts run in registration order, so this one clears the seed the
  // beforeEach stub writes (a plain evaluate would be undone by the reload).
  await page.addInitScript(() => localStorage.removeItem('meetingmaster.meeting.v1'));
  await page.reload();
  await expect(page.locator('#status-meter')).toBeHidden();
});
