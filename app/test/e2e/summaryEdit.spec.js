'use strict';

// The in-app summary editor: the operator can adjust the AI summary (takeaways,
// insights, decisions, action items, figures, topics) before generating the PDF.
// Verifies the editor loads the current summary and round-trips edits back into
// state — including Key Insights, which is its own section (lessons to apply)
// and not a rewording of Key Takeaways (what happened).

const path = require('path');
const { pathToFileURL } = require('url');
const { test, expect } = require('@playwright/test');

const INDEX_URL = pathToFileURL(
  path.resolve(__dirname, '..', '..', 'src', 'renderer', 'index.html')
).href;

const SEED = {
  details: { title: 'Edit Meeting', date: '2026-07-16', time: '10:00', attendees: ['Alice', 'Bob'] },
  cards: [],
  recipients: [],
  options: { whisperModel: 'large-v3-turbo', emailMode: 'home' },
  job: { id: null, state: null },
  transcript: null,
  summary: {
    keyTakeaways: ['First takeaway.', 'Second takeaway.'],
    keyInsights: ['Start the review a week earlier next time.'],
    decisions: ['Approved the plan.'],
    actionItems: [{ task: 'Ship it', owner: 'Alice', due: 'Friday', priority: 'high' }],
    keyFigures: ['$10k budget'],
    topics: ['Budget', 'Timeline'],
  },
  extractedQuestions: [],
  questionsReviewed: false,
  pdfPath: null,
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript((seed) => {
    window.api = {
      getConfig: async () => ({ serverUrl: 'http://test', emailMode: 'home', pageSize: 'Letter', hasToken: true, configPath: '/dev/null' }),
      onJobProgress: () => () => {},
    };
    localStorage.setItem('meetingmaster.meeting.v1', JSON.stringify(seed));
  }, SEED);
  await page.goto(INDEX_URL);
});

test('the editor loads the summary and round-trips edits', async ({ page }) => {
  await page.getByRole('button', { name: 'Edit summary' }).click();
  const modal = page.locator('#summary-modal');
  await expect(modal).toBeVisible();

  // Loads the seeded content.
  await expect(page.locator('#sum-takeaways')).toHaveValue(/First takeaway\./);
  await expect(page.locator('#sum-insights')).toHaveValue(
    'Start the review a week earlier next time.'
  );
  await expect(page.locator('#sum-decisions')).toHaveValue('Approved the plan.');
  const rows = page.locator('.action-edit-row');
  await expect(rows).toHaveCount(1);
  await expect(rows.first().locator('.ae-task')).toHaveValue('Ship it');
  await expect(rows.first().locator('.ae-priority')).toHaveValue('high');

  // Edit: add a takeaway line and a second action item.
  await page.locator('#sum-takeaways').fill('First takeaway.\nSecond takeaway.\nThird takeaway.');
  await page.locator('#sum-insights').fill(
    'Start the review a week earlier next time.\nKeep the vendor on a written timeline.'
  );
  await page.getByRole('button', { name: 'Add action item' }).click();
  const newRow = page.locator('.action-edit-row').nth(1);
  await newRow.locator('.ae-task').fill('Review contract');
  await newRow.locator('.ae-owner').fill('Bob');
  await page.locator('#sum-save-btn').click();
  await expect(modal).toBeHidden();

  // Reopen — the edits persisted into state and reload into the editor.
  await page.getByRole('button', { name: 'Edit summary' }).click();
  await expect(page.locator('#sum-takeaways')).toHaveValue(/Third takeaway\./);
  await expect(page.locator('#sum-insights')).toHaveValue(/written timeline\./);
  await expect(page.locator('.action-edit-row')).toHaveCount(2);
  await expect(page.locator('.action-edit-row').nth(1).locator('.ae-task')).toHaveValue('Review contract');
});

