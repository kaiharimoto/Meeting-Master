'use strict';

// The immersive transcript reader: the full-screen, large-type view of a
// transcript. It exists because the live pane shares .log-view with the server
// log — 12px monospace in a 180px box — which is unreadable while chairing a
// meeting, and because the finished transcript had no in-app viewer at all.
//
// What is worth pinning here is behaviour that would silently rot: that the
// reader is READ-ONLY over the transcript, that timestamps are rendered at all
// (they have existed in the data since the beginning and were never shown),
// and that search moves you without the follow-scroll yanking you back.

const path = require('path');
const { pathToFileURL } = require('url');
const { test, expect } = require('@playwright/test');

const INDEX_URL = pathToFileURL(
  path.resolve(__dirname, '..', '..', 'src', 'renderer', 'index.html')
).href;

const MEETING_KEY = 'meetingmaster.meeting.v1';

function apiStub() {
  window.__liveCbs = [];
  window.api = {
    getConfig: async () => ({
      serverUrl: 'http://test',
      emailMode: 'home',
      pageSize: 'Letter',
      hasToken: true,
      micDeviceId: '',
      micDeviceLabel: '',
      liveTranscriptEnabled: false,
      liveModel: 'small',
      configPath: '/dev/null',
    }),
    onJobProgress: () => () => {},
    onRecEvent: () => () => {},
    onLiveEvent: (cb) => {
      window.__liveCbs.push(cb);
      return () => {};
    },
    onLiveModelEvent: () => () => {},
    liveSupportGet: async () => ({ supported: false, models: {} }),
    getJobStatus: async () => ({ id: 'stub-job', state: 'ready' }),
    pickSavePath: async () => ({ filePath: null }),
    saveTextFile: async () => ({ ok: true }),
    getJobPrompt: async () => ({ text: 'PROMPT' }),
    // The Record panel hides itself wholesale without these, and the live
    // pane (with its Read button) lives inside it.
    recStart: async () => ({
      recId: 'rec-test',
      filePath: '/recordings/rec-test/audio.webm',
      freeBytes: 10e9,
    }),
    recAppend: async () => ({ bytes: 1000, freeBytes: 10e9 }),
    recStop: async () => ({ filePath: '/recordings/rec-test/audio.webm', bytes: 1, durationMs: 0 }),
    recDiscard: async () => ({ ok: true }),
    recStat: async () => ({ exists: true, bytes: 1 }),
    recOpenFolder: async () => ({ ok: true }),
    recResolveOrphan: async () => ({}),
    recListOrphans: async () => ({ orphans: [] }),
    // No fonts installed: the reader must still work on the fallback stack.
    getFontFaces: async () => ({ faces: [] }),
  };
}

/** Seed a finished meeting with a timestamped transcript. */
function seedMeeting(page) {
  return page.addInitScript(
    ([key, meeting]) => {
      localStorage.setItem(key, JSON.stringify(meeting));
    },
    [
      MEETING_KEY,
      {
        meetingId: 'm-1',
        details: { title: 'Quarterly review', date: '2026-08-12', time: '11:00', attendees: [] },
        cards: [],
        recipients: [],
        options: {},
        job: { id: 'stub-job', state: 'ready' },
        transcript: {
          text: 'Morning everyone. The budget is approved. Any questions about the timeline?',
          segments: [
            { start: 0, end: 3, text: 'Morning everyone.' },
            { start: 65, end: 70, text: 'The budget is approved.' },
            { start: 3725, end: 3730, text: 'Any questions about the timeline?' },
          ],
        },
      },
    ]
  );
}

test('the finished transcript opens full screen with timestamps', async ({ page }) => {
  await page.addInitScript(apiStub);
  await seedMeeting(page);
  await page.goto(INDEX_URL);

  const backdrop = page.locator('#immersive-modal');
  await expect(backdrop).toBeHidden();

  await page.locator('#read-transcript-btn').click();
  await expect(backdrop).toBeVisible();
  await expect(page.locator('#immersive-title')).toHaveText('Meeting transcript');

  const lines = page.locator('#immersive-body .immersive-line');
  await expect(lines).toHaveCount(3);
  await expect(lines.nth(0).locator('.immersive-time')).toHaveText('0:00');
  await expect(lines.nth(1).locator('.immersive-time')).toHaveText('1:05');
  // Past an hour the format widens rather than showing 62:05.
  await expect(lines.nth(2).locator('.immersive-time')).toHaveText('1:02:05');
  await expect(lines.nth(1).locator('.immersive-text')).toHaveText('The budget is approved.');
});

