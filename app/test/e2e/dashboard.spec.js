'use strict';

// Home-server dashboard (server/app/setup/static/) smoke test, run in plain
// Chromium via file:// with fetch + EventSource stubbed. Verifies tab
// switching, state rendering (deps + connection code), jobs/log rendering,
// and that saving posts the settings payload.

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { test, expect } = require('@playwright/test');

// The dashboard references its assets at the served path (/setup/assets/...),
// which cannot resolve under file://. Generate a test copy beside the real
// files with relative asset URLs — the assets are flat siblings by design.
const STATIC_DIR = path.resolve(__dirname, '..', '..', '..', 'server', 'app', 'setup', 'static');
const TEST_PAGE = path.join(STATIC_DIR, '_dashboard.e2e.html');

test.beforeAll(() => {
  const html = fs
    .readFileSync(path.join(STATIC_DIR, 'setup.html'), 'utf8')
    .replaceAll('/setup/assets/', './');
  fs.writeFileSync(TEST_PAGE, html);
});

test.afterAll(() => {
  try {
    fs.unlinkSync(TEST_PAGE);
  } catch {
    // already gone
  }
});

const DASH_URL = pathToFileURL(TEST_PAGE).href;

const STATE = {
  configured: true,
  connectionCode: 'FAKECODE123',
  serverUrl: 'https://homepc.tail-abc.ts.net',
  token: 'tok',
  email: { user: 'me@gmail.com', from: '', recipientsCount: 1, hasPassword: true },
  recipients: ['boss@example.com'],
  emailTemplate: 'Subject: Notes\n\nHello',
  ollamaModel: 'gemma4:26b',
  whisperModel: 'large-v3-turbo',
  deps: {
    ollama: { installed: true, modelPresent: true, model: 'gemma4:26b' },
    tailscale: { installed: true, loggedIn: true, serveUrl: 'https://homepc.tail-abc.ts.net' },
    whisperModel: { present: true, name: 'large-v3-turbo' },
  },
  tasks: {},
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript((state) => {
    window.__posts = [];
    window.fetch = async (url, opts) => {
      const body = opts && opts.body ? JSON.parse(opts.body) : null;
      if (String(url).includes('/setup/state')) {
        return { ok: true, json: async () => state };
      }
      if (String(url).includes('/setup/save')) {
        window.__posts.push({ url: String(url), body });
        return { ok: true, json: async () => state };
      }
      if (String(url).includes('/setup/jobs')) {
        return {
          ok: true,
          json: async () => ({
            jobs: [
              { id: 'j1', state: 'ready', progress: null, title: 'Vendor Review', updatedAt: new Date().toISOString() },
            ],
          }),
        };
      }
      if (String(url).includes('/setup/logs')) {
        return { ok: true, json: async () => ({ lines: ['log line alpha'] }) };
      }
      return { ok: true, json: async () => ({}) };
    };
    // Minimal driveable EventSource stub.
    window.__esListeners = {};
    window.EventSource = class {
      constructor() { window.__es = this; }
      addEventListener(name, cb) { (window.__esListeners[name] = window.__esListeners[name] || []).push(cb); }
      close() {}
    };
    window.__pushEs = (name, data) =>
      (window.__esListeners[name] || []).forEach((cb) => cb({ data: JSON.stringify(data) }));
  }, STATE);
  await page.goto(DASH_URL);
});

test('overview renders status cards and the connection code', async ({ page }) => {
  await expect(page.locator('#ov-server')).toContainText('configured');
  await expect(page.locator('#ov-ollama')).toHaveText('Ready');
  await expect(page.locator('#ov-tailscale')).toHaveText('Connected');
  await expect(page.locator('#code-card')).toBeVisible();
  await expect(page.locator('#code')).toHaveText('FAKECODE123');
  // Configured server: no "finish setup" banner.
  await expect(page.locator('#setup-banner')).toBeHidden();
});

test('tabs switch panels and jobs/logs render, patched live by SSE', async ({ page }) => {
  await page.locator('.tab[data-tab="jobs"]').click();
  await expect(page.locator('#tab-jobs')).toBeVisible();
  await expect(page.locator('.job-row')).toHaveCount(1);
  await expect(page.locator('.job-row').first()).toContainText('Vendor Review');

  await page.evaluate(() => window.__pushEs('job', {
    id: 'j2', state: 'transcribing', progress: 30, title: 'Live Upload', updatedAt: new Date().toISOString(),
  }));
  await expect(page.locator('.job-row')).toHaveCount(2);
  await expect(page.locator('.job-row').first()).toContainText('Live Upload');

  await page.locator('.tab[data-tab="logs"]').click();
  await expect(page.locator('#log-view')).toContainText('log line alpha');
  await page.evaluate(() => window.__pushEs('log', { line: 'streamed beta line' }));
  await expect(page.locator('#log-view')).toContainText('streamed beta line');
});

test('settings tab loads state and save posts the payload', async ({ page }) => {
  await page.locator('.tab[data-tab="settings"]').click();
  await expect(page.locator('#smtpUser')).toHaveValue('me@gmail.com');
  await expect(page.locator('#ollamaModel')).toHaveValue('gemma4:26b');

  await page.locator('#recipients').fill('a@example.com\nb@example.com');
  await page.locator('#save').click();

  await expect.poll(async () => page.evaluate(() => window.__posts.length)).toBe(1);
  const post = await page.evaluate(() => window.__posts[0]);
  expect(post.body.recipients).toEqual(['a@example.com', 'b@example.com']);
  expect(post.body.ollamaModel).toBe('gemma4:26b');
  // Save routes back to Overview to show the code.
  await expect(page.locator('#tab-overview')).toBeVisible();
});

test('the dashboard tabs are a real tablist, not four buttons with a class', async ({ page }) => {
  await page.goto(DASH_URL);

  await expect(page.locator('.tabs')).toHaveAttribute('role', 'tablist');
  const tabs = page.locator('.tab');
  await expect(tabs).toHaveCount(4);

  // Each tab names the panel it controls, and each panel names its tab back.
  for (const name of ['overview', 'jobs', 'logs', 'settings']) {
    const tab = page.locator(`#tabbtn-${name}`);
    await expect(tab).toHaveAttribute('role', 'tab');
    await expect(tab).toHaveAttribute('aria-controls', `tab-${name}`);
    await expect(page.locator(`#tab-${name}`)).toHaveAttribute('role', 'tabpanel');
    await expect(page.locator(`#tab-${name}`)).toHaveAttribute('aria-labelledby', `tabbtn-${name}`);
  }

  // One tab stop for the whole list; selection is announced, not just coloured.
  await expect(page.locator('#tabbtn-overview')).toHaveAttribute('aria-selected', 'true');
  const tabindexes = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.tab')).map((el) => el.tabIndex)
  );
  expect(tabindexes).toEqual([0, -1, -1, -1]);

  // Arrows move between tabs, which is what role="tablist" promises.
  await page.locator('#tabbtn-overview').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#tabbtn-jobs')).toBeFocused();
  await expect(page.locator('#tabbtn-jobs')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#tab-jobs')).toBeVisible();
  await expect(page.locator('#tab-overview')).toBeHidden();

  await page.keyboard.press('End');
  await expect(page.locator('#tabbtn-settings')).toBeFocused();
  await page.keyboard.press('ArrowRight'); // wraps
  await expect(page.locator('#tabbtn-overview')).toBeFocused();
});
