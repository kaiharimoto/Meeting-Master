'use strict';

// The remote server dashboard (v0.21.0) is the only window in this app that
// loads a document over the NETWORK, and the main process attaches the home
// server's bearer token to its requests. That combination is worth pinning in
// source, because every property that makes it safe is invisible to a
// functional test: Playwright drives plain Chromium with window.api stubbed,
// so a window shipped without contextIsolation, or with the preload attached,
// or with a '<all_urls>' header filter, would pass every browser test and leak
// a credential in the real app.
//
// These read the source. When one fails, fix the code, not the test.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const APP = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(APP, rel), 'utf8');

const { CHANNELS } = require('../../src/shared/schema');

const adminWindow = read('src/main/adminWindow.js');
const ipc = read('src/main/ipc.js');
const preload = read('src/preload/preload.js');

// --- the three hops -------------------------------------------------------

test('ADMIN_OPEN is a declared channel', () => {
  assert.strictEqual(CHANNELS.ADMIN_OPEN, 'admin:open');
});

test('ADMIN_OPEN is registered with handleLocal, not handle', () => {
  // In server mode the loopback dashboard shares this preload. It must not be
  // able to open a window that carries the bearer token, so the registration
  // has to be the file://-only variant.
  assert.match(ipc, /handleLocal\(CHANNELS\.ADMIN_OPEN/);
  assert.doesNotMatch(ipc, /[^L]\bhandle\(CHANNELS\.ADMIN_OPEN/);
});

test('the preload exposes openServerAdmin', () => {
  assert.match(preload, /openServerAdmin:\s*\(\)\s*=>\s*call\(CHANNELS\.ADMIN_OPEN\)/);
});

// --- the security properties of the window --------------------------------

test('the admin window gets no preload', () => {
  // window.api is for our own file:// pages. Handing it to a document fetched
  // from the server would expose the whole IPC surface to remote HTML.
  assert.doesNotMatch(adminWindow, /preload\s*:/);
});

test('the admin window isolates and sandboxes its renderer', () => {
  assert.match(adminWindow, /contextIsolation:\s*true/);
  assert.match(adminWindow, /nodeIntegration:\s*false/);
  assert.match(adminWindow, /sandbox:\s*true/);
});

test('the bearer token is attached in the main process, never in a renderer', () => {
  assert.match(adminWindow, /onBeforeSendHeaders/);
  assert.match(adminWindow, /Authorization.*Bearer/);
  // The token must not be handed to the page in any form.
  assert.doesNotMatch(adminWindow, /executeJavaScript/);
  assert.doesNotMatch(adminWindow, /postMessage/);
});

test('the header filter is scoped to the admin prefix, not every URL', () => {
  // A '<all_urls>' filter would attach the home server's token to any request
  // the page managed to make anywhere else.
  assert.doesNotMatch(adminWindow, /<all_urls>/);
  // Plain substring: the filter is a template literal, and escaping backticks
  // and ${} into a regex obscures what is actually being asserted.
  assert.ok(
    adminWindow.includes('urls: [`${origin}/admin*`]'),
    'the onBeforeSendHeaders filter must be scoped to <origin>/admin*'
  );
});

test('navigation is pinned to the server origin and the admin path', () => {
  assert.match(adminWindow, /will-navigate/);
  assert.match(adminWindow, /setWindowOpenHandler/);
  assert.match(adminWindow, /parsed\.origin === origin/);
  assert.match(adminWindow, /pathname\.startsWith\('\/admin'\)/);
});

test('the admin session is non-persistent', () => {
  // fromPartition without a 'persist:' prefix — nothing from the server's
  // origin outlives the window.
  assert.match(adminWindow, /fromPartition\('mm-admin'\)/);
  assert.doesNotMatch(adminWindow, /persist:mm-admin/);
});

test('opening without a configured server or token is refused up front', () => {
  // Better than opening a window that can only render a 401.
  assert.match(adminWindow, /No home server is configured/);
  assert.match(adminWindow, /No bearer token is saved/);
});

// --- the renderer never sees the token ------------------------------------

test('the settings screen asks the main process to open the window', () => {
  const settings = read('src/renderer/js/settings.js');
  assert.match(settings, /ctx\.api\.openServerAdmin\(\)/);
  // The renderer gates on the presence boolean, never on a token value —
  // getFullConfig reports hasToken, not token.
  assert.match(settings, /cfg\.hasToken/);
  assert.doesNotMatch(settings, /cfg\.bearerToken/);
});
