'use strict';

// Answer drafting crosses the channel list, the IPC layer, the preload and the
// home client — four files no browser test can see, because Playwright drives
// plain Chromium with window.api stubbed. A feature wired into three of the
// four would pass every e2e spec and fail in the app.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const APP = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(APP, rel), 'utf8');

const { CHANNELS } = require('../../src/shared/schema');

test('JOB_DRAFT_ANSWERS is a declared channel', () => {
  assert.strictEqual(CHANNELS.JOB_DRAFT_ANSWERS, 'job:draftAnswers');
});

test('the channel is handled, exposed and reaches the home server', () => {
  assert.match(read('src/main/ipc.js'), /handle\(CHANNELS\.JOB_DRAFT_ANSWERS,/);
  assert.match(
    read('src/preload/preload.js'),
    /draftAnswers: \(jobId, questions, attendees\) =>\s*call\(CHANNELS\.JOB_DRAFT_ANSWERS/
  );
  const client = read('src/main/homeClient.js');
  assert.match(client, /\/jobs\/\$\{encodeURIComponent\(jobId\)\}\/answers/);
  assert.match(client, /module\.exports = \{[^}]*draftAnswers[^}]*\}/s);
});

test('a card records when it was captured', () => {
  const capture = read('src/renderer/js/capture.js');
  // Wall clock always; the recording offset only while something is rolling.
  assert.match(capture, /capturedAt: new Date\(\)\.toISOString\(\)/);
  assert.match(capture, /ctx\.recElapsedMs\(\)/);
  assert.match(capture, /if \(typeof atMs === 'number'\) card\.atMs/);
  // …and the recorder is what supplies it.
  assert.match(read('src/renderer/js/recorder.js'), /ctx\.recElapsedMs = \(\) =>/);
});

test('the answer slot is never removed, so it can always be clicked', () => {
  const list = read('src/renderer/js/cardList.js');
  assert.match(list, /function syncAnswer\(host, text\)/);
  // The generic slot helper still removes empty slots — that is right for the
  // answerer chip. The ANSWER is the one that must persist.
  assert.doesNotMatch(list, /syncSlot\(body, 'card-answer'/);
});
