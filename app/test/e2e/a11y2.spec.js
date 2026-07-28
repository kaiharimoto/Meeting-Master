'use strict';

// Phase 7's sweep: state carried in text rather than colour and glyphs, live
// regions where something changes without the operator looking, and accessible
// names on every interactive element of the Meeting screen.
//
// a11y.spec.js (Phase 1) covers the panel toggles; this covers everything that
// announced itself badly or not at all.

const path = require('path');
const { pathToFileURL } = require('url');
const { test, expect } = require('@playwright/test');

const INDEX_URL = pathToFileURL(
  path.resolve(__dirname, '..', '..', 'src', 'renderer', 'index.html')
).href;

function apiStub() {
  window.__liveCbs = [];
  window.__jobCbs = [];
  window.api = {
    getConfig: async () => ({
      serverUrl: 'http://test',
      emailMode: 'home',
      pageSize: 'Letter',
      hasToken: true,
      configPath: '/dev/null',
    }),
    getFullConfig: async () => ({ serverUrl: 'http://test', hasToken: true }),
    onJobProgress: (cb) => {
      window.__jobCbs.push(cb);
      return () => {};
    },
    onRecEvent: () => () => {},
    onLiveEvent: (cb) => {
      window.__liveCbs.push(cb);
      return () => {};
    },
    onLiveModelEvent: () => () => {},
    getServerStatus: async () => ({ reachable: true }),
    uploadMeeting: async () => ({ jobId: 'stub-job' }),
    getJobStatus: async () => ({ id: 'stub-job', state: 'queued' }),
    renderPdf: async () => ({ pdfPath: '/tmp/x.pdf', fontUsed: true, warning: null }),
    openPdf: async () => ({ ok: true }),
    sendPdfViaHome: async () => ({ ok: true, emailed: true, error: null }),
    sendPdfViaLaptop: async () => ({ ok: true, error: null }),
    pickWavFile: async () => ({ filePath: null }),
    pickSavePath: async () => ({ filePath: null }),
    recListOrphans: async () => ({ orphans: [] }),
    recStat: async () => ({ exists: false, bytes: 0 }),
    liveSupportGet: async () => ({ supported: false, models: {} }),
    listJobs: async () => [],
    getPreflight: async () => ({
      freeBytes: 9e10,
      server: { ok: false, error: 'connect ECONNREFUSED' },
      live: { supported: true, modelReady: false },
    }),
  };
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(apiStub);
  await page.goto(INDEX_URL);
});

test('pre-flight chips say their state instead of only colouring it', async ({ page }) => {
  const strip = page.locator('#rec-preflight');
  await expect(strip).toHaveAttribute('role', 'status');
  await expect(strip).toHaveAttribute('aria-live', 'polite');

  // The stub reports an unreachable server and an undownloaded live model, so
  // one of each state is on screen.
  await expect(strip).toContainText('Problem — Home server unreachable');
  await expect(strip).toContainText('Optional — Live model not downloaded');
  await expect(strip).toContainText('Ready — Disk space');

  // The glyphs are decorative — they must not be read out alongside the words.
  const glyphsHidden = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#rec-preflight .pf-glyph')).every(
      (el) => el.getAttribute('aria-hidden') === 'true'
    )
  );
  expect(glyphsHidden).toBe(true);
});

test('the active nav item is marked current, not just coloured', async ({ page }) => {
  await expect(page.locator('#nav-meeting')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('#nav-activity')).not.toHaveAttribute('aria-current', 'page');

  await page.locator('#nav-activity').click();
  await expect(page.locator('#nav-activity')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('#nav-meeting')).not.toHaveAttribute('aria-current', 'page');
});

test('the status line reports busy state to assistive tech', async ({ page }) => {
  const line = page.locator('#status-line');
  await expect(line).toHaveAttribute('aria-busy', 'false');

  // Drive it through the real path: a job-progress event from the main process.
  const push = (state) =>
    page.evaluate((s) => window.__jobCbs.forEach((cb) => cb({ state: s })), state);

  await push('transcribing');
  await expect(line).toHaveAttribute('aria-busy', 'true');

  await push('ready');
  await expect(line).toHaveAttribute('aria-busy', 'false');

  // An error is not "busy" either — it's the end of the work, badly.
  await push('failed');
  await expect(line).toHaveAttribute('aria-busy', 'false');
  await expect(line).toHaveClass(/is-error/);
});

test("the server pill's name follows its state", async ({ page }) => {
  const pill = page.locator('#server-pill');
  const name = await pill.getAttribute('aria-label');
  // Whatever the state resolves to, the label has to carry it — it used to be
  // the fixed string "Home server status" forever.
  expect(name).toMatch(/^Home server: .+\. Show details\.$/);
  expect(name).not.toBe('Home server status');
});

test('the live suggestions rail announces arrivals and counts them out loud', async ({ page }) => {
  await expect(page.locator('#live-rail-list')).toHaveAttribute('aria-live', 'polite');

  await page.evaluate(() =>
    window.__liveCbs.forEach((cb) =>
      cb({
        type: 'flag-candidates',
        questions: [
          { question: 'One?', answer: 'a', answerer: 'B', confidence: 'high' },
          { question: 'Two?', answer: 'b', answerer: 'B', confidence: 'high' },
        ],
      })
    )
  );

  await expect(page.locator('#live-rail .live-flag-row')).toHaveCount(2);
  await expect(page.locator('#live-rail-count')).toHaveAttribute(
    'aria-label',
    '2 suggestions waiting'
  );
});

test('every interactive element on the Meeting screen has an accessible name', async ({ page }) => {
  // Give the screen its full furniture first: cards bring their toolbars.
  await page.locator('#quick-question').click();
  await page.keyboard.type('Does everything have a name?');
  await page.keyboard.press('Enter');

  const unnamed = await page.evaluate(() => {
    const visible = (el) => el.offsetParent !== null || getComputedStyle(el).position === 'fixed';
    const name = (el) => {
      const aria = (el.getAttribute('aria-label') || '').trim();
      if (aria) return aria;
      const labelledby = el.getAttribute('aria-labelledby');
      if (labelledby) {
        const target = document.getElementById(labelledby);
        if (target && target.textContent.trim()) return target.textContent.trim();
      }
      if (el.id) {
        const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (label && label.textContent.trim()) return label.textContent.trim();
      }
      if (el.closest('label')) return el.closest('label').textContent.trim();
      const title = (el.getAttribute('title') || '').trim();
      if (title) return title;
      return el.textContent.trim();
    };

    return Array.from(
      document.querySelectorAll(
        '#screen-meeting button, #screen-meeting input, #screen-meeting select, ' +
          '#screen-meeting textarea, #screen-meeting [role="separator"]'
      )
    )
      .filter(visible)
      .filter((el) => !name(el))
      .map((el) => el.id || el.className || el.tagName);
  });

  expect(unnamed).toEqual([]);
});
