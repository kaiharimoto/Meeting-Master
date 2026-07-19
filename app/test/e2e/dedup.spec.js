'use strict';

// AI-extracted questions that duplicate a card the operator already typed are
// dropped when captured from a poll — verified through the real polling path
// (seed a running job, stub getJobStatus to return 'ready' with candidates).

const path = require('path');
const { pathToFileURL } = require('url');
const { test, expect } = require('@playwright/test');

const INDEX_URL = pathToFileURL(
  path.resolve(__dirname, '..', '..', 'src', 'renderer', 'index.html')
).href;

const SEED = {
  details: { title: 'Dedup Meeting', date: '2026-07-16', time: '10:00', attendees: ['Alice'] },
  // The operator already captured this question by hand during the meeting.
  cards: [{ id: 'c1', question: 'What is the renewal price?', answer: '12%', participant: 'Bob' }],
  recipients: [],
  options: { whisperModel: 'large-v3-turbo', emailMode: 'home' },
  // A running job so the app resumes polling on boot.
  job: { id: 'dedup-job', state: 'transcribing' },
  transcript: null,
  summary: null,
  extractedQuestions: [],
  questionsReviewed: false,
  pdfPath: null,
};

// The server returns two candidates: one duplicates the existing card
// (near-identical wording), one is new.
const READY_JOB = {
  id: 'dedup-job',
  state: 'ready',
  questions: [
    { question: 'What is the renewal price for the term?', answer: '12%', answerer: 'Bob', confidence: 'high' },
    { question: 'When is the migration deadline?', answer: 'Nov 15', answerer: 'Priya', confidence: 'high' },
  ],
};

test('a candidate duplicating an existing card is dropped', async ({ page }) => {
  await page.addInitScript((seed) => {
    window.api = {
      getConfig: async () => ({ serverUrl: 'http://test', emailMode: 'home', pageSize: 'Letter', hasToken: true, configPath: '/dev/null' }),
      onJobProgress: () => () => {},
      getJobStatus: async () => window.__READY_JOB,
    };
    localStorage.setItem('meetingmaster.meeting.v1', JSON.stringify(seed));
  }, SEED);
  await page.addInitScript((ready) => { window.__READY_JOB = ready; }, READY_JOB);
  await page.goto(INDEX_URL);

  // Only the non-duplicate candidate survives; the prompt reports one question.
  const prompt = page.locator('#extract-review');
  await expect(prompt).toBeVisible();
  await expect(prompt).toContainText('1 question');

  await page.getByRole('button', { name: 'Review & add' }).click();
  const rows = page.locator('.extract-row');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('When is the migration deadline?');
});
