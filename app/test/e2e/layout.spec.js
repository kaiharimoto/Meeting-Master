'use strict';

// Layout, density and the collapsing shell. These are the specs that pin the
// contracts a stylesheet can otherwise break silently: DOM order surviving a
// two-column grid, the rail adding width rather than taking it, and a
// collapsed panel actually being gone rather than merely clipped.

const path = require('path');
const { pathToFileURL } = require('url');
const { test, expect } = require('@playwright/test');

const INDEX_URL = pathToFileURL(
  path.resolve(__dirname, '..', '..', 'src', 'renderer', 'index.html')
).href;

function apiStub() {
  window.__liveCbs = [];
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
    onLiveEvent: (cb) => {
      window.__liveCbs.push(cb);
      return () => {};
    },
    onLiveModelEvent: () => () => {},
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
  };
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(apiStub);
});

const showRail = (page) =>
  page.evaluate(() =>
    window.__liveCbs.forEach((cb) =>
      cb({
        type: 'flag-candidates',
        questions: [
          {
            question: 'What is the renewal price?',
            answer: 'A 12% increase.',
            answerer: 'Bob',
            confidence: 'high',
          },
        ],
      })
    )
  );

test('a wide window puts Q&A and details in different columns, DOM order intact', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1900, height: 1000 });
  await page.goto(INDEX_URL);

  const qa = await page.locator('#panel-qa').boundingBox();
  const details = await page.locator('#panel-details').boundingBox();
  // Working column left, context column right — side by side, not stacked.
  expect(details.x).toBeGreaterThan(qa.x + qa.width - 1);

  // Generate sits under Q&A, in the same column.
  const generate = await page.locator('#panel-generate').boundingBox();
  expect(Math.round(generate.x)).toBe(Math.round(qa.x));

  // All four placements, including Record (whose panel needs the real media
  // pipeline to show, and isn't up in this stub).
  const cells = await page.evaluate(() =>
    ['panel-qa', 'panel-generate', 'panel-details', 'panel-record'].map((id) => {
      const s = getComputedStyle(document.getElementById(id));
      return `${id}:${s.gridRowStart}/${s.gridColumnStart}`;
    })
  );
  expect(cells).toEqual([
    'panel-qa:1/1',
    'panel-generate:2/1',
    'panel-details:1/2',
    'panel-record:2/2',
  ]);

  // The keyboard still walks the panels in workflow order.
  const order = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.meeting-grid > .panel')).map((el) => el.id)
  );
  expect(order).toEqual(['panel-details', 'panel-qa', 'panel-record', 'panel-generate']);
});

test('a narrow window is one column, and the field grid collapses with it', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 900 });
  await page.goto(INDEX_URL);

  const qa = await page.locator('#panel-qa').boundingBox();
  const details = await page.locator('#panel-details').boundingBox();
  expect(Math.round(details.x)).toBe(Math.round(qa.x));
  expect(details.y).toBeLessThan(qa.y);

  // One track, not two.
  const tracks = await page.evaluate(() => {
    const style = getComputedStyle(document.querySelector('.field-grid'));
    return style.gridTemplateColumns.split(' ').length;
  });
  expect(tracks).toBe(1);
});

test('resizing the rail takes width from the margins, not the main column', async ({ page }) => {
  // The contract is "the rail adds width" — which it can only do while there
  // IS spare width, i.e. while the screen is capped by max-width rather than by
  // the window. Sized so that holds even after the drag widens the rail.
  await page.setViewportSize({ width: 2400, height: 1000 });
  await page.goto(INDEX_URL);
  await showRail(page);

  const handle = page.locator('#rail-resizer');
  await expect(handle).toBeVisible();

  const before = await page.locator('.meeting-main').boundingBox();
  const railBefore = await page.locator('#live-rail').boundingBox();

  const box = await handle.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + 60);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 100, box.y + 60, { steps: 10 });
  await page.mouse.up();

  const after = await page.locator('.meeting-main').boundingBox();
  const railAfter = await page.locator('#live-rail').boundingBox();

  expect(Math.round(railAfter.width)).toBeGreaterThan(Math.round(railBefore.width));
  expect(Math.round(after.width)).toBe(Math.round(before.width));
});

