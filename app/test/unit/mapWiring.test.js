'use strict';

// Structural guards for the meeting map, in the spirit of pdfWiring.test.js.
//
// These read source rather than running it, deliberately: they cover wiring no
// functional test reaches. Playwright drives plain Chromium with window.api
// stubbed, so a map window wired into two of its three hops would pass every
// browser test and do nothing in the real app. When one of these fails, fix the
// code, not the test.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const APP = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(APP, rel), 'utf8');

const { CHANNELS } = require('../../src/shared/schema');

const MAP_CHANNELS = ['MAP_OPEN', 'MAP_CLOSE', 'MAP_PIN', 'MAP_GET'];

test('every map channel is declared, handled and exposed', () => {
  const ipc = read('src/main/ipc.js');
  const preload = read('src/preload/preload.js');
  for (const key of [...MAP_CHANNELS, 'MAP_STATE', 'FILE_SAVE_BINARY']) {
    assert.ok(CHANNELS[key], `schema.js declares ${key}`);
    assert.match(preload, new RegExp(`CHANNELS\\.${key}`), `preload exposes ${key}`);
  }
  for (const key of MAP_CHANNELS) {
    assert.match(
      ipc,
      new RegExp(`handleLocal\\(CHANNELS\\.${key},`),
      `ipc.js registers ${key} as handleLocal`
    );
  }
});

test('the privileged map channels are handleLocal, never handle', () => {
  // The server-mode window loads the loopback dashboard with this same
  // preload attached. handle() would let that page open and drive the map.
  const ipc = read('src/main/ipc.js');
  for (const key of MAP_CHANNELS) {
    assert.doesNotMatch(
      ipc,
      new RegExp(`\\bhandle\\(CHANNELS\\.${key},`),
      `${key} must not be registered with the un-gated handle()`
    );
  }
});

test('map state is pushed to BOTH windows, not just the main one', () => {
  // pushTo() resolves getMainWindow() and nothing else, so wiring liveMap
  // through it would leave the pop-out — the window the operator is actually
  // watching — permanently blank.
  const ipc = read('src/main/ipc.js');
  assert.match(
    ipc,
    /liveMap\.setEmitter\(pushToBoth\(CHANNELS\.MAP_STATE\)\)/,
    'liveMap must emit through the two-window fan-out'
  );
  assert.match(ipc, /mapWindow\.forwardState\(channel, payload\)/);
});

test('the fan-out names its recipients rather than broadcasting', () => {
  // getAllWindows() would also reach the admin window, which loads remote HTTP
  // content and is deliberately given no preload at all.
  // Comments are stripped first, as whisperFlags.test.js does: prose ABOUT the
  // rule must not be able to satisfy or violate it.
  const ipc = read('src/main/ipc.js')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(
    ipc,
    /getAllWindows\(\)/,
    'map state must never go to every window indiscriminately'
  );
});

test('the map window is always-on-top, resizable, and has the preload', () => {
  const source = read('src/main/mapWindow.js');
  assert.match(source, /alwaysOnTop:\s*true/);
  assert.match(source, /resizable:\s*true/);
  assert.match(source, /preload:\s*path\.join\(__dirname, '\.\.', 'preload', 'preload\.js'\)/);
  assert.match(source, /contextIsolation:\s*true/);
  assert.match(source, /nodeIntegration:\s*false/);
});

test('the map window closes when the window that owns it does', () => {
  // app.on('window-all-closed') only quits on the LAST window. An always-on-top
  // map left behind would keep the whole app alive with its live loop still
  // asking the home server about a meeting that finished.
  const main = read('src/main/main.js');
  const closedBlocks = main.match(/mainWindow\.on\('closed'[\s\S]{0,420}?\n  \}\);/g) || [];
  const closing = closedBlocks.filter((b) => b.includes('mapWindow.close()'));
  assert.ok(
    closing.length >= 2,
    'both the operator and server-mode windows must close the map on their way out'
  );
});

test('the map window does NOT close when recording stops', () => {
  // Unlike the mini strip, whose job ends with the recording. The minute after
  // a meeting ends is exactly when someone reads what it turned into.
  const ipc = read('src/main/ipc.js');
  const stop = ipc.slice(
    ipc.indexOf('CHANNELS.LIVE_STOP'),
    ipc.indexOf('CHANNELS.MAP_OPEN')
  );
  assert.match(stop, /liveMap\.stop\(\)/, 'the loop stops');
  assert.doesNotMatch(stop, /mapWindow\.close\(\)/, 'the window stays');
});

test('both live loops take the GPU lock, and release it in a finally', () => {
  // Two asks in flight against one home GPU is the thrash the server's own
  // 409 guard exists to prevent; the server cannot see it, because from its
  // side these are two unrelated clients.
  for (const rel of ['src/main/liveFlagger.js', 'src/main/liveMap.js']) {
    const source = read(rel);
    assert.match(source, /gpuLock\.tryAcquire\(/, `${rel} takes the lock`);
    const finallyBlock = source.slice(source.indexOf('} finally {'));
    assert.match(finallyBlock, /gpuLock\.release\(\)/, `${rel} releases it in finally`);
    assert.match(
      source,
      /if \(inFlight\) gpuLock\.release\(\);/,
      `${rel} also releases a lock its abandoned ask still holds on stop()`
    );
  }
});

test('the map never reaches state.transcript, the AI prompt, or the PDF', () => {
  // The same rule the live draft transcript lives under: this is a small model
  // reading 15-second windows, and it must not become an input to the document
  // anyone keeps. transcriptSource.test.js guards the transcript side; this
  // guards the map's.
  for (const rel of ['src/renderer/js/map.js', 'src/renderer/js/mapDraw.js',
                     'src/renderer/js/mapLayout.js']) {
    const source = read(rel);
    assert.doesNotMatch(source, /state\.transcript/, `${rel} must not touch the transcript`);
    assert.doesNotMatch(source, /renderPdf|pdf:render/, `${rel} must not reach the PDF`);
    assert.doesNotMatch(source, /ctx\.persist|localStorage\.setItem\('meetingmaster\.meeting/,
      `${rel} must not write the saved meeting`);
  }
  const liveMap = read('src/main/liveMap.js');
  assert.doesNotMatch(liveMap, /writeFileSync|job\.transcript/,
    'the map is live-only: it is never written to disk or mixed into a job');
});

test('map.css carries no literal font-size', () => {
  // The same invariant app.css holds, so the Text size setting reaches this
  // window. appearance.spec.js only probes index.html, so nothing else would
  // catch a literal here — and this page is read from across a desk, which is
  // exactly when someone reaches for that setting.
  const css = read('src/renderer/styles/map.css');
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(
    stripped,
    /font-size:\s*[0-9]/,
    'every size must be a --fs-* token so --fs-scale applies'
  );
  assert.match(stripped, /font-size:\s*var\(--fs-/, 'the tokens are actually used');
});

test('the map page links the real stylesheet and boots the theme', () => {
  // Rather than hand-copying a palette, which is how mini.html came to ignore
  // the operator's theme, contrast and text-size settings entirely.
  const html = read('src/renderer/map.html');
  assert.match(html, /<link rel="stylesheet" href="styles\/app\.css"/);
  assert.match(html, /<link rel="stylesheet" href="styles\/map\.css"/);
  assert.match(html, /<script src="js\/themeBoot\.js"><\/script>/);
  // The PNG export draws the map's own SVG through a data: URL onto a canvas.
  assert.match(html, /img-src 'self' data:/, 'the CSP must permit the export');
});
