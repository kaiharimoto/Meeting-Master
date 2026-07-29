'use strict';

// Live suggestions rail: peripheral, monitorable while typing. Both kinds of
// suggestion (answered questions -> cards, key insights -> the summary's Key
// Insights) and the loop's status line. Everything is pushed through the
// captured onLiveEvent callbacks — no recording or fake device needed.

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

function pushCandidates(page, questions, insights) {
  return page.evaluate(
    (payload) =>
      window.__liveCbs.forEach((cb) =>
        cb({ type: 'flag-candidates', questions: payload.qs, insights: payload.ins })
      ),
    { qs: questions, ins: insights || [] }
  );
}

function pushStatus(page, state, message) {
  return page.evaluate(
    (p) => window.__liveCbs.forEach((cb) => cb({ type: 'flag-status', ...p })),
    { state, message }
  );
}

const I1 = 'Chase the vendor a quarter earlier next renewal.';
const I2 = 'Tie every SLA concession to the work it depends on.';

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

test('insights arrive in their own group; Keep sends one to Key Insights', async ({ page }) => {
  const rail = page.locator('#live-rail');
  const group = page.locator('#live-rail-insight-group');
  await expect(group).toBeHidden();

  await pushCandidates(page, [Q1], [I1, I2]);
  await expect(rail).toBeVisible();
  await expect(group).toBeVisible();
  // One question + two insights.
  await expect(page.locator('#live-rail-count')).toHaveText('3');
  await expect(page.locator('#live-rail-insights .live-insight-row')).toHaveCount(2);
  // Insights are NOT mixed into the question list.
  await expect(page.locator('#live-rail-list .live-flag-row')).toHaveCount(1);

  // Keep the first: it lands in the summary's Key Insights, ready for the PDF,
  // without needing the post-meeting AI to run at all.
  await page.locator('#live-rail-insights button', { hasText: 'Keep' }).first().click();
  await expect(page.locator('#live-rail-insights .live-insight-row')).toHaveCount(1);

  const saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('meetingmaster.meeting.v1'))
  );
  expect(saved.summary.keyInsights).toEqual([I1]);
  expect(saved.liveFlags.keptInsights).toEqual([I1]);
  expect(saved.liveFlags.pendingInsights).toEqual([I2]);
  // Keeping an insight never creates a Q&A card.
  expect(saved.cards || []).toHaveLength(0);
});

test('a dismissed insight is remembered and never offered again', async ({ page }) => {
  await pushCandidates(page, [], [I1]);
  await expect(page.locator('#live-rail-insights .live-insight-row')).toHaveCount(1);

  await page.locator('#live-rail-insights button', { hasText: 'Dismiss' }).click();
  await expect(page.locator('#live-rail-insight-group')).toBeHidden();

  await pushCandidates(page, [], [I1]);
  await page.waitForTimeout(200);
  await expect(page.locator('#live-rail-insight-group')).toBeHidden();

  const saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('meetingmaster.meeting.v1'))
  );
  expect(saved.liveFlags.dismissedInsights).toHaveLength(1);
  expect(saved.liveFlags.pendingInsights).toHaveLength(0);
});

test('an insight already in the summary is not offered again', async ({ page }) => {
  await pushCandidates(page, [], [I1]);
  await page.locator('#live-rail-insights button', { hasText: 'Keep' }).click();

  // The same point, re-noticed a few minutes later by the same loop.
  await pushCandidates(page, [], [I1.toUpperCase()]);
  await page.waitForTimeout(200);
  await expect(page.locator('#live-rail-insights .live-insight-row')).toHaveCount(0);
});

test('the status line says which of "asking", "unreachable" and "off" is happening', async ({
  page,
}) => {
  const status = page.locator('#live-rail-status');
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('mm:live-start')));
  await expect(status).toBeHidden(); // nothing to say yet

  await pushStatus(page, 'asking', 'Asking the home server…');
  await expect(status).toBeVisible();
  await expect(status).toHaveText('Asking the home server…');
  // A healthy state stays neutral, and the listening explainer stays put.
  await expect(status).toHaveAttribute('data-state', 'asking');
  await expect(page.locator('#live-rail-empty')).toBeVisible();

  // A real failure is visible without being interruptive: no toast, no dialog.
  await pushStatus(page, 'error', 'Live suggestions are paused — timed out.');
  await expect(status).toHaveAttribute('data-state', 'error');
  await expect(page.locator('#toast-region .toast')).toHaveCount(0);
  // …and it takes over the space the "listening…" explainer had.
  await expect(page.locator('#live-rail-empty')).toBeHidden();

  await pushStatus(page, 'off', 'Live suggestions are switched off on the home server.');
  await expect(status).toContainText('switched off');

  // The session ending clears the line with the rail.
  await page.evaluate(() => window.__liveCbs.forEach((cb) => cb({ type: 'stopped' })));
  await expect(page.locator('#live-rail')).toBeHidden();
});
