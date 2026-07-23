'use strict';

// In-app recording, exercised in plain Chromium against the real renderer.
// Chromium's fake media device (a generated tone) drives the REAL
// getUserMedia → WebAudio → MediaRecorder pipeline; the main-process side
// (durable file writes) is stubbed via window.api and captured in
// window.__recCalls for assertions.

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

// The full preload contract, with rec* calls recorded into window.__recCalls.
function apiStub() {
  window.__recCalls = [];
  const record = (name, args) => window.__recCalls.push({ name, args });
  window.api = {
    getConfig: async () => ({
      serverUrl: 'http://test',
      emailMode: 'home',
      pageSize: 'Letter',
      hasToken: true,
      micDeviceId: '',
      micDeviceLabel: '',
      configPath: '/dev/null',
    }),
    onJobProgress: () => () => {},
    onRecEvent: () => () => {},
    uploadMeeting: async (meeting, filePath) => {
      record('uploadMeeting', [filePath]);
      return { jobId: 'stub-job' };
    },
    getJobStatus: async () => ({
      id: 'stub-job',
      state: 'queued',
      transcript: null,
      summary: null,
      pdf: { received: false, emailed: false },
      error: null,
    }),
    renderPdf: async () => ({ pdfPath: '/tmp/stub.pdf', fontUsed: true, warning: null }),
    openPdf: async () => ({ ok: true }),
    sendPdfViaHome: async () => ({ ok: true, emailed: true, error: null }),
    sendPdfViaLaptop: async () => ({ ok: true, error: null }),
    pickWavFile: async () => {
      record('pickWavFile', []);
      return { filePath: null };
    },
    pickSavePath: async () => ({ filePath: null }),
    recStart: async (meta) => {
      record('recStart', [meta]);
      return {
        recId: 'rec-test',
        filePath: '/recordings/rec-test/audio.webm',
        freeBytes: 10 * 1024 * 1024 * 1024,
      };
    },
    recAppend: async (recId, seq, chunk, elapsedMs) => {
      record('recAppend', [recId, seq, chunk ? chunk.byteLength : 0, elapsedMs]);
      return { bytes: (seq + 1) * 1000, freeBytes: 10 * 1024 * 1024 * 1024 };
    },
    recStop: async (recId, info) => {
      record('recStop', [recId, info]);
      return {
        filePath: '/recordings/rec-test/audio.webm',
        bytes: 12345,
        durationMs: (info && info.durationMs) || 0,
      };
    },
    recDiscard: async (recId) => {
      record('recDiscard', [recId]);
      return { ok: true };
    },
    recListOrphans: async () => ({ orphans: [] }),
    recResolveOrphan: async (recId, action) => {
      record('recResolveOrphan', [recId, action]);
      return { filePath: `/recordings/${recId}/audio.webm`, bytes: 555000, durationMs: 61000 };
    },
    recStat: async (filePath) => {
      record('recStat', [filePath]);
      return { exists: window.__recStatExists !== false, bytes: 12345 };
    },
    recOpenFolder: async () => ({ ok: true }),
  };
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(apiStub);
});

async function startRecording(page) {
  await page.goto(INDEX_URL);
  await page.locator('#rec-start-btn').click();
  // acquiring -> recording: the Stop button appears once capture is live.
  await expect(page.locator('#rec-stop-btn')).toBeVisible({ timeout: 10000 });
}

test('start → chunks land in order → pause freezes the timer → stop attaches', async ({ page }) => {
  test.slow(); // waits ~7s of real time for the 5s MediaRecorder timeslice

  await startRecording(page);
  const timer = page.locator('#rec-timer');
  await expect(timer).toBeVisible();
  await expect(page.locator('#rec-meter')).toBeVisible();
  await expect(page.locator('#nav-meeting')).toHaveClass(/is-recording/);
  const calls = () => page.evaluate(() => window.__recCalls);
  expect((await calls()).some((c) => c.name === 'recStart')).toBe(true);

  // The timer ticks (fake device time still advances the wall clock).
  await expect(timer).not.toHaveText('00:00', { timeout: 5000 });
  // The level meter reacts to the fake device's tone.
  await expect
    .poll(async () => page.locator('#rec-meter-fill').evaluate((el) => el.style.width))
    .not.toBe('0%');

  // ≥1 append after the 5s timeslice, seq starting at 0, non-empty chunk.
  await expect
    .poll(async () => (await calls()).filter((c) => c.name === 'recAppend').length, {
      timeout: 9000,
    })
    .toBeGreaterThan(0);
  const firstAppend = (await calls()).find((c) => c.name === 'recAppend');
  expect(firstAppend.args[0]).toBe('rec-test');
  expect(firstAppend.args[1]).toBe(0); // seq
  expect(firstAppend.args[2]).toBeGreaterThan(0); // chunk bytes

  // Pause: timer text freezes.
  await page.locator('#rec-pause-btn').click();
  await expect(page.locator('#rec-resume-btn')).toBeVisible();
  const frozen = await timer.textContent();
  await page.waitForTimeout(1500);
  await expect(timer).toHaveText(frozen);

  // Resume, then stop: the recording is finalized and attached.
  await page.locator('#rec-resume-btn').click();
  await page.locator('#rec-stop-btn').click();
  await expect(page.locator('#rec-note')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#rec-note')).toContainText('Recording attached');
  expect((await calls()).some((c) => c.name === 'recStop')).toBe(true);

  const saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('meetingmaster.meeting.v1'))
  );
  expect(saved.recording.filePath).toBe('/recordings/rec-test/audio.webm');
  expect(saved.recording.source).toBe('in-app');
});

