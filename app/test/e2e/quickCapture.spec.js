'use strict';

// The inline quick-capture bar. Its whole reason to exist is that focus never
// leaves it, so a run of questions is one continuous action — that, and the
// keyed render underneath it, are what these specs pin down.

const path = require('path');
const { pathToFileURL } = require('url');
const { test, expect } = require('@playwright/test');

const INDEX_URL = pathToFileURL(
  path.resolve(__dirname, '..', '..', 'src', 'renderer', 'index.html')
).href;

test.beforeEach(async ({ page }) => {
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
      getJobStatus: async () => ({ id: 'stub-job', state: 'queued' }),
      renderPdf: async () => ({ pdfPath: '/tmp/x.pdf', fontUsed: true, warning: null }),
      openPdf: async () => ({ ok: true }),
      sendPdfViaHome: async () => ({ ok: true, emailed: true, error: null }),
      sendPdfViaLaptop: async () => ({ ok: true, error: null }),
      pickWavFile: async () => ({ filePath: null }),
      pickSavePath: async () => ({ filePath: null }),
    };
  });
  await page.goto(INDEX_URL);
});

test('three consecutive adds never move focus out of the bar', async ({ page }) => {
  const input = page.locator('#quick-question');
  const cards = page.locator('#card-list .qa-card');

  await input.click();
  for (const q of ['What is the renewal price?', 'When does migration finish?', 'Who signs off?']) {
    await page.keyboard.type(q);
    await page.keyboard.press('Enter');
    await expect(input).toBeFocused();
    await expect(input).toHaveValue('');
  }

  await expect(cards).toHaveCount(3);
  await expect(cards.nth(0)).toContainText('What is the renewal price?');
  await expect(cards.nth(2)).toContainText('Who signs off?');
  // The modal was never involved.
  await expect(page.locator('#card-modal')).toBeHidden();
});

test('an empty question is refused without adding a card', async ({ page }) => {
  const input = page.locator('#quick-question');
  await input.click();
  await page.keyboard.press('Enter');
  await expect(page.locator('#card-list .qa-card')).toHaveCount(0);
  await expect(input).toHaveClass(/field-invalid/);
  await expect(input).toBeFocused();

  // Typing clears the invalid state.
  await page.keyboard.type('A real question?');
  await expect(input).not.toHaveClass(/field-invalid/);
});

test('"More fields…" hands the half-typed question to the modal', async ({ page }) => {
  const input = page.locator('#quick-question');
  await input.click();
  await page.keyboard.type('Needs an answerer too?');
  await page.locator('#quick-more-btn').click();

  await expect(page.locator('#card-modal')).toBeVisible();
  await expect(page.locator('#card-question')).toHaveValue('Needs an answerer too?');
  await expect(page.locator('#card-question')).toBeFocused();
  // The bar handed its text over rather than keeping a stale copy.
  await expect(input).toHaveValue('');

  await page.locator('#card-participant').fill('Bob Ramirez');
  await page.keyboard.press('Enter');
  await expect(page.locator('#card-list .qa-card')).toHaveCount(1);
  await expect(page.locator('#card-list .qa-card').first()).toContainText('Bob Ramirez');
});

test('the render is keyed: adding a card leaves the existing elements alone', async ({ page }) => {
  const input = page.locator('#quick-question');
  await input.click();
  await page.keyboard.type('First?');
  await page.keyboard.press('Enter');

  // Tag the live element. A full replaceChildren() rebuild would discard it.
  await page.evaluate(() => {
    document.querySelector('#card-list .qa-card').dataset.witness = 'kept';
  });

  await page.keyboard.type('Second?');
  await page.keyboard.press('Enter');

  const cards = page.locator('#card-list .qa-card');
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0)).toHaveAttribute('data-witness', 'kept');
  await expect(cards.nth(1)).not.toHaveAttribute('data-witness', 'kept');
});

test('editing a card through the modal updates its element in place', async ({ page }) => {
  await page.locator('#quick-question').click();
  await page.keyboard.type('Original question?');
  await page.keyboard.press('Enter');

  await page.evaluate(() => {
    document.querySelector('#card-list .qa-card').dataset.witness = 'kept';
  });

  const card = page.locator('#card-list .qa-card').first();
  await card.locator('.card-question').click();
  await page.locator('#card-question').fill('Rewritten question?');
  await page.locator('#card-answer').fill('And now it has an answer.');
  await page.keyboard.press('Enter');

  await expect(card).toHaveAttribute('data-witness', 'kept');
  await expect(card).toContainText('Rewritten question?');
  // The answer slot appears without rebuilding the card…
  await expect(card).toContainText('And now it has an answer.');
  // …and the delete button stays last so the layout is unchanged.
  await expect(card.locator(':scope > *').last()).toHaveClass(/card-delete/);
});

test('the bar hides with the panel body when the Q&A panel collapses', async ({ page }) => {
  await expect(page.locator('#quick-capture')).toBeVisible();
  await page.locator('#qa-heading .panel-toggle').click();
  await expect(page.locator('#panel-qa')).toHaveClass(/is-collapsed/);
  await expect(page.locator('#quick-capture')).toBeHidden();
});
