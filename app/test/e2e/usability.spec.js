'use strict';

// Usability batch: stage-aware shell, defaults, record guard, pre-flight
// chips, undo flows, first-run checklist, send confirmation, mini-mode hooks.

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

function apiStub() {
  window.__calls = [];
  const record = (name, args) => window.__calls.push({ name, args });
  window.api = {
    getConfig: async () => ({
      serverUrl: 'http://test',
      emailMode: 'home',
      pageSize: 'Letter',
      hasToken: true,
      micDeviceId: '',
      micDeviceLabel: '',
      liveTranscriptEnabled: false,
      liveModel: 'small',
      uiZoom: '',
      configPath: '/dev/null',
    }),
    onJobProgress: () => () => {},
    onRecEvent: () => () => {},
    onLiveEvent: () => () => {},
    onLiveModelEvent: () => () => {},
    onMiniCmd: (cb) => {
      window.__miniCmdCb = cb;
      return () => {};
    },
    uploadMeeting: async () => ({ jobId: 'stub-job' }),
    getJobStatus: async () => ({ id: 'stub-job', state: 'queued' }),
    renderPdf: async () => ({ pdfPath: '/tmp/stub.pdf', fontUsed: true, warning: null }),
    openPdf: async () => ({ ok: true }),
    sendPdfViaHome: async (jobId, pdfPath) => {
      record('sendPdfViaHome', [jobId, pdfPath]);
      return { ok: true, emailed: true, error: null };
    },
    sendPdfViaLaptop: async () => ({ ok: true, error: null }),
    getEmailPreview: async () => ({
      recipients: ['dr.smith@example.com', 'team@example.com'],
      subject: 'Meeting Notes — Test',
      body: 'body',
    }),
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
    recStat: async () => ({ exists: true, bytes: 12345 }),
    recOpenFolder: async () => ({ ok: true }),
    liveSupportGet: async () => ({ supported: false, models: {} }),
    getPreflight: async () => ({
      freeBytes: 10 * 1024 * 1024 * 1024,
      server: { ok: true, error: null },
      live: { supported: true, modelReady: false },
    }),
    miniOpen: async () => {
      record('miniOpen', []);
      return { ok: true };
    },
    miniStatus: async () => ({ ok: true }),
  };
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(apiStub);
  await page.goto(INDEX_URL);
});

