'use strict';

// The mid-meeting loop, end to end.
//
// The job these features serve: a question is asked and written down in two
// seconds; the answer arrives three minutes later, by which time the next
// question is being asked. Everything here is about making that gap cheap —
// answer-later in place, a capture stamp so the transcript can close the gap
// afterwards, and an attendee list that keeps up with who is actually talking.

const path = require('path');
const { pathToFileURL } = require('url');
const { test, expect } = require('@playwright/test');

const INDEX_URL = pathToFileURL(
  path.resolve(__dirname, '..', '..', 'src', 'renderer', 'index.html')
).href;

function apiStub() {
  window.__draftCalls = [];
  window.__draftAnswers = [];
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
    uploadMeeting: async () => ({ jobId: 'stub-job' }),
    getJobStatus: async () => ({ id: 'stub-job', state: 'ready' }),
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
    retrySummary: async () => ({ ok: true }),
    draftAnswers: async (jobId, questions, attendees) => {
      window.__draftCalls.push({ jobId, questions, attendees });
      return { answers: window.__draftAnswers };
    },
  };
}

const cards = (page) => page.locator('#card-list .qa-card');
const stored = (page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('meetingmaster.meeting.v1')));

test.beforeEach(async ({ page }) => {
  await page.addInitScript(apiStub);
  await page.setViewportSize({ width: 1280, height: 1200 });
  await page.goto(INDEX_URL);
});

// ---- 1. Answer later, in place ---------------------------------------------

test('a question with no answer still offers somewhere to put one', async ({ page }) => {
  await page.locator('#quick-question').click();
  await page.keyboard.type('What is the renewal price?');
  await page.keyboard.press('Enter');

  // The slot exists and says what it is for — before this it was removed
  // entirely, so the fastest path to the commonest edit didn't exist.
  const slot = cards(page).first().locator('.card-answer');
  await expect(slot).toBeVisible();
  await expect(slot).toHaveClass(/is-blank/);
  await expect(slot).toContainText('Add an answer');

  await slot.click();
  const editor = page.locator('.card-editor--answer');
  await expect(editor).toBeFocused();
  // The placeholder is an invitation, not content — the editor starts empty.
  await expect(editor).toHaveValue('');

  await editor.fill('A 12% increase locked for 24 months.');
  await page.keyboard.press('Enter');

  await expect(slot).not.toHaveClass(/is-blank/);
  await expect(cards(page).first()).toContainText('A 12% increase locked for 24 months.');
  expect((await stored(page)).cards[0].answer).toBe('A 12% increase locked for 24 months.');
});

test('A on a focused card goes straight to the answer', async ({ page }) => {
  await page.locator('#quick-question').click();
  await page.keyboard.type('Who signs off on the SOW?');
  await page.keyboard.press('Enter');

  await cards(page).first().focus();
  await page.keyboard.press('a');
  await expect(page.locator('.card-editor--answer')).toBeFocused();

  await page.keyboard.type('Legal, after redlines.');
  await page.keyboard.press('Enter');
  await expect(cards(page).first()).toContainText('Legal, after redlines.');

  // E still goes to the question — the two keys don't collide.
  await cards(page).first().focus();
  await page.keyboard.press('e');
  await expect(page.locator('.card-editor--question')).toBeFocused();
});

// ---- 2. Capture stamps -----------------------------------------------------

