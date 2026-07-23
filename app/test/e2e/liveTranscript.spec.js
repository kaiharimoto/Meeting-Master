'use strict';

// Live transcript pane + checkbox gating, in plain Chromium with the full
// window.api stubbed. The fake media device drives the real recording
// pipeline; live events are pushed by the test through the captured
// onLiveEvent callbacks (window.__liveCbs).

const path = require('path');
const { pathToFileURL } = require('url');
const { test, expect } = require('@playwright/test');

const INDEX_URL = pathToFileURL(
  path.resolve(__dirname, '..', '..', 'src', 'renderer', 'index.html')
).href;

test.use({
  launchOptions: {
    args: [
      '--allow-file-access-from-files',
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
    ],
  },
});

// support: 'ready' | 'no-model' | 'unsupported'
function apiStub(support) {
  window.__recCalls = [];
  window.__liveCbs = [];
  const record = (name, args) => window.__recCalls.push({ name, args });
  const modelDownloaded = support === 'ready';
  window.api = {
    getConfig: async () => ({
      serverUrl: 'http://test',
      emailMode: 'home',
      pageSize: 'Letter',
      hasToken: true,
      micDeviceId: '',
      micDeviceLabel: '',
      liveTranscriptEnabled: true,
      liveModel: 'small',
      configPath: '/dev/null',
    }),
    onJobProgress: () => () => {},
    onRecEvent: () => () => {},
    uploadMeeting: async () => ({ jobId: 'stub-job' }),
    getJobStatus: async () => ({ id: 'stub-job', state: 'queued' }),
    renderPdf: async () => ({ pdfPath: '/tmp/stub.pdf', fontUsed: true, warning: null }),
    openPdf: async () => ({ ok: true }),
    sendPdfViaHome: async () => ({ ok: true, emailed: true, error: null }),
    sendPdfViaLaptop: async () => ({ ok: true, error: null }),
    pickWavFile: async () => ({ filePath: null }),
    pickSavePath: async () => ({ filePath: null }),
    recStart: async () => ({
      recId: 'rec-test',
      filePath: '/recordings/rec-test/audio.webm',
      freeBytes: 10 * 1024 * 1024 * 1024,
    }),
    recAppend: async (recId, seq) => ({ bytes: (seq + 1) * 1000, freeBytes: 10e9 }),
    recStop: async (recId, info) => ({
      filePath: '/recordings/rec-test/audio.webm',
      bytes: 12345,
      durationMs: (info && info.durationMs) || 0,
    }),
    recDiscard: async () => ({ ok: true }),
    recListOrphans: async () => ({ orphans: [] }),
    recResolveOrphan: async () => ({}),
    recStat: async () => ({ exists: true, bytes: 12345 }),
    recOpenFolder: async () => ({ ok: true }),
    liveSupportGet: async () => {
      if (support === 'unsupported') return { supported: false, models: {} };
      return {
        supported: true,
        models: {
          small: { label: 'small', downloaded: modelDownloaded },
          base: { label: 'base', downloaded: false },
        },
      };
    },
    liveModelDownload: async () => ({ started: true }),
    liveModelDelete: async () => ({ ok: true }),
    liveStart: async (opts) => {
      record('liveStart', [opts]);
      return { ok: true };
    },
    livePcm: async (buf) => {
      record('livePcm', [buf ? buf.byteLength : 0]);
      return { ok: true };
    },
    liveStop: async () => {
      record('liveStop', []);
      return { ok: true };
    },
    onLiveEvent: (cb) => {
      window.__liveCbs.push(cb);
      return () => {};
    },
    onLiveModelEvent: () => () => {},
  };
}

function pushLive(page, payload) {
  return page.evaluate((p) => window.__liveCbs.forEach((cb) => cb(p)), payload);
}

test('live session starts with recording, renders segments, stops with it', async ({ page }) => {
  await page.addInitScript(apiStub, 'ready');
  await page.goto(INDEX_URL);

  // Checkbox revealed and pre-checked from config.
  const field = page.locator('#rec-live-field');
  await expect(field).toBeVisible();
  await expect(page.locator('#rec-live-check')).toBeChecked();

  await page.locator('#rec-start-btn').click();
  await expect(page.locator('#rec-stop-btn')).toBeVisible({ timeout: 10000 });

  // liveStart was called and the pane appeared.
  await expect
    .poll(() =>
      page.evaluate(() => window.__recCalls.filter((c) => c.name === 'liveStart').length)
    )
    .toBe(1);
  await expect(page.locator('#live-wrap')).toBeVisible();

  // The real worklet tap streams PCM batches over the stubbed livePcm.
  await expect
    .poll(
      () => page.evaluate(() => window.__recCalls.filter((c) => c.name === 'livePcm').length),
      { timeout: 8000 }
    )
    .toBeGreaterThan(0);

  // Segments render; lag renders as a muted note; follow-scroll is on.
  await pushLive(page, { type: 'segment', text: 'Hello from the live model.', atMs: 0 });
  await pushLive(page, { type: 'segment', text: 'Second sentence.', atMs: 9000 });
  await pushLive(page, { type: 'lag', droppedMs: 12000 });
  const view = page.locator('#live-view');
  await expect(view).toContainText('Hello from the live model.');
  await expect(view).toContainText('Second sentence.');
  await expect(view.locator('.live-note')).toContainText('fell behind');

  // Stop: the live session ends with the recording; the pane stays copyable.
  await page.locator('#rec-stop-btn').click();
  await expect(page.locator('#rec-note')).toBeVisible({ timeout: 10000 });
  await expect
    .poll(() =>
      page.evaluate(() => window.__recCalls.filter((c) => c.name === 'liveStop').length)
    )
    .toBeGreaterThan(0);
  await expect(page.locator('#live-wrap')).toBeVisible();
  await expect(view).toContainText('Hello from the live model.');
});

test('no whisper binary: the checkbox stays hidden and liveStart is never called', async ({ page }) => {
  await page.addInitScript(apiStub, 'unsupported');
  await page.goto(INDEX_URL);

  await expect(page.locator('#rec-live-field')).toBeHidden();
  await page.locator('#rec-start-btn').click();
  await expect(page.locator('#rec-stop-btn')).toBeVisible({ timeout: 10000 });
  await page.waitForTimeout(500);
  expect(
    await page.evaluate(() => window.__recCalls.filter((c) => c.name === 'liveStart').length)
  ).toBe(0);
  page.once('dialog', (d) => d.accept());
  await page.locator('#rec-discard-btn').click();
});

test('binary present but model missing: checkbox disabled with a Settings hint', async ({ page }) => {
  await page.addInitScript(apiStub, 'no-model');
  await page.goto(INDEX_URL);

  await expect(page.locator('#rec-live-field')).toBeVisible();
  await expect(page.locator('#rec-live-check')).toBeDisabled();
  await expect(page.locator('#rec-live-hint')).toBeVisible();
});
