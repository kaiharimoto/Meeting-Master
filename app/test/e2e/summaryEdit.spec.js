'use strict';

// The in-app summary editor: the operator can adjust the AI summary (takeaways,
// decisions, action items, figures, topics) before generating the PDF. Verifies
// the editor loads the current summary and round-trips edits back into state.

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
  await expect(page.locator('#sum-decisions')).toHaveValue('Approved the plan.');
  const rows = page.locator('.action-edit-row');
  await expect(rows).toHaveCount(1);
  await expect(rows.first().locator('.ae-task')).toHaveValue('Ship it');
  await expect(rows.first().locator('.ae-priority')).toHaveValue('high');

  // Edit: add a takeaway line and a second action item.
  await page.locator('#sum-takeaways').fill('First takeaway.\nSecond takeaway.\nThird takeaway.');
  await page.getByRole('button', { name: 'Add action item' }).click();
  const newRow = page.locator('.action-edit-row').nth(1);
  await newRow.locator('.ae-task').fill('Review contract');
  await newRow.locator('.ae-owner').fill('Bob');
  await page.locator('#sum-save-btn').click();
  await expect(modal).toBeHidden();

  // Reopen — the edits persisted into state and reload into the editor.
  await page.getByRole('button', { name: 'Edit summary' }).click();
  await expect(page.locator('#sum-takeaways')).toHaveValue(/Third takeaway\./);
  await expect(page.locator('.action-edit-row')).toHaveCount(2);
  await expect(page.locator('.action-edit-row').nth(1).locator('.ae-task')).toHaveValue('Review contract');
});
