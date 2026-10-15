'use strict';

// Offline finish (v0.23.0): load a transcript file made off the home server,
// build the external-AI prompt locally, and never let imported questions
// silently miss the PDF.

const path = require('path');
const { pathToFileURL } = require('url');
const { test, expect } = require('@playwright/test');

const INDEX_URL = pathToFileURL(
  path.resolve(__dirname, '..', '..', 'src', 'renderer', 'index.html')
).href;

const SRT = `1
00:00:00,000 --> 00:00:04,500
Okay, good morning, everyone.

2
00:00:04,500 --> 00:00:09,000
Steve, what is the denial trend?
`;

function install(srt) {
  window.__copied = null;
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (text) => { window.__copied = text; } },
  });
  window.api = {
    getConfig: async () => ({
      serverUrl: 'http://test', emailMode: 'home', pageSize: 'Letter',
      hasToken: true, configPath: '/dev/null',
    }),
    onJobProgress: () => () => {},
    saveTextFile: async () => ({ ok: true }),
    openTranscriptFile: async () => ({ filePath: 'C:\\Users\\me\\meeting.srt', text: srt }),
    // A home server that is down: anything that reaches it fails.
    getJobPrompt: async () => { throw new Error('connect ETIMEDOUT'); },
    renderPdf: async () => { window.__rendered = true; return { pdfPath: '/tmp/x.pdf', fontUsed: true }; },
  };
}

const seed = (page, patch) =>
  page.evaluate((p) => {
    const state = JSON.parse(localStorage.getItem('meetingmaster.meeting.v1') || '{}');
    Object.assign(state, p);
    localStorage.setItem('meetingmaster.meeting.v1', JSON.stringify(state));
  }, patch);

test.beforeEach(async ({ page }) => {
  await page.addInitScript(install, SRT);
  await page.goto(INDEX_URL);
});

test('load a transcript file, then copy a locally built AI prompt', async ({ page }) => {
  await page.locator('#generate-heading').click(); // collapsed in the setup stage
  await expect(page.locator('#copy-ai-prompt-btn')).toBeDisabled();
  await page.locator('#load-transcript-btn').click();
  await expect(page.locator('#status-text')).toContainText('Transcript loaded from meeting.srt');
  await expect(page.locator('#names-modal')).toBeVisible(); // Fix names opens for review
  await page.locator('#names-cancel-btn').click();

  const state = await page.evaluate(() => JSON.parse(localStorage.getItem('meetingmaster.meeting.v1')));
  expect(state.transcript.text).toBe('Okay, good morning, everyone. Steve, what is the denial trend?');
  expect(state.transcript.segments).toHaveLength(2);
  expect(state.transcript.segments[1].start).toBe(4.5);
  expect(state.job.id).toBeNull();

  await expect(page.locator('#copy-ai-prompt-btn')).toBeEnabled();
  await expect(page.locator('#save-ai-prompt-btn')).toBeEnabled();
  await page.locator('#copy-ai-prompt-btn').click();
  await expect(page.locator('#status-text')).toContainText('AI prompt copied');
  const clip = await page.evaluate(() => window.__copied);
  expect(clip).toContain('=== INSTRUCTIONS (system prompt)');
  expect(clip).toContain('keyInsights');
  expect(clip).toContain('Steve, what is the denial trend?');
  expect(clip).not.toContain('{{MM_');
});

test('Copy AI prompt falls back to a local build when the server is unreachable', async ({ page }) => {
  await seed(page, { transcript: { text: 'server transcript text' }, job: { id: 'job-1', state: 'ready' } });
  await page.reload();
  await page.locator('#copy-ai-prompt-btn').click();
  await expect(page.locator('#status-text')).toContainText('AI prompt copied');
  expect(await page.evaluate(() => window.__copied)).toContain('server transcript text');
});

