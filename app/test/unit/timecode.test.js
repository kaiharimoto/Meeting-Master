'use strict';

// Timecode formatting, and the one place it must NOT appear.
//
// The timestamps exist so the operator can find a moment in the recording by
// keyword and jump to it. Two properties matter: the format has to be readable
// at a glance (short form for a normal meeting, hours only when there are
// hours), and it has to survive junk input — a single malformed segment must
// not be the reason a whole transcript refuses to render.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC = path.resolve(__dirname, '..', '..', 'src');

// The renderer is ES modules and this suite is CommonJS; import() bridges it.
let timecode;
test.before(async () => {
  timecode = await import(
    require('url').pathToFileURL(path.join(SRC, 'renderer/js/timecode.js')).href
  );
});

test('formats under an hour as m:ss with padded seconds', () => {
  const { formatTimecode } = timecode;
  assert.equal(formatTimecode(0), '0:00');
  assert.equal(formatTimecode(7), '0:07');
  assert.equal(formatTimecode(62), '1:02');
  assert.equal(formatTimecode(599), '9:59');
  assert.equal(formatTimecode(3599), '59:59');
});

test('widens to h:mm:ss only once there is an hour to show', () => {
  const { formatTimecode } = timecode;
  assert.equal(formatTimecode(3600), '1:00:00');
  assert.equal(formatTimecode(3661), '1:01:01');
  assert.equal(formatTimecode(7325), '2:02:05');
});

test('truncates fractional seconds rather than rounding up', () => {
  // 59.9s is still the 59th second of the recording; showing 1:00 would send
  // the operator to the wrong side of a minute boundary.
  assert.equal(timecode.formatTimecode(59.9), '0:59');
});

test('clamps junk input instead of printing NaN', () => {
  const { formatTimecode } = timecode;
  for (const bad of [undefined, null, NaN, -5, Infinity, 'abc', {}]) {
    assert.match(formatTimecode(bad), /^\d+:\d{2}$/, `bad input ${String(bad)}`);
  }
  assert.equal(formatTimecode(-5), '0:00');
});

test('converts milliseconds for the live path', () => {
  assert.equal(timecode.formatTimecodeMs(62000), '1:02');
  assert.equal(timecode.formatTimecodeMs(0), '0:00');
});

test('renders segments as [m:ss] lines and drops silent ones', () => {
  const { segmentsToTimestampedText } = timecode;
  const out = segmentsToTimestampedText([
    { start: 0, end: 2, text: 'Morning everyone.' },
    { start: 2, end: 4, text: '   ' }, // whisper emits these for silence
    { start: 65, end: 70, text: 'Budget is approved.' },
  ]);
  assert.equal(out, '[0:00] Morning everyone.\n[1:05] Budget is approved.');
});

test('returns null when there is nothing usable, so callers can fall back', () => {
  const { segmentsToTimestampedText } = timecode;
  assert.equal(segmentsToTimestampedText([]), null);
  assert.equal(segmentsToTimestampedText(null), null);
  assert.equal(segmentsToTimestampedText(undefined), null);
  assert.equal(segmentsToTimestampedText([{ start: 0, end: 1, text: '' }]), null);
});

test('the AI prompt is built from the flat transcript, never from segments', () => {
  // The external prompt exists to be pasted into a chatbot. Timestamps in it
  // are pure token cost and give the model something irrelevant to imitate, so
  // the server composes it from `transcript.text` — the space-joined form with
  // segment boundaries already discarded. If someone makes the prompt
  // segment-aware for "more context", this fails and they have to mean it.
  const server = path.resolve(__dirname, '..', '..', '..', 'server', 'app');
  const summarize = fs.readFileSync(path.join(server, 'pipeline/summarize.py'), 'utf8');
  const signature = summarize.match(/def external_prompt\([^)]*\)[^:]*:/);
  assert.ok(signature, 'external_prompt must still exist');
  assert.match(
    signature[0],
    /transcript_text: str/,
    'external_prompt takes flat text, not segments'
  );

  const monitor = fs.readFileSync(path.join(server, 'routes/monitor.py'), 'utf8');
  assert.match(
    monitor,
    /summarize\.external_prompt\(\s*record\.transcript\.text,/,
    'the prompt route must pass transcript.text, not transcript.segments'
  );
  assert.doesNotMatch(
    monitor,
    /external_prompt\([^)]*segments/,
    'no timestamps may reach the external AI prompt'
  );
});