test('a card captured outside a recording has a wall-clock stamp but no offset', async ({
  page,
}) => {
  await page.locator('#quick-question').click();
  await page.keyboard.type('Captured before anything is rolling?');
  await page.keyboard.press('Enter');

  const card = (await stored(page)).cards[0];
  expect(card.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  // No recording, no offset — and nothing shown on the card either.
  expect(card.atMs).toBeUndefined();
  await expect(cards(page).first().locator('.card-stamp')).toHaveCount(0);
});

// The offset a card gets WHILE a recording runs is asserted in
// recording.spec.js, which drives the real recorder with Chromium's fake
// device — stubbing the elapsed clock here would only test the stub.

test('a stamped card shows its offset on the card', async ({ page }) => {
  await page.evaluate(() => {
    const KEY = 'meetingmaster.meeting.v1';
    const state = JSON.parse(localStorage.getItem(KEY) || '{}');
    state.cards = [
      { id: 'c1', question: 'Asked at 2:05?', answer: '', participant: '', atMs: 125000 },
      { id: 'c2', question: 'Typed after the fact?', answer: '', participant: '' },
    ];
    localStorage.setItem(KEY, JSON.stringify(state));
  });
  await page.reload();

  await expect(cards(page).nth(0).locator('.card-stamp')).toHaveText('02:05');
  // A card with no stamp shows nothing rather than a zero.
  await expect(cards(page).nth(1).locator('.card-stamp')).toHaveCount(0);
});

// ---- 4. Attendee promotion -------------------------------------------------

test('naming someone who is not an attendee offers to add them', async ({ page }) => {
  await page.locator('#meeting-attendees-input').fill('Alice Chen\nBob Ramirez');

  // Not the Q key: focus is still in the attendees textarea, where a bare "q"
  // is correctly just a letter.
  await page.locator('#add-card-btn').click();
  await page.locator('#card-question').fill('When does the migration finish?');
  await page.locator('#card-participant').fill('Dana Lee');
  await page.keyboard.press('Enter');

  const toast = page.locator('#toast-region');
  await expect(toast).toContainText("isn't listed as an attendee");
  await toast.locator('button', { hasText: 'Add Dana Lee' }).click();

  await expect(page.locator('#meeting-attendees-input')).toHaveValue(
    'Alice Chen\nBob Ramirez\nDana Lee'
  );
  expect((await stored(page)).details.attendees).toContain('Dana Lee');
});

test('a known attendee is never offered, and nobody is offered twice', async ({ page }) => {
  await page.locator('#meeting-attendees-input').fill('Alice Chen');

  await page.locator('#add-card-btn').click();
  await page.locator('#card-question').fill('First?');
  await page.locator('#card-participant').fill('Alice Chen');
  await page.keyboard.press('Enter');
  await expect(page.locator('#toast-region')).not.toContainText('attendee');

  // An unknown name is offered once…
  await page.locator('#add-card-btn').click();
  await page.locator('#card-question').fill('Second?');
  await page.locator('#card-participant').fill('Priya Natarajan');
  await page.keyboard.press('Enter');
  await expect(page.locator('#toast-region')).toContainText('Priya Natarajan');

  // …and dismissing it is an answer. Asking again on the next card would be
  // nagging, so the same name is never raised twice in one meeting.
  await page.locator('#toast-region .toast-close').first().click();
  await expect(page.locator('#toast-region')).not.toContainText('Priya Natarajan');

  await page.locator('#add-card-btn').click();
  await page.locator('#card-question').fill('Third?');
  await page.locator('#card-participant').fill('Priya Natarajan');
  await page.keyboard.press('Enter');
  await expect(page.locator('#toast-region')).not.toContainText('Priya Natarajan');
});

// ---- 3. Fill blank answers from the transcript -----------------------------

async function seedReadyMeeting(page) {
  await page.evaluate(() => {
    const KEY = 'meetingmaster.meeting.v1';
    const state = JSON.parse(localStorage.getItem(KEY) || '{}');
    state.details = {
      title: 'Q3 Vendor Contract Review',
      date: '2026-07-28',
      time: '11:00',
      attendees: ['Alice Chen', 'Bob Ramirez'],
    };
    state.cards = [
      { id: 'c1', question: 'What is the renewal price?', answer: '', participant: '', atMs: 120000 },
      { id: 'c2', question: 'When does migration finish?', answer: '', participant: '', atMs: 360000 },
      { id: 'c3', question: 'Who signs the SOW?', answer: 'Legal.', participant: 'Alice Chen' },
    ];
    state.job = { id: 'stub-job', state: 'ready' };
    state.transcript = { text: 'a transcript exists' };
    localStorage.setItem(KEY, JSON.stringify(state));
  });
  await page.reload();
  await page.locator('#generate-heading .panel-toggle').click().catch(() => {});
}

test('blank answers are drafted from the transcript and applied only when approved', async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.__draftAnswers = [
      { id: 'c1', answer: 'A 12% increase locked for 24 months.', answerer: 'Bob Ramirez', confidence: 'high' },
      { id: 'c2', answer: 'End of Q3.', answerer: '', confidence: 'low' },
    ];
  });
  await seedReadyMeeting(page);

  const btn = page.locator('#fill-answers-btn');
  await expect(btn).toBeEnabled();
  await btn.click();

  // Only the BLANK cards are sent, each with when it was captured — that is
  // what lets the server read the right part of the transcript.
  const call = (await page.evaluate(() => window.__draftCalls))[0];
  expect(call.jobId).toBe('stub-job');
  expect(call.questions.map((q) => q.id)).toEqual(['c1', 'c2']);
  expect(call.questions[0].atMs).toBe(120000);
  expect(call.attendees).toEqual(['Alice Chen', 'Bob Ramirez']);

  const modal = page.locator('#answers-modal');
  await expect(modal).toBeVisible();
  await expect(modal.locator('.answer-row')).toHaveCount(2);

  // A confident draft is pre-ticked; an unsure one is not — the operator opts
  // IN to the guesses rather than having to opt out of them.
  const checks = modal.locator('.extract-check');
  await expect(checks.nth(0)).toBeChecked();
  await expect(checks.nth(1)).not.toBeChecked();
  await expect(modal.locator('.extract-flag')).toHaveCount(1);

  await modal.locator('#answers-apply-btn').click();
  await expect(modal).toBeHidden();

  const state = await stored(page);
  expect(state.cards[0].answer).toBe('A 12% increase locked for 24 months.');
  expect(state.cards[0].participant).toBe('Bob Ramirez');
  // The unticked one is untouched — nothing lands without approval.
  expect(state.cards[1].answer).toBe('');
  // …and the card that already had an answer was never in play.
  expect(state.cards[2].answer).toBe('Legal.');
});