test('Generate transcript uploads the attached recording without the picker', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      'meetingmaster.meeting.v1',
      JSON.stringify({
        recording: {
          recId: 'rec-test',
          filePath: '/recordings/rec-test/audio.webm',
          durationMs: 60000,
          bytes: 12345,
          finishedAt: 1,
          source: 'in-app',
        },
      })
    );
  });
  await page.goto(INDEX_URL);

  await expect(page.locator('#rec-note')).toContainText('Recording attached');
  await page.locator('#pick-audio-btn').click();

  await expect
    .poll(async () =>
      page.evaluate(() => window.__recCalls.filter((c) => c.name === 'uploadMeeting').length)
    )
    .toBe(1);
  const calls = await page.evaluate(() => window.__recCalls);
  expect(calls.find((c) => c.name === 'uploadMeeting').args[0]).toBe(
    '/recordings/rec-test/audio.webm'
  );
  expect(calls.some((c) => c.name === 'pickWavFile')).toBe(false);
});

test('a missing attached file falls back to the picker and detaches', async ({ page }) => {
  await page.addInitScript(() => {
    window.__recStatExists = false;
    localStorage.setItem(
      'meetingmaster.meeting.v1',
      JSON.stringify({
        recording: {
          recId: 'rec-gone',
          filePath: '/recordings/rec-gone/audio.webm',
          durationMs: 60000,
          bytes: 12345,
          finishedAt: 1,
          source: 'in-app',
        },
      })
    );
  });
  await page.goto(INDEX_URL);

  await page.locator('#pick-audio-btn').click();
  await expect
    .poll(async () =>
      page.evaluate(() => window.__recCalls.filter((c) => c.name === 'pickWavFile').length)
    )
    .toBe(1);
  // The stale attachment was cleared; nothing was uploaded (picker canceled).
  const saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('meetingmaster.meeting.v1'))
  );
  expect(saved.recording).toBe(null);
  const calls = await page.evaluate(() => window.__recCalls);
  expect(calls.some((c) => c.name === 'uploadMeeting')).toBe(false);
});

test('"Upload audio file…" always opens the picker, even with an attachment', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      'meetingmaster.meeting.v1',
      JSON.stringify({
        recording: {
          recId: 'rec-test',
          filePath: '/recordings/rec-test/audio.webm',
          durationMs: 60000,
          bytes: 12345,
          finishedAt: 1,
          source: 'in-app',
        },
      })
    );
  });
  await page.goto(INDEX_URL);

  await page.locator('#pick-file-btn').click();
  await expect
    .poll(async () =>
      page.evaluate(() => window.__recCalls.filter((c) => c.name === 'pickWavFile').length)
    )
    .toBe(1);
});

test('an orphaned crash recording is offered and attaches on "Use it"', async ({ page }) => {
  await page.addInitScript(() => {
    const base = window.api;
    // Re-wrap after the base stub is installed (init scripts run in order).
    const orig = base.recListOrphans;
    base.recListOrphans = async () => ({
      orphans: [
        {
          recId: 'rec-orphan',
          filePath: '/recordings/rec-orphan/audio.webm',
          startedAt: new Date(Date.now() - 3600e3).toISOString(),
          bytes: 555000,
          durationMs: 61000,
        },
      ],
    });
    void orig;
  });
  await page.goto(INDEX_URL);

  const toast = page.locator('.toast', { hasText: 'Unfinished recording found' });
  await expect(toast).toBeVisible();
  await toast.locator('.toast-action').click();

  await expect(page.locator('#rec-note')).toContainText('Recording attached (recovered after a crash)');
  const calls = await page.evaluate(() => window.__recCalls);
  const resolve = calls.find((c) => c.name === 'recResolveOrphan');
  expect(resolve.args).toEqual(['rec-orphan', 'attach']);
  const saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('meetingmaster.meeting.v1'))
  );
  expect(saved.recording.source).toBe('recovered');
});

test('recording survives screen switches and blocks New meeting + uploads', async ({ page }) => {
  await startRecording(page);

  // Uploads are disabled while the file is still being written.
  await expect(page.locator('#pick-audio-btn')).toBeDisabled();
  await expect(page.locator('#pick-file-btn')).toBeDisabled();

  // Switch away and back — the recording keeps running.
  await page.locator('#nav-activity').click();
  await expect(page.locator('#screen-activity')).toBeVisible();
  await expect(page.locator('#nav-meeting')).toHaveClass(/is-recording/);
  await page.locator('#nav-meeting').click();
  await expect(page.locator('#rec-timer')).toBeVisible();
  await expect(page.locator('#rec-stop-btn')).toBeVisible();

  // New meeting is refused mid-recording.
  await page.locator('#new-meeting-btn').click();
  await expect(page.locator('#status-text')).toContainText('A recording is in progress');

  // Discard cleans up without attaching.
  page.once('dialog', (d) => d.accept());
  await page.locator('#rec-discard-btn').click();
  await expect(page.locator('#rec-start-btn')).toBeVisible({ timeout: 10000 });
  const calls = await page.evaluate(() => window.__recCalls);
  expect(calls.some((c) => c.name === 'recDiscard')).toBe(true);
  await expect(page.locator('#pick-audio-btn')).toBeEnabled();
});
