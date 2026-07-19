'use strict';

// Activity screen: pipeline stepper follows the current job, the recent-jobs
// list renders and live-patches from SSE events, and the log viewer appends
// streamed lines. window.api is stubbed with a test-driveable onServerEvent.

const path = require('path');
const { pathToFileURL } = require('url');
const { test, expect } = require('@playwright/test');

const INDEX_URL = pathToFileURL(
  path.resolve(__dirname, '..', '..', 'src', 'renderer', 'index.html')
).href;

const SEED = {
  details: { title: 'Live Meeting', date: '2026-07-19', time: '10:00', attendees: [] },
  cards: [],
  recipients: [],
  options: { whisperModel: 'large-v3-turbo', emailMode: 'home' },
  job: { id: 'job-live', state: 'transcribing', progress: 41 },
  transcript: null,
  summary: null,
  extractedQuestions: [],
  questionsReviewed: false,
  pdfPath: null,
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript((seed) => {
    window.__sseCbs = [];
    window.__pushServerEvent = (payload) => window.__sseCbs.forEach((cb) => cb(payload));
    window.api = {
      getConfig: async () => ({
        serverUrl: 'http://test', emailMode: 'home', pageSize: 'Letter',
        hasToken: true, configPath: '/dev/null',
      }),
      onJobProgress: () => () => {},
      onServerEvent: (cb) => { window.__sseCbs.push(cb); return () => {}; },
      getServerStatus: async () => ({
        configured: true, reachability: 'ok', sse: 'connected',
        serverUrl: 'http://test', serverVersion: '0.2.0', lastEventAt: Date.now(),
      }),
      getJobStatus: async () => ({ id: 'job-live', state: 'transcribing', progress: 41 }),
      listJobs: async () => ({
        jobs: [
          { id: 'job-live', state: 'transcribing', progress: 41, title: 'Live Meeting', updatedAt: new Date().toISOString(), createdAt: '', error: null, pdf: { received: false, emailed: false } },
          { id: 'job-old', state: 'emailed', progress: null, title: 'Yesterday Sync', updatedAt: new Date().toISOString(), createdAt: '', error: null, pdf: { received: true, emailed: true } },
        ],
      }),
      getLogTail: async () => ({ lines: ['line one', 'line two'] }),
    };
    localStorage.setItem('meetingmaster.meeting.v1', JSON.stringify(seed));
  }, SEED);
  await page.goto(INDEX_URL);
  await page.locator('#nav-activity').click();
});

test('pipeline stepper reflects the in-flight job with live progress', async ({ page }) => {
  const steps = page.locator('.pipe-step');
  await expect(steps).toHaveCount(5);
  await expect(steps.nth(2)).toHaveClass(/current/); // Transcribe
  await expect(steps.nth(0)).toHaveClass(/done/);
  await expect(steps.nth(2).locator('.pipe-sub')).toHaveText('41%');

  // A live SSE job event moves the pipeline forward.
  await page.evaluate(() => window.__pushServerEvent({
    type: 'sse', event: 'job',
    data: { id: 'job-live', state: 'summarizing', progress: null, title: 'Live Meeting', updatedAt: new Date().toISOString() },
  }));
  await expect(steps.nth(3)).toHaveClass(/current/);
  await expect(steps.nth(2)).toHaveClass(/done/);
});

test('recent jobs render and live-patch from SSE', async ({ page }) => {
  const rows = page.locator('.job-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('Live Meeting');
  await expect(rows.nth(1)).toContainText('Yesterday Sync');

  await page.evaluate(() => window.__pushServerEvent({
    type: 'sse', event: 'job',
    data: { id: 'job-new', state: 'queued', progress: null, title: 'Brand New Job', updatedAt: new Date().toISOString() },
  }));
  await expect(page.locator('.job-row')).toHaveCount(3);
  await expect(page.locator('.job-row').nth(0)).toContainText('Brand New Job');
});

test('log viewer shows the tail and appends streamed lines', async ({ page }) => {
  const log = page.locator('#log-view');
  await expect(log).toContainText('line one');
  await expect(log).toContainText('line two');

  await page.evaluate(() => window.__pushServerEvent({
    type: 'sse', event: 'log', data: { line: 'a fresh streamed line' },
  }));
  await expect(log).toContainText('a fresh streamed line');
});

test('server pill reflects the pushed status', async ({ page }) => {
  await expect(page.locator('#server-pill')).toHaveAttribute('data-status', 'ok');
  await page.evaluate(() => window.__pushServerEvent({
    type: 'status',
    status: { configured: true, reachability: 'unreachable', sse: 'connecting', serverUrl: 'http://test', serverVersion: null, lastEventAt: null },
  }));
  await expect(page.locator('#server-pill')).toHaveAttribute('data-status', 'down');
  await expect(page.locator('#server-pill-label')).toHaveText('Server unreachable');
});
