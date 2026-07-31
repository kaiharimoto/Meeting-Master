'use strict';

// Direct manipulation of Q&A cards: edit in place, keyboard navigation, and
// reordering. This is the one area where a bug costs the operator real work,
// so the specs lean on the failure modes — a commit that races a re-render, an
// undo that restores to the wrong slot, an editor destroyed by an unrelated
// add.

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
    const KEY = 'meetingmaster.meeting.v1';
    if (!localStorage.getItem(KEY)) {
      localStorage.setItem(
        KEY,
        JSON.stringify({
          details: { title: 'Ordering', date: '2026-07-27', time: '11:00', attendees: [] },
          cards: [
            { id: 'a', question: 'First?', answer: 'One.', participant: '' },
            { id: 'b', question: 'Second?', answer: 'Two.', participant: '' },
            { id: 'c', question: 'Third?', answer: 'Three.', participant: '' },
          ],
        })
      );
    }
  });
  await page.setViewportSize({ width: 1280, height: 1400 });
  await page.goto(INDEX_URL);
});

const cards = (page) => page.locator('#card-list .qa-card');
const order = (page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('#card-list .qa-card')).map((el) => el.dataset.cardId)
  );
const stored = (page) =>
  page.evaluate(
    () => JSON.parse(localStorage.getItem('meetingmaster.meeting.v1')).cards.map((c) => c.id)
  );

test('clicking a question edits it in place and the edit survives a reload', async ({ page }) => {
  await cards(page).first().locator('.card-question').click();
  const editor = page.locator('.card-editor--question');
  await expect(editor).toBeFocused();
  await expect(editor).toHaveValue('First?');

  await editor.fill('First, revised?');
  await page.keyboard.press('Enter');
  await expect(editor).toHaveCount(0);
  await expect(cards(page).first()).toContainText('First, revised?');

  await page.reload();
  await expect(cards(page).first()).toContainText('First, revised?');
  // The modal was never involved, and the other cards are untouched.
  await expect(page.locator('#card-modal')).toBeHidden();
  await expect(cards(page).nth(1)).toContainText('Second?');
});

test('Escape reverts an inline edit and gives the card its focus back', async ({ page }) => {
  const card = cards(page).first();
  await card.locator('.card-answer').click();
  const editor = page.locator('.card-editor--answer');
  await editor.fill('Rewritten answer that must not survive.');
  await page.keyboard.press('Escape');

  await expect(editor).toHaveCount(0);
  await expect(card).toContainText('One.');
  await expect(card).not.toContainText('must not survive');
  await expect(card).toBeFocused();
});

test('starting something else mid-edit saves the edit rather than losing it', async ({ page }) => {
  await cards(page).nth(1).locator('.card-question').click();
  await page.locator('.card-editor--question').fill('Second, mid-edit');

  // Clicking away is the commonest way an edit ends. It must not be the way an
  // edit is lost — blur commits.
  await page.evaluate(() => {
    const input = document.getElementById('quick-question');
    input.value = 'Arrived during the edit?';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.locator('#quick-add-btn').click();

  await expect(cards(page)).toHaveCount(4);
  await expect(page.locator('.card-editor')).toHaveCount(0);
  await expect(cards(page).nth(1)).toContainText('Second, mid-edit');
  await expect(cards(page).nth(3)).toContainText('Arrived during the edit?');
  // …and the surviving card kept its element, so the list never flashed.
  expect(await stored(page)).toEqual(['a', 'b', 'c', (await order(page))[3]]);
});

test('only one card is tab-reachable; arrows move between them', async ({ page }) => {
  const tabindexes = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#card-list .qa-card')).map((el) => el.tabIndex)
  );
  expect(tabindexes).toEqual([0, -1, -1]);

  await cards(page).first().focus();
  await page.keyboard.press('ArrowDown');
  await expect(cards(page).nth(1)).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(cards(page).nth(2)).toBeFocused();
  // …and the tab stop follows the focus.
  expect(
    await page.evaluate(() =>
      Array.from(document.querySelectorAll('#card-list .qa-card')).map((el) => el.tabIndex)
    )
  ).toEqual([-1, -1, 0]);

  await page.keyboard.press('ArrowDown'); // at the end, stays put
  await expect(cards(page).nth(2)).toBeFocused();
  await page.keyboard.press('Home');
  await expect(cards(page).nth(0)).toBeFocused();
  await page.keyboard.press('End');
  await expect(cards(page).nth(2)).toBeFocused();
});

test('e edits in place, Enter opens the full dialog', async ({ page }) => {
  await cards(page).first().focus();
  await page.keyboard.press('e');
  await expect(page.locator('.card-editor--question')).toBeFocused();
  await page.keyboard.press('Escape');

  await page.keyboard.press('Enter');
  await expect(page.locator('#card-modal')).toBeVisible();
  await expect(page.locator('#card-question')).toHaveValue('First?');
});

test('Alt+arrows reorder, and Undo puts the order back', async ({ page }) => {
  await cards(page).first().focus();
  await page.keyboard.press('Alt+ArrowDown');
  expect(await order(page)).toEqual(['b', 'a', 'c']);
  expect(await stored(page)).toEqual(['b', 'a', 'c']);
  // Focus rides along with the card that moved.
  await expect(cards(page).nth(1)).toBeFocused();

  await page.locator('#toast-region button', { hasText: 'Undo' }).click();
  expect(await order(page)).toEqual(['a', 'b', 'c']);
  expect(await stored(page)).toEqual(['a', 'b', 'c']);
});

test('dragging the grip reorders the list', async ({ page }) => {
  const grip = cards(page).first().locator('.card-grip');
  await grip.scrollIntoViewIfNeeded();
  const from = await grip.boundingBox();
  const target = await cards(page).nth(2).boundingBox();

  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2, target.y + target.height, { steps: 12 });
  await page.mouse.up();

  expect(await order(page)).toEqual(['b', 'c', 'a']);
  expect(await stored(page)).toEqual(['b', 'c', 'a']);
});

test('Delete + Undo restores the card to its place even after a reorder', async ({ page }) => {
  // Delete the middle card…
  await cards(page).nth(1).focus();
  await page.keyboard.press('Delete');
  await expect(cards(page)).toHaveCount(2);
  expect(await order(page)).toEqual(['a', 'c']);

  // …then reorder what's left, so a remembered INDEX would now point at the
  // wrong slot. The undo remembers the neighbour instead.
  await cards(page).first().focus();
  await page.keyboard.press('Alt+ArrowDown');
  expect(await order(page)).toEqual(['c', 'a']);

  await page.locator('#toast-region button', { hasText: 'Undo' }).last().click();
  // The delete's Undo is still available under the move's; run it too.
  const deleteUndo = page.locator('#toast-region button', { hasText: 'Undo' });
  if (await deleteUndo.count()) await deleteUndo.first().click();

  // b is back immediately after a, where it was — not at index 1 of a list
  // that has since been shuffled.
  const ids = await order(page);
  expect(ids.indexOf('b')).toBe(ids.indexOf('a') + 1);
});

test('the card toolbar is not in the tab order', async ({ page }) => {
  const tabindexes = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#card-list .card-actions button')).map(
      (el) => el.tabIndex
    )
  );
  expect(tabindexes.length).toBe(9); // three buttons on each of three cards
  expect(tabindexes.every((t) => t === -1)).toBe(true);
});
