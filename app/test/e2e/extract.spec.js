'use strict';

// The AI question-review flow: candidates surface as a prompt in the Q&A panel
// and are only added to the meeting after the operator approves them (culling
// and fixing the answerer along the way). Runs against the real renderer HTML/JS
// with window.api and seeded localStorage stubbed before any page script runs.

const path = require('path');
const { pathToFileURL } = require('url');
const { test, expect } = require('@playwright/test');

const INDEX_URL = pathToFileURL(
  path.resolve(__dirname, '..', '..', 'src', 'renderer', 'index.html')
).href;

const SEED = {
  details: {
    title: 'Q3 Vendor Contract Review',
    date: '2026-07-16',
    time: '14:30',
    attendees: ['Alice Chen', 'Bob Ramirez', 'Priya Natarajan'],
  },
  cards: [],
  recipients: [],
  options: { whisperModel: 'large-v3-turbo', emailMode: 'home' },
  job: { id: 'seed-job', state: 'ready' },
  transcript: null,
  summary: null,
  extractedQuestions: [
    {
      question: 'What is the renewal price?',
      answer: 'A 12% increase locked for 24 months.',
      answerer: 'Bob Ramirez',
      directedTo: 'Bob Ramirez',
    },
    {
      question: 'Who owns integration testing?',
      answer: 'The platform team, with QA regression coverage.',
      answerer: '',
      directedTo: 'Priya Natarajan',
    },
  ],
  questionsReviewed: false,
  pdfPath: null,
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript((seed) => {
    window.api = {
      getConfig: async () => ({
        serverUrl: 'http://test',
        emailMode: 'home',
        pageSize: 'Letter',
        hasToken: true,
        configPath: '/dev/null',
      }),
      onJobProgress: () => () => {},
      getJobStatus: async () => ({ id: 'seed-job', state: 'ready', questions: [] }),
    };
    localStorage.setItem('meetingmaster.meeting.v1', JSON.stringify(seed));
  }, SEED);
  await page.goto(INDEX_URL);
});

test('review prompt adds only the approved questions, with the edited answerer', async ({ page }) => {
  const prompt = page.locator('#extract-review');
  await expect(prompt).toBeVisible();
  await expect(prompt).toContainText('2 questions');

  await page.getByRole('button', { name: 'Review & add' }).click();

  const modal = page.locator('#extract-modal');
  await expect(modal).toBeVisible();
  const rows = page.locator('.extract-row');
  await expect(rows).toHaveCount(2);
  await expect(page.locator('#extract-selected-count')).toHaveText('2 of 2 selected');

  // Cull the first question (uncheck it).
  await rows.nth(0).locator('.extract-check').uncheck();
  await expect(page.locator('#extract-selected-count')).toHaveText('1 of 2 selected');

  // Fix the answerer the model left blank on the second question.
  await rows.nth(1).locator('.extract-answerer').fill('Priya Natarajan');

  await page.locator('#extract-add-btn').click();

  await expect(modal).toBeHidden();

  // Exactly the kept question became a card, carrying the edited answerer.
  const cards = page.locator('#card-list .qa-card');
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText('Who owns integration testing?');
  await expect(cards.first()).toContainText('Priya Natarajan');

  // The prompt is gone once reviewed.
  await expect(prompt).toBeHidden();
});

test('dismiss hides the prompt without adding any cards', async ({ page }) => {
  const prompt = page.locator('#extract-review');
  await expect(prompt).toBeVisible();

  await page.getByRole('button', { name: 'Dismiss' }).click();

  await expect(prompt).toBeHidden();
  await expect(page.locator('#card-list .qa-card')).toHaveCount(0);
});
