'use strict';

// Inline live question candidates in the Q&A panel: approve → card,
// dismiss → per-meeting memory, duplicate filtering. No recording needed —
// candidates are pushed through the captured onLiveEvent callbacks.

const path = require('path');
const { pathToFileURL } = require('url');
const { test, expect } = require('@playwright/test');

const INDEX_URL = pathToFileURL(
  path.resolve(__dirname, '..', '..', 'src', 'renderer', 'index.html')
).href;

function apiStub() {
  window.__liveCbs = [];
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
    uploadMeeting: async () => ({ jobId: 'stub-job' }),
    getJobStatus: async () => ({ id: 'stub-job', state: 'queued' }),
    renderPdf: async () => ({ pdfPath: '/tmp/stub.pdf', fontUsed: true, warning: null }),
    openPdf: async () => ({ ok: true }),
    sendPdfViaHome: async () => ({ ok: true, emailed: true, error: null }),
    sendPdfViaLaptop: async () => ({ ok: true, error: null }),
    pickWavFile: async () => ({ filePath: null }),
    pickSavePath: async () => ({ filePath: null }),
    recListOrphans: async () => ({ orphans: [] }),
    liveSupportGet: async () => ({ supported: false, models: {} }),
    onLiveEvent: (cb) => {
      window.__liveCbs.push(cb);
      return () => {};
    },
    onLiveModelEvent: () => () => {},
  };
}

function pushCandidates(page, questions) {
  return page.evaluate(
    (qs) => window.__liveCbs.forEach((cb) => cb({ type: 'flag-candidates', questions: qs })),
    questions
  );
}

const Q1 = {
  question: 'What is the renewal price?',
  answer: 'A 12% increase locked for 24 months.',
  answerer: 'Bob',
  directedTo: 'Bob',
  confidence: 'high',
};
const Q2 = {
  question: 'When does the migration finish?',
  answer: 'By the end of Q3.',
  answerer: '',
  directedTo: 'Alice',
  confidence: 'low',
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript(apiStub);
  await page.addInitScript(() => {
    localStorage.setItem(
      'meetingmaster.meeting.v1',
      JSON.stringify({ details: { title: 'Test', date: '', time: '', attendees: ['Alice', 'Bob'] } })
    );
  });
  await page.goto(INDEX_URL);
});

test('candidates render inline; Approve makes a card; Dismiss is remembered', async ({ page }) => {
  const host = page.locator('#live-flags');
  await expect(host).toBeHidden();

  await pushCandidates(page, [Q1, Q2]);
  await expect(host).toBeVisible();
  await expect(host.locator('.live-flags-heading')).toContainText('2 questions');
  const rows = host.locator('.live-flag-row');
  await expect(rows).toHaveCount(2);

  // Low-confidence candidate carries the "check answerer" flag.
  await expect(rows.nth(1).locator('.extract-flag')).toContainText('check answerer');

  // Approve the first — answerer prefilled from the AI's guess.
  await expect(rows.first().locator('.extract-answerer')).toHaveValue('Bob');
  await rows.first().locator('button', { hasText: 'Approve' }).click();
  await expect(page.locator('#card-list .qa-card')).toHaveCount(1);
  await expect(page.locator('#card-list .qa-card').first()).toContainText(
    'What is the renewal price?'
  );
  await expect(host.locator('.live-flag-row')).toHaveCount(1);

  // Dismiss the second, then re-push it — the dismissal memory filters it.
  await host.locator('.live-flag-row button', { hasText: 'Dismiss' }).click();
  await expect(host).toBeHidden();
  await pushCandidates(page, [Q2]);
  await page.waitForTimeout(200);
  await expect(host).toBeHidden();

  // Both decisions persisted per meeting.
  const saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('meetingmaster.meeting.v1'))
  );
  expect(saved.liveFlags.pending).toHaveLength(0);
  expect(saved.liveFlags.dismissed).toHaveLength(1);
  expect(saved.cards).toHaveLength(1);
});

test('a candidate duplicating an existing card is never shown', async ({ page }) => {
  // Type the question as a card first (via the capture modal).
  await page.keyboard.press('q');
  await page.keyboard.type('What is the renewal price?');
  await page.keyboard.press('Tab');
  await page.keyboard.type('12% locked.');
  await page.keyboard.press('Enter');
  await expect(page.locator('#card-list .qa-card')).toHaveCount(1);

  await pushCandidates(page, [Q1]);
  await page.waitForTimeout(200);
  await expect(page.locator('#live-flags')).toBeHidden();
});

test('duplicate pushes collapse into one pending row', async ({ page }) => {
  await pushCandidates(page, [Q1]);
  await pushCandidates(page, [Q1]); // e.g. flagger + a later tick overlap
  await expect(page.locator('#live-flags .live-flag-row')).toHaveCount(1);
});
