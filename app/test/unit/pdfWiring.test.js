'use strict';

// The PDF preview crosses three files that no e2e spec can reach: the channel
// list, the IPC registration, and the preload surface. Playwright drives plain
// Chromium with window.api stubbed, so a preview wired into two of the three
// would pass every browser test and do nothing in the app. These assertions are
// cheap and they close exactly that gap.
//
// They also pin the removal of the transcript argument from renderPdf — the
// kind of change that silently half-lands.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const APP = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(APP, rel), 'utf8');

const { CHANNELS } = require('../../src/shared/schema');

test('PDF_PREVIEW is a declared channel', () => {
  assert.strictEqual(CHANNELS.PDF_PREVIEW, 'pdf:preview');
});

test('every PDF channel has an ipcMain handler', () => {
  const ipc = read('src/main/ipc.js');
  for (const key of ['PDF_RENDER', 'PDF_PREVIEW', 'PDF_OPEN']) {
    assert.match(
      ipc,
      new RegExp(`handle\\(CHANNELS\\.${key},`),
      `ipc.js registers ${key}`
    );
  }
});

test('the preload exposes previewPdf on the same channel', () => {
  const preload = read('src/preload/preload.js');
  assert.match(preload, /previewPdf: \(meeting, summary\) =>\s*call\(CHANNELS\.PDF_PREVIEW/);
});

test('the preview and the PDF share one render path', () => {
  const pdf = read('src/main/pdf.js');
  // Both must go through renderIntoWindow — a preview that resolves its own
  // HTML path or injects its own fonts is a preview that lies.
  const calls = pdf.match(/renderIntoWindow\(/g) || [];
  assert.ok(calls.length >= 3, 'renderIntoWindow is defined and called twice');
  assert.match(pdf, /async function renderMeetingPdf[\s\S]*?renderIntoWindow\(win,/);
  assert.match(pdf, /async function openPdfPreview[\s\S]*?renderIntoWindow\(win,/);
  // Exactly one preview window, ever.
  assert.match(pdf, /let previewWin = null;/);
});

test('the transcript is no longer passed into the print payload', () => {
  const pdf = read('src/main/pdf.js');
  const preload = read('src/preload/preload.js');
  const ipc = read('src/main/ipc.js');
  const generate = read('src/renderer/js/generate.js');

  assert.doesNotMatch(pdf, /transcript: transcript/);
  assert.match(preload, /renderPdf: \(meeting, summary\)/);
  assert.match(ipc, /handle\(CHANNELS\.PDF_RENDER, \(meeting, summary\)/);
  assert.doesNotMatch(generate, /renderPdf\([\s\S]{0,80}ctx\.state\.transcript/);
  // …and the decision is written down where the next reader will look.
  assert.match(pdf, /NOTE ON THE TRANSCRIPT/);
});
