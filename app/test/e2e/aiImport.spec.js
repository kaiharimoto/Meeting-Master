'use strict';

// The external-AI escape hatch: transcript buttons on the Meeting screen and
// the summary editor's "Import AI output" (paste the JSON an external model
// produced from the copied prompt harness).

const path = require('path');
const { pathToFileURL } = require('url');
const { test, expect } = require('@playwright/test');

const INDEX_URL = pathToFileURL(
  path.resolve(__dirname, '..', '..', 'src', 'renderer', 'index.html')
).href;

const AI_REPLY = {
  keyTakeaways: ['Q3 launch slips to November', 'Budget approved'],
  keyInsights: ['Lock the launch scope before the budget review, not after.'],
  decisions: ['Ship the beta to internal users first'],
  actionItems: [
    { task: 'Draft rollout plan', owner: 'Alice', due: 'Nov 15', priority: 'high' },
    'Update the pricing page',
  ],
  keyFigures: ['12% price increase, locked 24 months'],
  topics: ['Launch timing', 'Pricing'],
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.api = {
      getConfig: async () => ({
        serverUrl: 'http://test', emailMode: 'home', pageSize: 'Letter',
        hasToken: true, configPath: '/dev/null',
      }),
      onJobProgress: () => () => {},
      getJobPrompt: async () => ({ text: 'PROMPT' }),
    };
  });
  await page.goto(INDEX_URL);
});

test('transcript buttons disabled without a transcript, enabled with one', async ({ page }) => {
  await expect(page.locator('#copy-transcript-btn')).toBeDisabled();
  await expect(page.locator('#copy-ai-prompt-btn')).toBeDisabled();

  // Seed state via the same localStorage contract the app persists with.
  await page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem('meetingmaster.meeting.v1') || '{}');
    state.transcript = { text: 'hello world transcript' };
    state.job = { id: 'job-1', state: 'ready' };
    localStorage.setItem('meetingmaster.meeting.v1', JSON.stringify(state));
  });
  await page.reload();

  await expect(page.locator('#copy-transcript-btn')).toBeEnabled();
  await expect(page.locator('#copy-ai-prompt-btn')).toBeEnabled();
});

test('summary editor imports pasted AI JSON (with fences and chatter)', async ({ page }) => {
  // A blank meeting starts in the "setup" stage with the Generate panel
  // collapsed — expand it via its header (the manual stage override).
  await page.locator('#generate-heading').click();
  await page.locator('#edit-summary-btn').click();
  await expect(page.locator('#summary-modal')).toBeVisible();

  const pasted =
    'Sure! Here is the summary you asked for:\n```json\n' +
    JSON.stringify(AI_REPLY, null, 2) +
    '\n```\nLet me know if you need anything else.';
  await page.locator('#sum-import-text').fill(pasted);
  await page.locator('#sum-import-btn').click();

  await expect(page.locator('#sum-takeaways')).toHaveValue(
    'Q3 launch slips to November\nBudget approved'
  );
  await expect(page.locator('#sum-insights')).toHaveValue(
    'Lock the launch scope before the budget review, not after.'
  );
  await expect(page.locator('#sum-decisions')).toHaveValue('Ship the beta to internal users first');
  await expect(page.locator('#sum-topics')).toHaveValue('Launch timing\nPricing');
  // Action items: the object row and the bare-string row both land.
  await expect(page.locator('#sum-actions .action-edit-row')).toHaveCount(2);
  await expect(page.locator('#sum-import-note')).toContainText('Imported');

  // Bad paste surfaces a readable error, not a crash.
  await page.locator('#sum-import-text').fill('not json at all');
  await page.locator('#sum-import-btn').click();
  await expect(page.locator('#sum-import-note')).toContainText('No JSON object found');
});

test('combined harness reply also imports Q&A candidates for review', async ({ page }) => {
  await page.locator('#generate-heading').click(); // expand the collapsed panel
  await page.locator('#edit-summary-btn').click();
  const combined = {
    summary: { keyTakeaways: ['One takeaway'], topics: ['Pricing'] },
    questions: [
      { question: 'What is the launch date?', answer: 'November 15', answerer: 'Alice', confidence: 'high' },
      { question: 'Who owns rollout?', answer: 'Bob will drive it', answerer: '', confidence: 'high' }, // no answerer -> low
    ],
  };
  await page.locator('#sum-import-text').fill(JSON.stringify(combined));
  await page.locator('#sum-import-btn').click();

  await expect(page.locator('#sum-takeaways')).toHaveValue('One takeaway');
  await expect(page.locator('#sum-import-note')).toContainText('2 detected question(s)');

  // The Q&A review prompt (same flow the local model feeds) is now offered.
  await page.locator('#sum-cancel-btn').click();
  await expect(page.locator('#extract-review')).toBeVisible();
  await expect(page.locator('#extract-review')).toContainText('2');
});