test('imported questions open the Q&A panel and are never summarised as "none"', async ({ page }) => {
  await seed(page, { transcript: { text: 't' } }); // review stage
  await page.reload();
  // The operator had collapsed the Q&A panel.
  await page.locator('#qa-heading').click();
  await expect(page.locator('#panel-qa')).toHaveClass(/is-collapsed/);

  await page.locator('#edit-summary-btn').click();
  await page.locator('#sum-import-text').fill(JSON.stringify({
    summary: { keyTakeaways: ['a'] },
    questions: [
      { question: 'Is the data by receipt date?', answer: 'Yes.', answerer: '', directedTo: '', confidence: 'low' },
      { question: 'How long until denials settle?', answer: 'Six months.', answerer: 'Steve', directedTo: '', confidence: 'low' },
    ],
  }));
  await page.locator('#sum-import-btn').click();
  await expect(page.locator('#sum-import-note')).toContainText('2 detected question(s) await review');
  await page.locator('#sum-save-btn').click();

  await expect(page.locator('#panel-qa')).not.toHaveClass(/is-collapsed/);
  await expect(page.locator('#extract-review')).toContainText('Review & add');
  // Collapsed again, the summary line counts the pending list.
  await page.locator('#qa-heading').click();
  await expect(page.locator('#panel-qa .panel-summary')).toHaveText(
    '2 detected questions to review — open to add them'
  );
});

test('Generate PDF offers the review before printing without the questions', async ({ page }) => {
  await seed(page, {
    transcript: { text: 't' },
    extractedQuestions: [{ question: 'Is it based on receipt date?', answer: 'Yes.', answerer: '', directedTo: '', confidence: 'low' }],
    questionsReviewed: false,
  });
  await page.reload();
  page.once('dialog', (d) => d.accept());
  await page.locator('#generate-pdf-btn').click();
  await expect(page.locator('#extract-modal')).toBeVisible();
  expect(await page.evaluate(() => window.__rendered || false)).toBe(false);
  await page.locator('#extract-add-btn').click();
  await expect(page.locator('#card-list')).toContainText('Is it based on receipt date?');

  // Nothing pending any more: Generate PDF renders straight away.
  await page.locator('#generate-pdf-btn').click();
  await expect.poll(() => page.evaluate(() => window.__rendered || false)).toBe(true);
});

test('parses whisper.cpp JSON, VTT, console lines and plain text', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { parseTranscriptFile } = await import('./js/localTranscript.js');
    const json = JSON.stringify({ transcription: [
      { offsets: { from: 0, to: 1500 }, text: ' Hello there.' },
      { offsets: { from: 1500, to: 3000 }, text: ' General Kenobi.' },
    ] });
    const vtt = 'WEBVTT\n\n00:01.000 --> 00:02.000\n<v Kai>Hi all.\n\n00:02.000 --> 00:03.000\nStart.\n';
    const cons = '[00:00:00.000 --> 00:00:02.000]  First.\n[00:00:02.000 --> 00:00:04.000]  Second.\n';
    const plain = 'Line one.\nLine two.\n\nNew paragraph.\n';
    return {
      json: parseTranscriptFile('a.json', json),
      vtt: parseTranscriptFile('a.vtt', vtt),
      cons: parseTranscriptFile('a.txt', cons),
      plain: parseTranscriptFile('a.txt', plain),
      emptyErr: (() => { try { parseTranscriptFile('a.txt', '  \n '); } catch (e) { return e.message; } })(),
    };
  });
  expect(out.json.text).toBe('Hello there. General Kenobi.');
  expect(out.json.segments[1]).toEqual({ start: 1.5, end: 3, text: 'General Kenobi.' });
  expect(out.vtt.text).toBe('Hi all. Start.');
  expect(out.vtt.segments[0].start).toBe(1);
  expect(out.cons.text).toBe('First. Second.');
  expect(out.cons.segments[1].end).toBe(4);
  expect(out.plain.text).toBe('Line one. Line two.\n\nNew paragraph.');
  expect(out.plain.segments).toEqual([]);
  expect(out.emptyErr).toContain('no transcript text');
});
