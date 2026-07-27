'use strict';

// Keyboard capture flow, exercised in plain Chromium against the real
// renderer HTML/JS. window.api (normally provided by the Electron preload)
// is stubbed before any page script runs.

const path = require('path');
const { pathToFileURL } = require('url');
const { test, expect } = require('@playwright/test');

const INDEX_URL = pathToFileURL(
  path.resolve(__dirname, '..', '..', 'src', 'renderer', 'index.html')
).href;

test.beforeEach(async ({ page }) => {
  // Minimal window.api stub matching the preload contract.
  await page.addInitScript(() => {
    window.api = {
      getConfig: async () => ({
        serverUrl: 'http://test',
        emailMode: 'home',
        pageSize: 'Letter',
        hasToken: true,
        configPath: '/dev/null',
      }),
      onJobProgress: () => () => {},
      uploadMeeting: async () => ({ jobId: 'stub-job' }),
      getJobStatus: async () => ({
        id: 'stub-job',
        state: 'queued',
        transcript: null,
        summary: null,
        pdf: { received: false, emailed: false },
        error: null,
      }),
      renderPdf: async () => ({ pdfPath: '/tmp/stub.pdf', fontUsed: true, warning: null }),
      openPdf: async () => ({ ok: true }),
      sendPdfViaHome: async () => ({ ok: true, emailed: true, error: null }),
      sendPdfViaLaptop: async () => ({ ok: true, error: null }),
      pickWavFile: async () => ({ filePath: null }),
      pickSavePath: async () => ({ filePath: null }),
    };
  });
  await page.goto(INDEX_URL);
});

test('Q opens the modal; capture, commit, and edit a card with the keyboard', async ({ page }) => {
  const modal = page.locator('#card-modal');
  const question = page.locator('#card-question');
  const answer = page.locator('#card-answer');
  const participant = page.locator('#card-participant');
  const cards = page.locator('#card-list .qa-card');

  // Press Q with focus on the page body -> modal opens focused on question.
  await page.keyboard.press('q');
  await expect(modal).toBeVisible();
  await expect(question).toBeFocused();

  // Question -> Tab -> Answer -> Tab -> Participant -> Enter commits.
  await page.keyboard.type('What is the renewal price?');
  await page.keyboard.press('Tab');
  await expect(answer).toBeFocused();
  await page.keyboard.type('A 12% increase locked for 24 months.');
  await page.keyboard.press('Tab');
  await expect(participant).toBeFocused();
  await page.keyboard.type('Bob Ramirez');
  await page.keyboard.press('Enter');

  await expect(modal).toBeHidden();
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText('What is the renewal price?');
  await expect(cards.first()).toContainText('A 12% increase locked for 24 months.');
  await expect(cards.first()).toContainText('Bob Ramirez');

  // Clicking the card reopens the modal prefilled (edit mode).
  await cards.first().locator('.card-question').click();
  await expect(modal).toBeVisible();
  await expect(question).toHaveValue('What is the renewal price?');
  await expect(answer).toHaveValue('A 12% increase locked for 24 months.');
  await expect(participant).toHaveValue('Bob Ramirez');

  // Change the answer, Enter -> still exactly one card, with the new text.
  await answer.fill('A 12% increase, locked for 24 months, no mid-term adjustments.');
  await page.keyboard.press('Enter');
  await expect(modal).toBeHidden();
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText(
    'A 12% increase, locked for 24 months, no mid-term adjustments.'
  );
});

test('focus is trapped in the modal and Enter on Cancel discards the card', async ({ page }) => {
  const modal = page.locator('#card-modal');
  const question = page.locator('#card-question');
  const cancel = page.locator('#card-cancel-btn');
  const saveAdd = page.locator('#card-save-add-btn');
  const save = page.locator('#card-save-btn');
  const cards = page.locator('#card-list .qa-card');

  await page.keyboard.press('q');
  await expect(modal).toBeVisible();
  await page.keyboard.type('Should this card exist?');

  // Tab past the participant field must reach the modal buttons, never the
  // page behind the backdrop — and wrap back to the question field. The cycle
  // is pure DOM order now: the positive tabindexes are gone.
  await page.keyboard.press('Tab'); // -> answer
  await page.keyboard.press('Tab'); // -> participant
  await page.keyboard.press('Tab');
  await expect(cancel).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(saveAdd).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(save).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(question).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(save).toBeFocused();

  // Enter on the focused Cancel button cancels — it must NOT save the card.
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Shift+Tab');
  await expect(cancel).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(modal).toBeHidden();
  await expect(cards).toHaveCount(0);
});

test('Save and add another keeps the modal open and the answerer', async ({ page }) => {
  const modal = page.locator('#card-modal');
  const question = page.locator('#card-question');
  const answer = page.locator('#card-answer');
  const participant = page.locator('#card-participant');
  const cards = page.locator('#card-list .qa-card');

  await page.keyboard.press('q');
  await question.fill('First question?');
  await answer.fill('First answer.');
  await participant.fill('Dana Lee');

  // Ctrl+Enter commits without closing; the answerer survives for the run.
  await page.keyboard.press('Control+Enter');
  await expect(modal).toBeVisible();
  await expect(cards).toHaveCount(1);
  await expect(question).toBeFocused();
  await expect(question).toHaveValue('');
  await expect(answer).toHaveValue('');
  await expect(participant).toHaveValue('Dana Lee');

  // The button does the same thing.
  await question.fill('Second question?');
  await page.locator('#card-save-add-btn').click();
  await expect(modal).toBeVisible();
  await expect(cards).toHaveCount(2);

  // Plain Enter still commits AND closes.
  await question.fill('Third question?');
  await page.keyboard.press('Enter');
  await expect(modal).toBeHidden();
  await expect(cards).toHaveCount(3);
  await expect(cards.nth(2)).toContainText('Third question?');
  await expect(cards.nth(2)).toContainText('Dana Lee');
});

test('editing an existing card has no "add another" — and Escape restores focus', async ({
  page,
}) => {
  const cards = page.locator('#card-list .qa-card');

  await page.keyboard.press('q');
  await page.locator('#card-question').fill('Only question?');
  await page.keyboard.press('Enter');
  await expect(cards).toHaveCount(1);

  // Open the card for editing from the card itself.
  await cards.first().locator('.card-question').click();
  await expect(page.locator('#card-modal')).toBeVisible();
  await expect(page.locator('#card-save-add-btn')).toBeHidden();

  // Escape puts focus back on the card that opened the dialog — before this,
  // closing any dialog dropped focus at the top of the document.
  await page.keyboard.press('Escape');
  await expect(page.locator('#card-modal')).toBeHidden();
  await expect(cards.first()).toBeFocused();
});

test("typing 'q' inside the meeting-title input does NOT open the modal", async ({ page }) => {
  const title = page.locator('#meeting-title-input');
  const modal = page.locator('#card-modal');

  await title.click();
  await page.keyboard.type('Quarterly review');

  await expect(modal).toBeHidden();
  await expect(title).toHaveValue('Quarterly review');
});
