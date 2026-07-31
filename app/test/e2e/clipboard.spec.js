'use strict';

// Copy buttons must survive a clipboard API that rejects — which is exactly
// what a too-narrow Electron permission handler causes (v0.8.0 shipped one
// and broke every Copy button). copyText() falls back to execCommand.

const path = require('path');
const { pathToFileURL } = require('url');
const { test, expect } = require('@playwright/test');

const INDEX_URL = pathToFileURL(
  path.resolve(__dirname, '..', '..', 'src', 'renderer', 'index.html')
).href;

const TRANSCRIPT = 'The vendor confirmed a twelve percent increase.';

// clipboardMode: 'ok' | 'denied' | 'missing'
function install(clipboardMode) {
  window.__copied = null;
  window.__execCopyCalls = 0;

  if (clipboardMode === 'missing') {
    delete navigator.clipboard;
  } else {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text) => {
          if (clipboardMode === 'denied') {
            throw new DOMException(
              "Failed to execute 'writeText' on 'Clipboard': Write permission denied.",
              'NotAllowedError'
            );
          }
          window.__copied = text;
        },
      },
    });
  }

  // execCommand('copy') is a no-op in headless Chromium, so record the
  // selected text ourselves to prove the fallback ran with the right value.
  document.execCommand = (command) => {
    if (command !== 'copy') return false;
    window.__execCopyCalls += 1;
    window.__copied = document.activeElement && document.activeElement.value;
    return true;
  };

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
    getJobPrompt: async () => ({ text: 'THE FULL AI PROMPT' }),
    pickSavePath: async () => ({ filePath: null }),
    saveTextFile: async () => ({ ok: true }),
    recListOrphans: async () => ({ orphans: [] }),
    liveSupportGet: async () => ({ supported: false, models: {} }),
    getPreflight: async () => ({ server: { ok: true } }),
  };

  localStorage.setItem(
    'meetingmaster.meeting.v1',
    JSON.stringify({
      details: { title: 'Vendor review', date: '', time: '', attendees: [] },
      transcript: { text: 'The vendor confirmed a twelve percent increase.' },
      job: { id: 'job-1', state: 'ready' },
    })
  );
}

test('Copy transcript uses the clipboard API when it works', async ({ page }) => {
  await page.addInitScript(install, 'ok');
  await page.goto(INDEX_URL);

  await page.locator('#copy-transcript-btn').click();
  await expect(page.locator('#status-text')).toContainText('copied');
  expect(await page.evaluate(() => window.__copied)).toBe(TRANSCRIPT);
  expect(await page.evaluate(() => window.__execCopyCalls)).toBe(0);
});

test('a denied clipboard permission falls back instead of failing', async ({ page }) => {
  await page.addInitScript(install, 'denied');
  await page.goto(INDEX_URL);

  await page.locator('#copy-transcript-btn').click();
  await expect(page.locator('#status-text')).toContainText('copied');
  await expect(page.locator('#status-line')).not.toHaveClass(/is-error/);
  expect(await page.evaluate(() => window.__execCopyCalls)).toBe(1);
  expect(await page.evaluate(() => window.__copied)).toBe(TRANSCRIPT);
});

test('Copy AI prompt survives a denied clipboard too', async ({ page }) => {
  await page.addInitScript(install, 'denied');
  await page.goto(INDEX_URL);

  await page.locator('#copy-ai-prompt-btn').click();
  await expect(page.locator('#status-text')).toContainText('AI prompt copied');
  expect(await page.evaluate(() => window.__copied)).toBe('THE FULL AI PROMPT');
});

test('a missing clipboard API still copies', async ({ page }) => {
  await page.addInitScript(install, 'missing');
  await page.goto(INDEX_URL);

  await page.locator('#copy-transcript-btn').click();
  await expect(page.locator('#status-text')).toContainText('copied');
  expect(await page.evaluate(() => window.__copied)).toBe(TRANSCRIPT);
});
