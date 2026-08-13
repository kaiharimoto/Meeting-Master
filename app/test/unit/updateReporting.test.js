'use strict';

// A v0.19.3 home server showed "Update available: v0.20.0 … Assets cached"
// and an install control. Clicking it answered "You're up to date (v0.19.3)".
//
// Setup had never been finished, so `server.env` had no BEARER_TOKEN. The
// laptop feed is bearer-gated, so `feedConfig()` returned null, `configureFeed()`
// set `supported:false` and NOTHING else, and `checkNow()` returned without
// touching `available` or `error`. The tray dialog's final `else` branch then
// reported the running version as current — the one message guaranteed to send
// somebody looking for a bug that wasn't there.
//
// Both halves of that are pinned here. Neither can be reached by an e2e test:
// this is main-process code, and Playwright drives the renderer.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const APP = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(APP, rel), 'utf8');

test('an unusable feed always carries a reason, never a bare flag', () => {
  const updater = read('src/main/updater.js');

  // `supported: false` without an `error` is the exact shape of the bug: a
  // state that renders as "nothing to report" when the truth is "could not
  // look". Every occurrence must carry the message with it.
  const bare = updater.match(/setState\(\{[^}]*supported:\s*false[^}]*\}\)/g) || [];
  assert.ok(bare.length >= 2, 'configureFeed still has its failure paths');
  for (const call of bare) {
    assert.match(call, /error:/, `supported:false must ship a reason — found ${call}`);
  }

  // The reason is computed once and consulted by both the feed builder and the
  // configure path, so they cannot drift into disagreeing about whether a feed
  // is usable.
  assert.match(updater, /function feedProblem\(cfg\)/);
  assert.match(updater, /function feedConfig\(\)[\s\S]*?if \(feedProblem\(cfg\)\) return null;/);
  assert.match(updater, /const problem = feedProblem\(config\.get\(\)\);/);

  // The server-mode reason has to name the fix. "Not configured" alone leaves
  // the operator exactly where they started.
  assert.match(updater, /Save & Finish/);
});

test('"up to date" is unreachable unless a check actually ran', () => {
  const main = read('src/main/main.js');

  const dialogFn = main.slice(main.indexOf('async function checkForUpdatesFromTray'));
  assert.ok(dialogFn.includes("You're up to date"), 'the reassuring branch still exists');

  // It must come AFTER the guard, not instead of it.
  const guard = dialogFn.indexOf('if (!s.supported)');
  const reassurance = dialogFn.indexOf("You're up to date");
  assert.ok(guard > -1, 'the unsupported case is handled');
  assert.ok(guard < reassurance, 'the unsupported case is handled before claiming currency');

  // And when the server knows about a release the app could not offer, that
  // disagreement is reported rather than smoothed over.
  assert.match(dialogFn, /sidecarLatest/);
  assert.match(dialogFn, /const waiting = isNewerVersion\(sidecarLatest, current\)/);
});

test('version comparison is numeric, so v0.9.0 never outranks v0.20.0', () => {
  const main = read('src/main/main.js');
  // A lexical compare put the field report's v0.20.0 BEHIND v0.19.3.
  assert.match(main, /function isNewerVersion\(a, b\)/);
  assert.match(main, /parseInt\(n, 10\)/);

  // Run the real thing rather than trusting the shape of it.
  const src = main.slice(main.indexOf('function isNewerVersion'));
  const body = src.slice(0, src.indexOf('\n}\n') + 3);
  // eslint-disable-next-line no-new-func
  const isNewerVersion = new Function(`${body}; return isNewerVersion;`)();

  assert.strictEqual(isNewerVersion('0.20.0', '0.19.3'), true);
  assert.strictEqual(isNewerVersion('v0.20.0', 'v0.20.0'), false);
  assert.strictEqual(isNewerVersion('0.9.0', '0.20.0'), false);
  assert.strictEqual(isNewerVersion('0.19.3', '0.20.0'), false);
  assert.strictEqual(isNewerVersion(null, '0.20.0'), false);
  assert.strictEqual(isNewerVersion('1.0.0', '0.20.99'), true);
});
