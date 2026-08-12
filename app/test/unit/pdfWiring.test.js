'use strict';

// The PDF preview crosses three files that no e2e spec can reach: the channel
// list, the IPC registration, and the preload surface. Playwright drives plain
// Chromium with window.api stubbed, so a preview wired into two of the three
// would pass every browser test and do nothing in the app. These assertions are
// cheap and they close exactly that gap.
//
// They also pin the transcript appendix, which is OPT-IN and off by default.
// That default is the load-bearing part: a full transcript swamps a notes PDF,
// which is why it was kept out of the printed document for years. The argument
// exists again so an operator can ask for it — not so it can drift back on.

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
  assert.match(
    preload,
    /previewPdf: \(meeting, summary, transcript\) =>\s*call\(CHANNELS\.PDF_PREVIEW/
  );
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

test('the transcript reaches the print payload, all three layers', () => {
  const pdf = read('src/main/pdf.js');
  const preload = read('src/preload/preload.js');
  const ipc = read('src/main/ipc.js');

  // Half-wiring this is the failure mode: a checkbox that ticks and changes
  // nothing, because one of the three hops still drops the argument.
  assert.match(preload, /renderPdf: \(meeting, summary, transcript\)/);
  assert.match(ipc, /handle\(CHANNELS\.PDF_RENDER, \(meeting, summary, transcript\)/);
  assert.match(ipc, /handle\(CHANNELS\.PDF_PREVIEW, \(meeting, summary, transcript\)/);
  assert.match(pdf, /async function renderIntoWindow\(win, \{ meeting, summary, transcript \}\)/);
  assert.match(pdf, /transcript: transcript \|\| null/);
  // …and the decision is written down where the next reader will look.
  assert.match(pdf, /NOTE ON THE TRANSCRIPT/);
});

test('the appendix is opt-in: nothing is printed unless it was asked for', () => {
  const generate = read('src/renderer/js/generate.js');

  // The gate reads the meeting's own option, NOT the checkbox element — a
  // History restore swaps the state out from under the DOM, and the printed
  // document has to follow the meeting.
  assert.match(
    generate,
    /function transcriptForPdf\(\)[\s\S]*?options \|\| \{\}\)\.includeTranscriptInPdf\) return undefined;/
  );
  // Both render paths go through that gate — a preview that prints a
  // transcript the PDF won't (or vice versa) is a preview that lies.
  const gated = generate.match(/transcriptForPdf\(\)/g) || [];
  assert.ok(gated.length >= 3, 'defined once, used by both renderPdf and previewPdf');
});

test('the print template hides the appendix when there is no transcript', () => {
  const html = read('src/renderer/print/print.html');
  // hidden by default in the markup, and renderTranscript is what unhides it.
  assert.match(html, /<section id="transcript" hidden>/);
  assert.match(html, /function renderTranscript\(transcript\) \{[\s\S]*?if \(!transcript\) \{[\s\S]*?section\.hidden = true;/);
  // The colophon closes the document, so exactly one section may own it.
  assert.match(html, /getElementById\('summary-colophon'\)\.hidden = hasTranscript;/);
  assert.match(html, /getElementById\('transcript-colophon'\)\.hidden = !hasTranscript;/);
});
