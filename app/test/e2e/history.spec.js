'use strict';

// Meeting history: save the current meeting, then reopen it later. Verifies the
// save-current + open round-trip and that opening restores the meeting details.

const path = require('path');
const { pathToFileURL } = require('url');
const { test, expect } = require('@playwright/test');

const INDEX_URL = pathToFileURL(
  path.resolve(__dirname, '..', '..', 'src', 'renderer', 'index.html')
).href;

const SEED = {
  meetingId: 'meeting-A',
  details: { title: 'Alpha Review', date: '2026-07-16', time: '10:00', attendees: ['Alice'] },
  cards: [{ id: 'c1', question: 'Q1?', answer: 'A1', participant: 'Alice' }],
  recipients: [],
  options: { whisperModel: 'large-v3-turbo', emailMode: 'home' },
  job: { id: null, state: null },
  transcript: null,
  summary: null,
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

test('save the current meeting to history and reopen it', async ({ page }) => {
  // Save the seeded meeting to history.
  await page.getByRole('button', { name: 'History' }).click();
  const modal = page.locator('#history-modal');
  await expect(modal).toBeVisible();
  await page.getByRole('button', { name: 'Save current' }).click();

  const row = page.locator('.history-row');
  await expect(row).toHaveCount(1);
  await expect(row.first()).toContainText('Alpha Review');
  await expect(row.first()).toContainText('1 question');

  // Close, start a fresh meeting (auto-saves nothing new since title is blank),
  // then confirm the title field cleared.
  await page.locator('#history-close-btn').click();
  page.on('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'New meeting' }).click();
  await expect(page.locator('#meeting-title-input')).toHaveValue('');

  // Reopen the saved meeting from history — details restore.
  await page.getByRole('button', { name: 'History' }).click();
  await expect(page.locator('.history-row')).toHaveCount(1);
  await page.locator('.history-row').first().getByRole('button', { name: 'Open' }).click();
  await expect(modal).toBeHidden();
  await expect(page.locator('#meeting-title-input')).toHaveValue('Alpha Review');
  await expect(page.locator('#card-list .qa-card')).toHaveCount(1);
});