test('insights kept from the live rail survive an AI summary landing on top', async ({ page }) => {
  // The operator keeps an insight mid-meeting; later the home server's own
  // summary REPLACES state.summary. The hand-picked insight must not vanish
  // with it — and it must lead, since a person chose it.
  await page.evaluate(async () => {
    const { keepInsight, applyKeptInsights } = await import('./js/liveInsights.js');
    const state = { summary: { keyTakeaways: ['t'], keyInsights: [] }, liveFlags: {} };
    keepInsight(state, 'Chase the vendor before the deadline next time.');
    // The server's summary arrives and overwrites everything.
    state.summary = { keyTakeaways: ['AI takeaway'], keyInsights: ['An AI insight.'] };
    applyKeptInsights(state);
    window.__result = state;
  });
  const state = await page.evaluate(() => window.__result);
  expect(state.summary.keyInsights).toEqual([
    'Chase the vendor before the deadline next time.',
    'An AI insight.',
  ]);
  expect(state.liveFlags.keptInsights).toEqual([
    'Chase the vendor before the deadline next time.',
  ]);
});

test('an insight edited out is forgotten, so a later AI run cannot re-assert it', async ({ page }) => {
  // Without this, deleting a kept insight in the editor would only hold until
  // the next AI run put it back — an edit that silently undoes itself.
  const result = await page.evaluate(async () => {
    const { keepInsight, reconcileKept, applyKeptInsights } = await import(
      './js/liveInsights.js'
    );
    const state = { summary: {}, liveFlags: {} };
    keepInsight(state, 'Kept then deleted.');
    keepInsight(state, 'Kept and kept.');

    // The operator saves the editor having deleted the first one.
    const edited = ['Kept and kept.'];
    reconcileKept(state, edited);
    state.summary = { keyInsights: edited };

    // A later AI run replaces the summary wholesale.
    state.summary = { keyInsights: ['An AI insight.'] };
    applyKeptInsights(state);
    return { kept: state.liveFlags.keptInsights, insights: state.summary.keyInsights };
  });
  expect(result.kept).toEqual(['Kept and kept.']);
  expect(result.insights).toEqual(['Kept and kept.', 'An AI insight.']);
});

test('insights left waiting in the rail are offered where Key Insights is decided', async ({
  page,
}) => {
  // The rail keeps un-actioned insights after the meeting, but it sits BEHIND
  // this dialog — and this dialog is the last thing touched before the PDF is
  // generated. Offering them here is the difference between "still available"
  // somewhere and actually seen.
  // A second init script, layered over beforeEach's: that one re-seeds
  // localStorage on every navigation, so writing the state and reloading would
  // just get it overwritten.
  await page.addInitScript((seed) => {
    localStorage.setItem(
      'meetingmaster.meeting.v1',
      JSON.stringify({
        ...seed,
        liveFlags: {
          pending: [],
          dismissed: [],
          pendingInsights: [
            'Chase the vendor a quarter earlier.',
            'Rehearse the failover.',
          ],
          dismissedInsights: [],
          keptInsights: [],
        },
      })
    );
  }, SEED);
  await page.reload();

  await page.getByRole('button', { name: 'Edit summary' }).click();
  const offers = page.locator('#sum-insight-offers');
  await expect(offers).toBeVisible();
  await expect(page.locator('.insight-offer')).toHaveCount(2);

  // Adding one moves it into the field and out of the rail's pending list.
  await page.locator('.insight-offer', { hasText: 'Chase the vendor' })
    .getByRole('button', { name: 'Add' })
    .click();
  await expect(page.locator('#sum-insights')).toHaveValue(/Chase the vendor a quarter earlier\./);
  await expect(page.locator('.insight-offer')).toHaveCount(1);
  await page.locator('#sum-save-btn').click();

  const saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('meetingmaster.meeting.v1'))
  );
  expect(saved.summary.keyInsights).toContain('Chase the vendor a quarter earlier.');
  // Remembered as kept, so a later AI summary can't drop it…
  expect(saved.liveFlags.keptInsights).toEqual(['Chase the vendor a quarter earlier.']);
  // …and the one still untouched is still waiting, not silently discarded.
  expect(saved.liveFlags.pendingInsights).toEqual(['Rehearse the failover.']);
});