test('the separator is keyboard-operable and remembers its width', async ({ page }) => {
  await page.setViewportSize({ width: 2400, height: 1000 });
  await page.goto(INDEX_URL);
  await showRail(page);

  const handle = page.locator('#rail-resizer');
  await expect(handle).toHaveAttribute('role', 'separator');
  await expect(handle).toHaveAttribute('aria-orientation', 'vertical');
  await expect(handle).toHaveAttribute('aria-valuenow', '300');

  await handle.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(handle).toHaveAttribute('aria-valuenow', '316');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(handle).toHaveAttribute('aria-valuenow', '284');

  // Clamped at both ends.
  await page.keyboard.press('Home');
  await expect(handle).toHaveAttribute('aria-valuenow', '460');
  await page.keyboard.press('End');
  await expect(handle).toHaveAttribute('aria-valuenow', '240');

  // …and it survives a reload, applied before the first paint.
  await page.reload();
  await showRail(page);
  await expect(page.locator('#rail-resizer')).toHaveAttribute('aria-valuenow', '240');
  const width = await page.locator('#live-rail').boundingBox();
  expect(Math.round(width.width)).toBe(240);
});

test('the collapsed sidebar keeps every nav item usable and named', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(INDEX_URL);

  const sidebar = page.locator('#sidebar');
  const wide = await sidebar.boundingBox();

  const toggle = page.locator('#sidebar-toggle');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');

  const narrow = await sidebar.boundingBox();
  expect(narrow.width).toBeLessThan(wide.width);
  expect(Math.round(narrow.width)).toBe(64);

  // Still a button, still named, still works — the label is sr-only, not gone.
  const nav = page.locator('#nav-activity');
  await expect(nav).toHaveAccessibleName('Activity');
  await nav.click();
  await expect(page.locator('#screen-activity')).toBeVisible();

  // Persisted pre-paint: no flash of the wide shell on reload.
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-sidebar', 'collapsed');
  expect(Math.round((await sidebar.boundingBox()).width)).toBe(64);

  await page.locator('#sidebar-toggle').click();
  await expect(page.locator('html')).not.toHaveAttribute('data-sidebar', 'collapsed');
});

test('compact density clamps answers and persists', async ({ page }) => {
  await page.goto(INDEX_URL);

  // The list toolbar only exists once there IS a list.
  await expect(page.locator('#list-toolbar')).toBeHidden();

  await page.locator('#quick-question').click();
  await page.keyboard.type('Does compact mode work?');
  await page.keyboard.press('Enter');
  await expect(page.locator('#list-toolbar')).toBeVisible();
  await expect(page.locator('#card-count')).toHaveText('1 question');

  await page.keyboard.type('And with two?');
  await page.keyboard.press('Enter');
  await expect(page.locator('#card-count')).toHaveText('2 questions');

  const list = page.locator('#card-list');
  const toggle = page.locator('#density-toggle');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(list).toHaveAttribute('data-density', 'compact');

  await page.reload();
  await expect(page.locator('#card-list')).toHaveAttribute('data-density', 'compact');
  await expect(page.locator('#density-toggle')).toHaveAttribute('aria-pressed', 'true');
});

test('a collapsed panel is unreachable, not merely clipped', async ({ page }) => {
  await page.goto(INDEX_URL);

  // Generate is collapsed by default in the setup stage.
  const panel = page.locator('#panel-generate');
  await expect(panel).toHaveClass(/is-collapsed/);
  await expect(panel.locator('.panel-body')).toHaveCSS('grid-template-rows', '0px');
  await expect(page.locator('#generate-pdf-btn')).toBeHidden();

  // Expanding animates the same row back open.
  await page.locator('#generate-heading .panel-toggle').click();
  await expect(page.locator('#generate-pdf-btn')).toBeVisible();
  const rows = await panel.locator('.panel-body').evaluate(
    (el) => getComputedStyle(el).gridTemplateRows
  );
  expect(parseFloat(rows)).toBeGreaterThan(0);
});
