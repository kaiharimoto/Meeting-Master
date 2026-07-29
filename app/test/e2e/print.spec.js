'use strict';

// Verifies the PDF template's contract against the pinned mockMeeting.json
// fixture: the ruled Q&A table (13pt text, medical-blue Q index) and the
// structured presentation-style summary — Key Takeaways (accent-numbered), Key
// Insights (arrow markers), Decisions, Action Items, Key Figures, and Topics
// Discussed (outline accent chips) — plus a non-transparent accent rule
// (printBackground) and a real
// multi-kB PDF. The documented nine-step type scale is asserted against the
// computed sizes, and a long fixture exercises pagination.
//
// (This header used to describe a "Follow-Up Points" section that the template
// had already stopped rendering — copied verbatim from print.css's header,
// which had the same rot.)

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

// The preview's page geometry, straight from the module the main process uses.
const { pageChromeCss, MARGIN_IN, PAPER_IN } = require('../../src/main/printChrome');

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

  // ---- Contents index (page 1) -----------------------------------------------
  await expect(page.locator('#contents')).toBeVisible();
  // Q&A + the six populated summary sections = seven rows.
  await expect(page.locator('.toc-row')).toHaveCount(7);
  await expect(page.locator('.toc-name').nth(2)).toHaveText('Key Insights');

  // ---- Structured summary deck -----------------------------------------------

  // Six accent section kickers: Takeaways, Insights, Decisions, Action Items,
  // Figures, Topics.
  const headings = page.locator('.sum-heading');
  await expect(headings).toHaveCount(6);
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

  // Key Insights: its own section, right after the takeaways it must not be
  // confused with, and glossed on the page so a reader who has never seen the
  // app knows what separates the two.
  await expect(headings.nth(1)).toContainText('Key Insights');
  await expect(page.locator('.sum-insights .sum-heading-note')).toHaveText(
    'to apply going forward'
  );
  const insights = page.locator('.insight');
  await expect(insights).toHaveCount(fixture.summary.keyInsights.length);
  await expect(insights.first()).toContainText(fixture.summary.keyInsights[0].slice(0, 24));
  // The forward-pointing arrow marker is a character, not a colour, so it
  // survives a grayscale print.
  const marker = await insights.first().evaluate((el) =>
    getComputedStyle(el, '::before').content
  );
  expect(marker).toContain('→');
  // Insights are NOT a reworded copy of the takeaways.
  const takeawayTexts = await page.locator('.takeaway-text').allTextContents();
  const insightTexts = await page.locator('.insight-text').allTextContents();
  expect(insightTexts.some((i) => takeawayTexts.includes(i))).toBe(false);

  // Decisions render their full list.
  await expect(page.locator('.decision')).toHaveCount(fixture.summary.decisions.length);

  // Action Items: one table row per item, with priority-dot classes.
  await expect(page.locator('.ai-task')).toHaveCount(fixture.summary.actionItems.length);
  await expect(page.locator('.ai-pri-high')).toHaveCount(
    // fixture priority dots include the table body + the legend swatch.
    fixture.summary.actionItems.filter((a) => a.priority === 'high').length + 1
  );

  // Key figures and topics each render their full fixture list.
  await expect(page.locator('.figure')).toHaveCount(fixture.summary.keyFigures.length);
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

test('the documented type scale is the type scale that renders', async ({ page }) => {
  await page.goto(PRINT_URL);
  await page.evaluate((data) => window.renderMeeting(data), fixture);

  // print.css's header comment lists nine steps. Every one of them, checked —
  // a scale documented in a comment and nowhere else drifts within a release.
  const EXPECTED_PT = [
    ['#detail-title', 42],
    ['.q-index', 22],
    ['#qa .section-header', 20],
    ['.summary-header', 20],
    ['.takeaway-num', 18],
    ['.question', 13],
    ['.answer', 13],
    ['.detail-value', 12],
    ['.takeaway-text', 12],
    ['.decision-text', 12],
    ['.insight-text', 12],
    ['.ai-task', 11],
    ['.figure-text', 11],
    ['.colophon-title', 11],
    ['.toc-name', 10.5],
    ['.ai-owner', 10.5],
    ['.detail-label', 9.5],
    ['.contents-head', 9.5],
    ['.sum-heading', 9.5],
    ['.ai-head span', 9.5],
    ['.topic-chip', 9.5],
    ['.participant-chip', 9.5],
  ];

  for (const [selector, pt] of EXPECTED_PT) {
    const px = await page
      .locator(selector)
      .first()
      .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    // 1pt = 4/3 px at the print template's 96dpi baseline.
    expect(Math.abs(px - (pt * 4) / 3), `${selector} should be ${pt}pt`).toBeLessThan(0.1);
  }

  // Every size in the stylesheet is one of the nine documented steps.
  const sizes = await page.evaluate(() => {
    const seen = new Set();
    document.querySelectorAll('#details *, #contents *, #qa *, #summary *').forEach((el) => {
      if (el.textContent.trim()) seen.add(parseFloat(getComputedStyle(el).fontSize).toFixed(2));
    });
    return Array.from(seen);
  });
  const allowed = [42, 22, 20, 18, 13, 12, 11, 10.5, 9.5].map((pt) =>
    ((pt * 4) / 3).toFixed(2)
  );
  expect(sizes.filter((s) => !allowed.includes(s))).toEqual([]);
});

