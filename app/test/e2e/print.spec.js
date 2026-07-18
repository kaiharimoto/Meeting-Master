'use strict';

// Verifies the PDF template's contract against the pinned mockMeeting.json
// fixture: the ruled Q&A table (13pt text, medical-blue Q index) and the
// structured presentation-style summary — Key Takeaways (accent-numbered),
// Follow-Up Points, and Topics Discussed (outline accent chips) — plus a
// non-transparent accent rule (printBackground) and a real multi-kB PDF.

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

const ACCENT = 'rgb(62, 124, 166)'; // #3e7ca6 medical blue

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

  // The question index carries the calm medical-blue accent (#3e7ca6).
  const indexColor = await page
    .locator('.qa-card .q-index')
    .first()
    .evaluate((el) => getComputedStyle(el).color);
  expect(indexColor).toBe(ACCENT);

  // ---- Structured summary ----------------------------------------------------

  // Three accent section kickers: Key Takeaways, Follow-Up Points, Topics.
  const headings = page.locator('.sum-heading');
  await expect(headings).toHaveCount(3);
  await expect(headings.nth(0)).toHaveText('Key Takeaways');
  const headingColor = await headings
    .first()
    .evaluate((el) => getComputedStyle(el).color);
  expect(headingColor).toBe(ACCENT);

  // One numbered takeaway per fixture item; the first shows the "01" index.
  const takeaways = page.locator('.takeaway');
  await expect(takeaways).toHaveCount(fixture.summary.keyTakeaways.length);
  await expect(page.locator('.takeaway-num').first()).toHaveText('01');
  await expect(takeaways.first()).toContainText(
    fixture.summary.keyTakeaways[0].slice(0, 24)
  );

  // Follow-ups and topics each render their full fixture list.
  await expect(page.locator('.followup')).toHaveCount(
    fixture.summary.followUps.length
  );
  const chips = page.locator('.topic-chip');
  await expect(chips).toHaveCount(fixture.summary.topics.length);
  const chipColor = await chips.first().evaluate((el) => getComputedStyle(el).color);
  expect(chipColor).toBe(ACCENT);

  // The summary's accent rule must have a real (non-transparent) background —
  // this is what printBackground:true exists to preserve.
  const ruleBackground = await page
    .locator('.summary-rule')
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(ruleBackground).toBe(ACCENT);

  // And the whole thing prints to a real PDF.
  const pdf = await page.pdf({ printBackground: true, format: 'Letter' });
  expect(pdf.length).toBeGreaterThan(10 * 1024);
});

test('a legacy plain-string summary still renders as prose paragraphs', async ({ page }) => {
  await page.goto(PRINT_URL);
  const legacy = Object.assign({}, fixture, {
    summary: 'First paragraph of the old-style summary.\n\nSecond paragraph.',
  });
  await page.evaluate((data) => window.renderMeeting(data), legacy);

  await expect(page.locator('#summary-body.is-prose p')).toHaveCount(2);
  // The structured deck is absent for a string summary.
  await expect(page.locator('.sum-heading')).toHaveCount(0);
});
