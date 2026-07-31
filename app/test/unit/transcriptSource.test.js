'use strict';

// WHERE THE NOTES' TRANSCRIPT COMES FROM — an invariant, not a preference.
//
// The live transcript is a rough draft from a small model on the laptop, made
// for the operator to read DURING the meeting. It must never reach the AI that
// writes the notes: that text comes from the home server's full-quality pass
// over the recorded audio, and nothing else.
//
// This is asserted structurally because it is the kind of property that breaks
// by accident. Someone adding "keep the live text so the AI has more to work
// with", or wiring the live pane through ctx.state for convenience, would be
// making a change that looks helpful and silently degrades every meeting's
// notes. A test that names the invariant is what stops that.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC = path.resolve(__dirname, '..', '..', 'src');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

test('the live transcript pane keeps its text in memory only', () => {
  const live = read('renderer/js/liveTranscript.js');
  // It accumulates into a module-local, not into the persisted meeting state.
  assert.match(live, /^let fullText = '';$/m);
  assert.doesNotMatch(
    live,
    /ctx\.state\.transcript/,
    'the live pane must never write the meeting transcript'
  );
  assert.doesNotMatch(
    live,
    /ctx\.persist\(\)/,
    'and must never persist its draft into the saved meeting'
  );
});

test('every write of state.transcript comes from a server job', () => {
  // The exhaustive list, checked file by file: if a new writer appears, this
  // test fails and whoever added it has to justify the source.
  const writers = {
    'renderer/js/generate.js': [/ctx\.state\.transcript = job\.transcript;/],
    'renderer/js/activity.js': [/ctx\.state\.transcript = job\.transcript \|\| null;/],
    // nameFix rewrites misspelled names INSIDE the server transcript; it
    // derives from state.transcript rather than introducing a new source.
    'renderer/js/nameFix.js': [/state\.transcript = \{ \.\.\.state\.transcript, text \}/],
  };

  const files = fs
    .readdirSync(path.join(SRC, 'renderer', 'js'))
    .filter((f) => f.endsWith('.js'))
    .map((f) => `renderer/js/${f}`);

  for (const file of files) {
    const source = read(file);
    // Assignments only — reads are fine anywhere.
    const assignments = source.match(/(?:ctx\.)?state\.transcript\s*=[^=]/g) || [];
    if (assignments.length === 0) continue;
    const allowed = writers[file];
    assert.ok(
      allowed,
      `${file} assigns state.transcript but is not a known writer — the notes' ` +
        'transcript must come from the home server job, never from the live draft'
    );
    for (const pattern of allowed) assert.match(source, pattern);
  }

  // The dev-only mock fixture loader is the one other assignment in generate.js;
  // it is behind a keyboard shortcut and loads a canned file, not live text.
  const generate = read('renderer/js/generate.js');
  const generateAssignments = generate.match(/(?:ctx\.)?state\.transcript\s*=[^=]/g) || [];
  assert.strictEqual(generateAssignments.length, 2, 'job.transcript + the dev mock');
  assert.match(generate, /ctx\.state\.transcript = mock\.transcript \|\| null;/);
});

test('the live loop reads the draft but never hands it to the notes pipeline', () => {
  // liveTranscriber.getRecentText() exists for the mid-meeting suggestion loop.
  // Its only caller must be that loop — not the upload, and not the AI prompt.
  const flagger = read('main/liveFlagger.js');
  assert.match(flagger, /liveTranscriber\.getRecentText\(/);

  for (const file of ['main/ipc.js', 'main/homeClient.js']) {
    assert.doesNotMatch(
      read(file),
      /getRecentText/,
      `${file} must not read the live draft — uploads and the AI prompt use the ` +
        'recorded audio and the server transcript'
    );
  }
});

test('the AI prompt and the upload both read the server transcript', () => {
  const generate = read('renderer/js/generate.js');
  // "Copy AI prompt" and "Copy/Save transcript" all go through state.transcript,
  // which the test above pins to the server job.
  assert.match(generate, /const text = ctx\.state\.transcript && ctx\.state\.transcript\.text;/);
  // The upload sends the AUDIO FILE; the meeting JSON carries no transcript
  // FIELD at all, so there is no path for draft text to ride along with it.
  const meetingJson = generate.slice(
    generate.indexOf('function buildMeetingJson()'),
    generate.indexOf('// Wrap handlers so any thrown')
  );
  assert.doesNotMatch(
    meetingJson,
    /^\s*transcript\s*:/m,
    'the uploaded meeting JSON must carry no transcript field'
  );
});