test('a long meeting paginates without emptying a section or breaking the grid', async ({
  page,
}) => {
  await page.goto(PRINT_URL);

  // Sixteen cards plus a full summary — enough to run past one page, which is
  // the only way pagination bugs show up at all.
  const long = JSON.parse(JSON.stringify(fixture));
  long.cards = Array.from({ length: 16 }, (_, i) => ({
    id: `c${i}`,
    question: `Question ${i + 1}: what happens when the text is long enough to wrap onto a second line?`,
    answer:
      'An answer that also runs long, because a single-line fixture never ' +
      'exercises the leading, the row rule, or the page break that a real ' +
      'meeting produces on the second and third pages.',
    participant: i % 3 === 0 ? 'Bob Ramirez' : '',
  }));
  await page.evaluate((data) => window.renderMeeting(data), long);

  await expect(page.locator('.qa-card')).toHaveCount(16);
  await expect(page.locator('#contents')).toBeVisible();

  // The three-column Q&A grid holds on every row, not just the first.
  const columnCounts = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.qa-card')).map(
      (el) => getComputedStyle(el).gridTemplateColumns.split(' ').length
    )
  );
  expect(new Set(columnCounts).size).toBe(1);
  expect(columnCounts[0]).toBe(3);

  // Rows are evenly padded, so the rule between two rows sits midway.
  const [top, bottom] = await page
    .locator('.qa-card')
    .first()
    .evaluate((el) => {
      const s = getComputedStyle(el);
      return [parseFloat(s.paddingTop), parseFloat(s.paddingBottom)];
    });
  expect(Math.abs(top - bottom)).toBeLessThan(0.5);

  // No section renders its heading with nothing under it.
  const emptySections = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.sum-section'))
      .filter((el) => el.querySelectorAll('li, .ai-row').length === 0)
      .map((el) => el.className)
  );
  expect(emptySections).toEqual([]);

  const pdf = await page.pdf({ printBackground: true, format: 'Letter' });
  expect(pdf.length).toBeGreaterThan(20 * 1024);
});

// The preview window is a real BrowserWindow, which Playwright can't open —
// but its page geometry is just CSS, and that is the part that can lie. Here
// it's injected into the same print.html and measured.
test('the preview draws the same page the PDF prints', async ({ page }) => {
  await page.goto(PRINT_URL);
  await page.addStyleTag({ content: pageChromeCss('Letter') });
  await page.evaluate((data) => window.renderMeeting(data), fixture);

  const box = await page.evaluate(() => {
    const s = getComputedStyle(document.body);
    const px = (v) => parseFloat(v);
    return {
      // The border box — the sheet of paper, margins included.
      width: document.body.getBoundingClientRect().width,
      top: px(s.paddingTop),
      right: px(s.paddingRight),
      bottom: px(s.paddingBottom),
      left: px(s.paddingLeft),
    };
  });

  const inches = (v) => v / 96; // print.html's CSS-inch baseline
  expect(inches(box.width)).toBeCloseTo(PAPER_IN.Letter.width, 2);
  expect(inches(box.top)).toBeCloseTo(MARGIN_IN.top, 2);
  expect(inches(box.right)).toBeCloseTo(MARGIN_IN.right, 2);
  expect(inches(box.bottom)).toBeCloseTo(MARGIN_IN.bottom, 2);
  expect(inches(box.left)).toBeCloseTo(MARGIN_IN.left, 2);

  // A4 gets A4 paper, not Letter with a different name.
  await page.addStyleTag({ content: pageChromeCss('A4') });
  const a4 = await page.evaluate(() => document.body.getBoundingClientRect().width);
  expect(inches(a4)).toBeCloseTo(PAPER_IN.A4.width, 2);
});
