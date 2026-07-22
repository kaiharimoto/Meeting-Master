'use strict';

// Manual-email fallback (copy Subject/Recipients/Body) and the fix-names
// interface (correct + merge misspelled names across the whole meeting).

const path = require('path');
const { pathToFileURL } = require('url');
const { test, expect } = require('@playwright/test');

const INDEX_URL = pathToFileURL(
  path.resolve(__dirname, '..', '..', 'src', 'renderer', 'index.html')
).href;

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    // Meeting with one person spelled three ways (the field report case).
    const state = {
      meetingId: 'm-test',
      details: { title: 'Budget Sync', date: '2026-07-22', time: '10:00', attendees: ['Kai', 'Ky', 'Alice'] },
      cards: [
        { id: 'c1', question: 'Q1?', answer: 'A1', participant: 'Kye' },
        { id: 'c2', question: 'Q2?', answer: 'A2', participant: 'Alice' },
      ],
      extractedQuestions: [
        { question: 'Qx?', answer: 'Ax', answerer: 'Ky', directedTo: 'Kai', confidence: 'high' },
      ],
      summary: { keyTakeaways: [], decisions: [], keyFigures: [], topics: [],
                 actionItems: [{ task: 'Do it', owner: 'Kye', due: '', priority: 'normal' }] },
      job: { id: 'job-1', state: 'ready' },
      questionsReviewed: true,
    };
    localStorage.setItem('meetingmaster.meeting.v1', JSON.stringify(state));
    window.api = {
      getConfig: async () => ({
        serverUrl: 'http://test', emailMode: 'home', pageSize: 'Letter',
        hasToken: true, configPath: '/dev/null',
      }),
      onJobProgress: () => () => {},
      getEmailPreview: async () => ({
        subject: 'Meeting Notes — Budget Sync (2026-07-22)',
        recipients: ['a@example.com', 'b@example.com'],
        body: 'Hello,\n\nAttached are the meeting notes.',
      }),
    };
  });
  await page.goto(INDEX_URL);
});

test('email text modal shows exact subject/recipients/body', async ({ page }) => {
  await expect(page.locator('#email-text-btn')).toBeEnabled();
  await page.locator('#email-text-btn').click();
  await expect(page.locator('#email-modal')).toBeVisible();
  await expect(page.locator('#em-recipients')).toHaveValue('a@example.com, b@example.com');
  await expect(page.locator('#em-subject')).toHaveValue('Meeting Notes — Budget Sync (2026-07-22)');
  await expect(page.locator('#em-body')).toHaveValue(/Attached are the meeting notes/);
  await page.locator('#em-close').click();
  await expect(page.locator('#email-modal')).toBeHidden();
});

test('fix names merges three spellings into one person everywhere', async ({ page }) => {
  await page.locator('#fix-names-btn').click();
  await expect(page.locator('#names-modal')).toBeVisible();
  // Distinct names collected across attendees/cards/questions/owners.
  const inputs = page.locator('#names-rows input');
  await expect(inputs).toHaveCount(4); // Kai, Ky, Alice, Kye

  // Merge all three variants into "Kai".
  for (const wrong of ['Ky', 'Kye']) {
    await page.locator(`#names-rows input[data-original="${wrong}"]`).fill('Kai');
  }
  await page.locator('#names-apply-btn').click();
  await expect(page.locator('#names-modal')).toBeHidden();

  const state = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('meetingmaster.meeting.v1'))
  );
  expect(state.details.attendees).toEqual(['Kai', 'Alice']); // deduped
  expect(state.cards.map((c) => c.participant)).toEqual(['Kai', 'Alice']);
  expect(state.extractedQuestions[0].answerer).toBe('Kai');
  expect(state.extractedQuestions[0].directedTo).toBe('Kai');
  expect(state.summary.actionItems[0].owner).toBe('Kai');
});