test('a draft can be edited in the review before it is used', async ({ page }) => {
  await page.addInitScript(() => {
    window.__draftAnswers = [
      { id: 'c1', answer: 'Roughly twelve percent, I think.', answerer: 'Bob Ramirez', confidence: 'high' },
    ];
  });
  await seedReadyMeeting(page);
  await page.locator('#fill-answers-btn').click();

  const draft = page.locator('#answers-modal .answer-draft').first();
  await draft.fill('A 12% increase, locked for 24 months.');
  await page.locator('#answers-apply-btn').click();

  expect((await stored(page)).cards[0].answer).toBe('A 12% increase, locked for 24 months.');
});

test('a transcript with no answers in it says so instead of opening an empty review', async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.__draftAnswers = [
      { id: 'c1', answer: '', answerer: '', confidence: 'low' },
      { id: 'c2', answer: '', answerer: '', confidence: 'low' },
    ];
  });
  await seedReadyMeeting(page);
  await page.locator('#fill-answers-btn').click();

  await expect(page.locator('#answers-modal')).toBeHidden();
  await expect(page.locator('#status-text')).toContainText('did not answer any');
});

test('the fill button is off until there is a transcript and something to fill', async ({
  page,
}) => {
  // Fresh meeting: no job, no transcript, no cards.
  await expect(page.locator('#generate-heading .panel-toggle')).toBeVisible();
  await page.locator('#generate-heading .panel-toggle').click();
  await expect(page.locator('#fill-answers-btn')).toBeDisabled();

  // A transcript but every question answered is still nothing to do.
  await page.evaluate(() => {
    const KEY = 'meetingmaster.meeting.v1';
    const state = JSON.parse(localStorage.getItem(KEY) || '{}');
    state.cards = [{ id: 'x', question: 'Q?', answer: 'A.', participant: '' }];
    state.job = { id: 'stub-job', state: 'ready' };
    state.transcript = { text: 'text' };
    localStorage.setItem(KEY, JSON.stringify(state));
  });
  await page.reload();
  await page.locator('#generate-heading .panel-toggle').click();
  await expect(page.locator('#fill-answers-btn')).toBeDisabled();
});

// ---- 5. Start a meeting like a past one ------------------------------------

test('"Start like this" carries the setup over and nothing else', async ({ page }) => {
  // Build a meeting worth reusing, then save it.
  await page.locator('#meeting-title-input').fill('Weekly Vendor Sync');
  await page.locator('#meeting-attendees-input').fill('Alice Chen\nBob Ramirez');
  await page.locator('#meeting-recipients-input').fill('exec@example.com, ops@example.com');
  await page.locator('#quick-question').click();
  await page.keyboard.type('Last week’s question?');
  await page.keyboard.press('Enter');

  await page.locator('#history-btn').click();
  await page.locator('#history-save-btn').click();
  await expect(page.locator('.history-row')).toHaveCount(1);

  await page.locator('.history-row').first().locator('button', { hasText: 'Start like this' }).click();
  await expect(page.locator('#history-modal')).toBeHidden();

  // The setup came across…
  await expect(page.locator('#meeting-title-input')).toHaveValue('Weekly Vendor Sync');
  await expect(page.locator('#meeting-attendees-input')).toHaveValue('Alice Chen\nBob Ramirez');
  await expect(page.locator('#meeting-recipients-input')).toHaveValue(
    'exec@example.com, ops@example.com'
  );

  // …and none of last week's content did.
  await expect(cards(page)).toHaveCount(0);
  const state = await stored(page);
  expect(state.cards).toEqual([]);
  expect(state.transcript).toBeNull();
  expect(state.summary).toBeNull();
  expect(state.job.id).toBeNull();
  // A new meeting, not the old one wearing its name.
  expect(state.details.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);

  // The old meeting is still in History, complete — this is never a way to
  // lose work. (One row, not two: the outgoing save UPDATES the snapshot it
  // came from rather than duplicating it, and the fresh meeting has nothing
  // in it worth saving yet.)
  await page.locator('#history-btn').click();
  await expect(page.locator('.history-row')).toHaveCount(1);
  await expect(page.locator('.history-row').first()).toContainText('Weekly Vendor Sync');
  await expect(page.locator('.history-row').first()).toContainText('1 question');
});
