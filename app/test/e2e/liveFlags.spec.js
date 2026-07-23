'use strict';

// Live question suggestions rail: peripheral, monitorable while typing.
// Candidates are pushed through the captured onLiveEvent callbacks — no
// recording or fake device needed.

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

test('the rail shows a listening state on live start, before any candidates', async ({ page }) => {
  const rail = page.locator('#live-rail');
  await expect(rail).toBeHidden();

  await page.evaluate(() => document.dispatchEvent(new CustomEvent('mm:live-start')));
  await expect(rail).toBeVisible();
  await expect(page.locator('#live-rail-empty')).toBeVisible();
  await expect(page.locator('#live-rail-count')).toBeHidden();

  // Session ends with nothing pending → the rail retires.
  await page.evaluate(() => window.__liveCbs.forEach((cb) => cb({ type: 'stopped' })));
  await expect(rail).toBeHidden();
});

test('candidates collect in the rail; Approve makes a card; Dismiss is remembered', async ({ page }) => {
  const rail = page.locator('#live-rail');

  await pushCandidates(page, [Q1, Q2]);
  await expect(rail).toBeVisible();
  await expect(page.locator('#live-rail-count')).toHaveText('2');
  await expect(page.locator('#live-rail-empty')).toBeHidden();
  const rows = rail.locator('.live-flag-row');
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
  await expect(rail.locator('.live-flag-row')).toHaveCount(1);

  // Dismiss the second, then re-push it — the dismissal memory filters it.
  await rail.locator('.live-flag-row button', { hasText: 'Dismiss' }).click();
  await expect(rail).toBeHidden(); // no session, nothing pending
  await pushCandidates(page, [Q2]);
  await page.waitForTimeout(200);
  await expect(rail).toBeHidden();

  const saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('meetingmaster.meeting.v1'))
  );
  expect(saved.liveFlags.pending).toHaveLength(0);
  expect(saved.liveFlags.dismissed).toHaveLength(1);
  expect(saved.cards).toHaveLength(1);
});

test('arrivals never disturb the capture modal — and the rail stays usable', async ({ page }) => {
  // Open the manual capture modal and start typing.
  await page.keyboard.press('q');
  const question = page.locator('#card-question');
  await expect(question).toBeFocused();
  await page.keyboard.type('Manually typed quest');

  // A candidate arrives mid-typing: the rail updates beside the modal…
  await pushCandidates(page, [Q1]);
  await expect(page.locator('#live-rail')).toBeVisible();
  await expect(page.locator('#live-rail .live-flag-row')).toHaveCount(1);

  // …but focus and the draft are untouched.
  await expect(question).toBeFocused();
  await expect(question).toHaveValue('Manually typed quest');

  // The rail is mouse-clickable above the modal backdrop: approve now.
  await page.locator('#live-rail button', { hasText: 'Approve' }).click();
  await expect(page.locator('#card-list .qa-card')).toHaveCount(1);

  // The modal is still open and the draft still intact — finish it.
  await question.click();
  await page.keyboard.type('ion?');
  await page.keyboard.press('Enter');
  await expect(page.locator('#card-list .qa-card')).toHaveCount(2);
});

test('a candidate duplicating an existing card is never shown', async ({ page }) => {
  await page.keyboard.press('q');
  await page.keyboard.type('What is the renewal price?');
  await page.keyboard.press('Tab');
  await page.keyboard.type('12% locked.');
  await page.keyboard.press('Enter');
  await expect(page.locator('#card-list .qa-card')).toHaveCount(1);

  await pushCandidates(page, [Q1]);
  await page.waitForTimeout(200);
  await expect(page.locator('#live-rail')).toBeHidden();
});

test('duplicate pushes collapse into one pending row', async ({ page }) => {
  await pushCandidates(page, [Q1]);
  await pushCandidates(page, [Q1]); // e.g. flagger + a later tick overlap
  await expect(page.locator('#live-rail .live-flag-row')).toHaveCount(1);
});
