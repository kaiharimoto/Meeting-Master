'use strict';

// Verifies the PDF template's typography contract against the pinned
// mockMeeting.json fixture: 24pt questions (32px), 16pt summary (~21.33px),
// non-transparent answer cards, and a real multi-kB PDF via page.pdf().

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { test, expect } = require('@playwright/test');

const PRINT_URL = pathToFileURL(
  path.resolve(__dirname, '..', '..', 'src', 'renderer', 'print', 'print.html')
).href;

const fixture = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '..', 'fixtures', 'mockMeeting.json'), 'utf8')
);

test('print template renders the fixture with the contracted typography', async ({ page }) => {
  await page.goto(PRINT_URL);
  await page.evaluate((data) => window.renderMeeting(data), fixture);

  // Details header carries the meeting title.
  await expect(page.locator('#details')).toContainText(fixture.details.title);

  // Questions render at 24pt => exactly 32px computed.
  const questionFontSize = await page
    .locator('.qa-card .question')
    .first()
    .evaluate((el) => getComputedStyle(el).fontSize);
  expect(questionFontSize).toBe('32px');

  // Summary paragraphs render at 16pt => ~21.3333px computed.
  const summaryFontSize = await page
    .locator('#summary-body p')
    .first()
    .evaluate((el) => getComputedStyle(el).fontSize);
  expect(summaryFontSize.startsWith('21.33')).toBeTruthy();

  // The answer card must have a real (non-transparent) background — this is
  // what printBackground:true exists to preserve.
  const answerBackground = await page
    .locator('.qa-card .answer')
    .first()
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(answerBackground).not.toBe('rgba(0, 0, 0, 0)');
  expect(answerBackground).not.toBe('transparent');

  // And the whole thing prints to a real PDF.
  const pdf = await page.pdf({ printBackground: true, format: 'Letter' });
  expect(pdf.length).toBeGreaterThan(10 * 1024);
});
