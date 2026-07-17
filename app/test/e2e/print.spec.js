'use strict';

// Verifies the PDF template's typography contract (the user's designv3 mock)
// against the pinned mockMeeting.json fixture: 13pt Q&A text (17.33px), 11pt
// summary (~14.67px), the medical-blue accent on the question index, a
// non-transparent accent rule (printBackground), and a real multi-kB PDF.

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

  // Q&A text renders at 13pt => ~17.3333px computed.
  const questionFontSize = await page
    .locator('.qa-card .question')
    .first()
    .evaluate((el) => getComputedStyle(el).fontSize);
  expect(questionFontSize.startsWith('17.33')).toBeTruthy();

  // Summary paragraphs render at 11pt => ~14.6667px computed.
  const summaryFontSize = await page
    .locator('#summary-body p')
    .first()
    .evaluate((el) => getComputedStyle(el).fontSize);
  expect(summaryFontSize.startsWith('14.66')).toBeTruthy();

  // The question index carries the calm medical-blue accent (#3e7ca6).
  const indexColor = await page
    .locator('.qa-card .q-index')
    .first()
    .evaluate((el) => getComputedStyle(el).color);
  expect(indexColor).toBe('rgb(62, 124, 166)');

  // The summary's accent rule must have a real (non-transparent) background —
  // this is what printBackground:true exists to preserve.
  const ruleBackground = await page
    .locator('.summary-rule')
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(ruleBackground).toBe('rgb(62, 124, 166)');

  // And the whole thing prints to a real PDF.
  const pdf = await page.pdf({ printBackground: true, format: 'Letter' });
  expect(pdf.length).toBeGreaterThan(10 * 1024);
});
