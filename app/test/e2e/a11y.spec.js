'use strict';

// Keyboard/ARIA guarantees for the stage shell.
//
// Panel headings used to be an <h2> with a click handler: no role, no
// tabindex, no keydown. Since collapsed content is display:none, a keyboard
// user could not reach a collapsed panel at all. stage.js now moves the
// heading's contents into a real button inside the h2.

const path = require('path');
const { pathToFileURL } = require('url');
const { test, expect } = require('@playwright/test');

const INDEX_URL = pathToFileURL(
  path.resolve(__dirname, '..', '..', 'src', 'renderer', 'index.html')
).href;

function apiStub() {
  window.__preflightCalls = 0;
  window.api = {
    getConfig: async () => ({
      serverUrl: 'http://test',
      emailMode: 'home',
      pageSize: 'Letter',
      hasToken: true,
      configPath: '/dev/null',
    }),
    onJobProgress: () => () => {},
    onRecEvent: () => () => {},
    onLiveEvent: () => () => {},
    onLiveModelEvent: () => () => {},
    uploadMeeting: async () => ({ jobId: 'stub-job' }),
    getJobStatus: async () => ({ id: 'stub-job', state: 'queued' }),
    renderPdf: async () => ({ pdfPath: '/tmp/stub.pdf', fontUsed: true, warning: null }),
    openPdf: async () => ({ ok: true }),
    sendPdfViaHome: async () => ({ ok: true, emailed: true, error: null }),
    sendPdfViaLaptop: async () => ({ ok: true, error: null }),
    pickWavFile: async () => ({ filePath: null }),
    pickSavePath: async () => ({ filePath: null }),
    recListOrphans: async () => ({ orphans: [] }),
    recStat: async () => ({ exists: false, bytes: 0 }),
    liveSupportGet: async () => ({ supported: false, models: {} }),
    // The test drives __serverOk so a re-render is observable.
    getPreflight: async () => {
      window.__preflightCalls += 1;
      return {
        freeBytes: 10 * 1024 * 1024 * 1024,
        server: { ok: Boolean(window.__serverOk), error: 'unreachable' },
        live: { supported: false, modelReady: false },
      };
    },
  };
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(apiStub);
  await page.goto(INDEX_URL);
});

test('a collapsed panel can be expanded with the keyboard alone', async ({ page }) => {
  const panel = page.locator('#panel-generate');
  const toggle = panel.locator('.panel-toggle');

  // Setup stage collapses Generate by default.
  await expect(panel).toHaveClass(/is-collapsed/);
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');

  // The control is reachable and operable without a mouse.
  await toggle.focus();
  await expect(toggle).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(panel).not.toHaveClass(/is-collapsed/);
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#generate-pdf-btn')).toBeVisible();

  // Space collapses it again (a <button> gets this for free; an <h2> did not).
  await page.keyboard.press(' ');
  await expect(panel).toHaveClass(/is-collapsed/);
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
});

test('every panel heading exposes its expanded state', async ({ page }) => {
  for (const id of ['panel-details', 'panel-qa', 'panel-record', 'panel-generate']) {
    const panel = page.locator(`#${id}`);
    const toggle = panel.locator('.panel-toggle');
    await expect(toggle).toHaveCount(1);
    const collapsed = await panel.evaluate((el) => el.classList.contains('is-collapsed'));
    await expect(toggle).toHaveAttribute('aria-expanded', String(!collapsed));
  }
});

test('the heading keeps its semantics and its labelling role', async ({ page }) => {
  // The button lives INSIDE the h2 so aria-labelledby still resolves to text.
  const heading = page.locator('#generate-heading');
  await expect(heading).toHaveJSProperty('tagName', 'H2');
  await expect(heading.locator('.panel-toggle')).toHaveCount(1);
  await expect(page.locator('#panel-generate')).toHaveAttribute(
    'aria-labelledby',
    'generate-heading'
  );
  await expect(heading).toContainText('Generate');
});

test('pre-flight chips refresh when the Meeting screen is re-entered', async ({ page }) => {
  // The listener compared the CustomEvent detail OBJECT to a string, so it
  // never fired and the chips only ever rendered once.
  const serverChip = page.locator('#rec-preflight .pf-chip', { hasText: 'Home server' });
  await expect(serverChip).toHaveClass(/is-warn/);

  // The server comes back while the operator is on another screen.
  await page.evaluate(() => {
    window.__serverOk = true;
  });
  const before = await page.evaluate(() => window.__preflightCalls);

  await page.locator('#nav-activity').click();
  await page.locator('#nav-meeting').click();

  await expect(serverChip).toHaveClass(/is-ok/);
  expect(await page.evaluate(() => window.__preflightCalls)).toBeGreaterThan(before);
});