test('the reader is bigger than the log pane it replaces', async ({ page }) => {
  await page.addInitScript(apiStub);
  await seedMeeting(page);
  await page.goto(INDEX_URL);
  await page.locator('#read-transcript-btn').click();

  const size = (sel) =>
    page.locator(sel).evaluate((el) => parseFloat(getComputedStyle(el).fontSize));

  // The whole point of the feature: reading type, not log type.
  const reader = await size('#immersive-body');
  const logPane = await size('#live-view');
  expect(reader).toBeGreaterThan(logPane * 1.5);

  // A+ / A- step it and stay within bounds.
  await page.locator('#immersive-bigger-btn').click();
  expect(await size('#immersive-body')).toBeGreaterThan(reader);
  await page.locator('#immersive-smaller-btn').click();
  expect(await size('#immersive-body')).toBeCloseTo(reader, 1);
});

test('search finds a line, counts matches, and stops the follow-scroll', async ({ page }) => {
  await page.addInitScript(apiStub);
  await seedMeeting(page);
  await page.goto(INDEX_URL);
  await page.locator('#read-transcript-btn').click();

  await page.locator('#immersive-search').fill('budget');
  await expect(page.locator('#immersive-count')).toHaveText('1 of 1');
  await expect(page.locator('#immersive-body .immersive-line.is-current')).toContainText(
    'The budget is approved.'
  );
  // Jumping to a match means reading back — following the live edge would
  // drag the operator away from what they just searched for.
  await expect(page.locator('#immersive-follow-check')).not.toBeChecked();

  await page.locator('#immersive-search').fill('nothing matches this');
  await expect(page.locator('#immersive-count')).toHaveText('No matches');
  await expect(page.locator('#immersive-body .immersive-line.is-match')).toHaveCount(0);
});

test('Escape closes it and the transcript is never modified', async ({ page }) => {
  await page.addInitScript(apiStub);
  await seedMeeting(page);
  await page.goto(INDEX_URL);

  const before = await page.evaluate(
    (k) => JSON.parse(localStorage.getItem(k)).transcript,
    MEETING_KEY
  );

  await page.locator('#read-transcript-btn').click();
  await expect(page.locator('#immersive-modal')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#immersive-modal')).toBeHidden();

  const after = await page.evaluate(
    (k) => JSON.parse(localStorage.getItem(k)).transcript,
    MEETING_KEY
  );
  expect(after).toEqual(before);
});

test('Ctrl+Shift+L toggles the reader and never stacks on another dialog', async ({ page }) => {
  await page.addInitScript(apiStub);
  await seedMeeting(page);
  await page.goto(INDEX_URL);

  await page.keyboard.press('Control+Shift+L');
  await expect(page.locator('#immersive-modal')).toBeVisible();
  await page.keyboard.press('Control+Shift+L');
  await expect(page.locator('#immersive-modal')).toBeHidden();

  // With the shortcuts dialog open the chord is inert — same rule as Q and ?.
  await page.keyboard.press('?');
  await expect(page.locator('#shortcuts-modal')).toBeVisible();
  await page.keyboard.press('Control+Shift+L');
  await expect(page.locator('#immersive-modal')).toBeHidden();
});

test('the live draft is readable full screen, with approximate offsets', async ({ page }) => {
  await page.addInitScript(apiStub);
  await page.goto(INDEX_URL);

  // Reveal the pane the way the recorder does, then push draft segments.
  await page.evaluate(() => {
    document.getElementById('live-wrap').hidden = false;
    document.dispatchEvent(new CustomEvent('mm:live-start'));
  });
  await page.evaluate(() =>
    window.__liveCbs.forEach((cb) => cb({ type: 'segment', text: 'Opening remarks.', atMs: 0 }))
  );
  await page.evaluate(() =>
    window.__liveCbs.forEach((cb) => cb({ type: 'segment', text: 'Now the numbers.', atMs: 92000 }))
  );

  // The Read button lives in the live pane, inside the Record panel, which
  // stage.js collapses before a recording starts — expand it the way the
  // operator would.
  const recordPanel = page.locator('#panel-record');
  if (await recordPanel.evaluate((el) => el.classList.contains('is-collapsed'))) {
    await recordPanel.locator('.panel-toggle').click();
  }

  await page.locator('#live-read-btn').click();
  await expect(page.locator('#immersive-title')).toHaveText('Live transcript');
  // The live clock skips silence and drops backlog, so it is offered as a
  // rough locator and says so rather than posing as exact.
  await expect(page.locator('#immersive-note')).toContainText('approximate');

  const lines = page.locator('#immersive-body .immersive-line');
  await expect(lines).toHaveCount(2);
  await expect(lines.nth(1).locator('.immersive-time')).toHaveText('1:32');

  // A segment arriving while the reader is open lands in it live.
  await page.evaluate(() =>
    window.__liveCbs.forEach((cb) => cb({ type: 'segment', text: 'And the risks.', atMs: 120000 }))
  );
  await expect(lines).toHaveCount(3);
  await expect(lines.nth(2).locator('.immersive-text')).toHaveText('And the risks.');
});
