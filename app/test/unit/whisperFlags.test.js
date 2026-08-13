'use strict';

// Live transcription shells out to the SAME whisper-cli the home server does,
// so it inherited the same regression: whisper.cpp v1.8.0 turned flash
// attention on by default, and on an AMD RX 7900 XTX the Vulkan path for it
// kills the process during model load — exit 0xC000001D, no error message.
//
// Two rules come out of that, and neither can be reached by a functional test
// (this is main-process code that requires electron, and the failure needs a
// specific GPU to reproduce):
//
//   1. Never pass a flag `whisper-cli --help` has not advertised. whisper.cpp
//      answers an unrecognised argument by printing usage and exiting 0, so a
//      wrong guess is a run that looks successful and transcribed nothing —
//      strictly worse than the crash being worked around.
//   2. A crash demotes the session to the CPU. Counting it as an ordinary
//      window failure would spend the three-strikes budget on a driver bug and
//      end live transcription for a meeting the machine can still handle.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('live transcription only passes flags the binary advertised', () => {
  const live = read('app/src/main/liveTranscriber.js');

  // The flag must never appear as a bare argv entry — every use is guarded by
  // the probe. (Comments are stripped first so the explanation above the code
  // doesn't satisfy the check.)
  const code = live.replace(/\/\/[^\n]*/g, '');
  const uses = code.match(/[^\n]*--no-flash-attn[^\n]*/g) || [];
  assert.ok(uses.length >= 1, 'live transcription still asks for flash attention off');
  for (const line of uses) {
    assert.match(
      line,
      /flags\.has\('--no-flash-attn'\)/,
      `--no-flash-attn must be gated on the probe — found: ${line.trim()}`
    );
  }
  // Same rule for the CPU fallback flag.
  for (const line of code.match(/[^\n]*'--no-gpu'[^\n]*/g) || []) {
    assert.match(line, /flags\.has\('--no-gpu'\)/, `--no-gpu must be gated — ${line.trim()}`);
  }

  // The probe is awaited before the argv is built, not after.
  assert.match(code, /const flags = await s\.flags;[\s\S]*?const args = \[/);
});

test('the probe falls back to flags that have always existed', () => {
  const locator = read('app/src/main/whisperLocator.js');

  // An unrunnable binary, a timeout, or help text with no options in it must
  // not be read as "this build supports everything" — nor as "nothing", which
  // would silently disable the CPU fallback.
  assert.match(locator, /LONG_STANDING_FLAGS\s*=\s*Object\.freeze\(\['--flash-attn', '--no-gpu'\]\)/);
  assert.doesNotMatch(
    locator,
    /LONG_STANDING_FLAGS[\s\S]{0,200}--no-flash-attn/,
    '--no-flash-attn only exists in whisper.cpp v1.8.0+ and must never be assumed'
  );
  const fallbacks = locator.match(/resolve\(new Set\([^)]*\)\)/g) || [];
  assert.ok(fallbacks.length >= 2, 'both the spawn failure and the close path resolve a Set');
  for (const call of fallbacks) {
    assert.match(call, /LONG_STANDING_FLAGS|found\.length/, `unguarded resolve: ${call}`);
  }

  // Memoized per binary, keyed on mtime+size, so an update to whisper-cli is
  // never answered out of the previous build's help text.
  assert.match(locator, /stat\.mtimeMs.*stat\.size/);
});

test('a crashed whisper-cli demotes the GPU instead of ending the session', () => {
  const live = read('app/src/main/liveTranscriber.js');

  // Crash detection: an NTSTATUS-range exit code, or a signal death.
  assert.match(live, /WINDOWS_EXCEPTION_MIN = 0xc0000000/i);
  assert.match(live, /Boolean\(signal\) \|\| \(typeof code === 'number' && code >= WINDOWS_EXCEPTION_MIN\)/);

  // Our own timeout kill is not a crash — otherwise a machine that is merely
  // too slow would end up on the CPU, where it is slower still.
  assert.match(live, /killedByUs = true;/);
  assert.match(live, /const crashed =\s*\n?\s*!killedByUs/);

  // And the crash branch returns BEFORE onFailure, so the three-strikes
  // counter is untouched.
  const branch = live.match(/if \(result\.crashed[\s\S]*?\n {6}\}/);
  assert.ok(branch, 'the crash branch is still there');
  assert.match(branch[0], /gpuDisabled = true/);
  assert.match(branch[0], /return;/);
  assert.doesNotMatch(branch[0], /onFailure/);
});

test('the laptop and the home server agree on what a crash looks like', () => {
  // Same binary, same GPU, same bug — the two implementations must not drift.
  const live = read('app/src/main/liveTranscriber.js');
  const stage = read('server/app/pipeline/transcribe.py');

  assert.match(stage, /_WINDOWS_EXCEPTION_MIN = 0xC0000000/i);
  assert.match(live, /WINDOWS_EXCEPTION_MIN = 0xc0000000/i);

  // Both probe --help rather than guessing, and both name the other so a
  // future change to one leads to the other.
  assert.match(stage, /--help/);
  assert.match(live, /server\/app\/pipeline\/transcribe\.py/);
  assert.match(read('app/src/main/whisperLocator.js'), /transcribe\.py/);
});