test('a new meeting defaults to today at 11:00', async ({ page }) => {
  const today = await page.evaluate(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
      d.getDate()
    ).padStart(2, '0')}`;
  });
  await expect(page.locator('#meeting-date-input')).toHaveValue(today);
  await expect(page.locator('#meeting-time-input')).toHaveValue('11:00');
});

test('setup stage: Generate collapses with a summary; header click overrides', async ({ page }) => {
  await expect(page.locator('#screen-meeting')).toHaveAttribute('data-stage', 'setup');
  const generate = page.locator('#panel-generate');
  await expect(generate).toHaveClass(/is-collapsed/);
  await expect(generate.locator('.panel-summary')).toBeVisible();
  await expect(page.locator('#next-step')).toContainText('start recording');
  await expect(page.locator('#rec-start-btn')).toHaveClass(/btn-promoted/);

  // Manual override: the operator's choice wins.
  await page.locator('#generate-heading').click();
  await expect(generate).not.toHaveClass(/is-collapsed/);
  await expect(page.locator('#generate-pdf-btn')).toBeVisible();
});

test('record guard nudges when typing without recording; stages follow the flow', async ({ page }) => {
  const guard = page.locator('#rec-guard');
  await expect(guard).toBeHidden();

  await page.locator('#meeting-title-input').fill('Q3 Vendor Review');
  await expect(guard).toBeVisible();

  // Start recording: guard clears, stage flips to live, title shows the dot.
  await page.locator('#rec-start-btn').click();
  await expect(page.locator('#rec-stop-btn')).toBeVisible({ timeout: 10000 });
  await expect(guard).toBeHidden();
  await expect(page.locator('#screen-meeting')).toHaveAttribute('data-stage', 'live');
  await expect(page.locator('#panel-details')).toHaveClass(/is-collapsed/);
  await expect
    .poll(() => page.title())
    .toContain('●');
  await expect.poll(() => page.title()).toContain('Q3 Vendor Review');

  // Mini-mode button is offered while recording and calls through.
  const miniBtn = page.locator('#rec-mini-btn');
  await expect(miniBtn).toBeVisible();
  await miniBtn.click();
  await expect
    .poll(() => page.evaluate(() => window.__calls.filter((c) => c.name === 'miniOpen').length))
    .toBe(1);

  // A mini-mode remote command drives the recorder in this window.
  await page.evaluate(() => window.__miniCmdCb({ cmd: 'pause' }));
  await expect(page.locator('#rec-resume-btn')).toBeVisible();
  await page.evaluate(() => window.__miniCmdCb({ cmd: 'resume' }));
  await expect(page.locator('#rec-pause-btn')).toBeVisible();

  // Stop: stage moves to captured, Generate transcript becomes the next step.
  await page.locator('#rec-stop-btn').click();
  await expect(page.locator('#rec-note')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#screen-meeting')).toHaveAttribute('data-stage', 'captured');
  await expect(page.locator('#pick-audio-btn')).toHaveClass(/btn-promoted/);
  await expect.poll(() => page.title()).not.toContain('●');
});

test('pre-flight chips report mic, disk, server, and live model', async ({ page }) => {
  const chips = page.locator('#rec-preflight .pf-chip');
  await expect(chips).toHaveCount(4);
  await expect(chips.nth(0)).toContainText('Microphone');
  await expect(chips.nth(0)).toHaveClass(/is-ok/);
  await expect(chips.nth(1)).toContainText('Disk space');
  await expect(chips.nth(2)).toContainText('Home server');
  await expect(chips.nth(3)).toContainText('Live model not downloaded');
  await expect(chips.nth(3)).toHaveClass(/is-soft/);
});

test('deleting a card is undoable from the toast', async ({ page }) => {
  await page.keyboard.press('q');
  await page.keyboard.type('Undo me?');
  await page.keyboard.press('Enter');
  await expect(page.locator('#card-list .qa-card')).toHaveCount(1);

  await page.locator('.qa-card .card-delete').click();
  await expect(page.locator('#card-list .qa-card')).toHaveCount(0);

  const toast = page.locator('.toast', { hasText: 'Question deleted' });
  await expect(toast).toBeVisible();
  await toast.locator('.toast-action').click();
  await expect(page.locator('#card-list .qa-card')).toHaveCount(1);
  await expect(page.locator('#card-list .qa-card')).toContainText('Undo me?');
});

test('New meeting needs no confirm and is undoable', async ({ page }) => {
  await page.locator('#meeting-title-input').fill('Precious meeting');
  // No dialog handler on purpose: an unexpected confirm would hang the click.
  await page.locator('#new-meeting-btn').click();
  await expect(page.locator('#meeting-title-input')).toHaveValue('');

  const toast = page.locator('.toast', { hasText: 'New meeting started' });
  await expect(toast).toBeVisible();
  await toast.locator('.toast-action').click(); // Undo
  await expect(page.locator('#meeting-title-input')).toHaveValue('Precious meeting');
});

test('first send confirms with the resolved recipients', async ({ page }) => {
  await page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem('meetingmaster.meeting.v1') || '{}');
    state.job = { id: 'job-9', state: 'ready' };
    state.pdfPath = '/tmp/meeting.pdf';
    localStorage.setItem('meetingmaster.meeting.v1', JSON.stringify(state));
  });
  await page.reload();

  let confirmText = '';
  page.once('dialog', (d) => {
    confirmText = d.message();
    d.accept();
  });
  await page.locator('#send-email-btn').click();
  await expect
    .poll(() => page.evaluate(() => window.__calls.filter((c) => c.name === 'sendPdfViaHome').length))
    .toBe(1);
  expect(confirmText).toContain('dr.smith@example.com');
  expect(confirmText).toContain('Meeting Notes — Test');
});

test('the setup checklist shows progress and can be hidden', async ({ page }) => {
  const checklist = page.locator('#setup-checklist');
  await expect(checklist).toBeVisible();
  await expect(checklist).toContainText('Getting set up');
  await expect(checklist).toContainText('✓ Connect the home server');
  await expect(checklist).toContainText('○ Record and transcribe your first meeting');

  await checklist.getByRole('button', { name: 'Hide the setup checklist' }).click();
  await expect(checklist).toBeHidden();
  // The dismissal is remembered.
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem('meetingmaster.checklist.v1')))
  ).toMatchObject({ dismissed: true });
});
