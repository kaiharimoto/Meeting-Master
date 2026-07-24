'use strict';

// Regression guard for the v0.8.0 clipboard bug: registering a permission
// handler that granted only `media` silently denied clipboard writes, so
// every Copy button failed with "Write permission denied".

const test = require('node:test');
const assert = require('node:assert/strict');
const { ALLOWED_PERMISSIONS, isAllowed, isLocalPage } = require('../../src/main/permissions');

const LOCAL = { url: 'file:///C:/app/src/renderer/index.html', origin: 'file://' };
const DASHBOARD = { url: 'http://127.0.0.1:8080/setup', origin: 'http://127.0.0.1:8080' };

test('every permission the app depends on is granted to our own pages', () => {
  // Each entry maps to a real feature; dropping one breaks that feature.
  for (const permission of ['media', 'clipboard-sanitized-write', 'display-capture']) {
    assert.equal(isAllowed(permission, LOCAL), true, `${permission} must be allowed`);
    assert.ok(ALLOWED_PERMISSIONS.includes(permission));
  }
});

test('permissions the app does not use stay denied', () => {
  for (const permission of ['geolocation', 'notifications', 'midi', 'openExternal', 'unknown']) {
    assert.equal(isAllowed(permission, LOCAL), false, `${permission} must be denied`);
  }
});

test('the loopback dashboard gets nothing — not even the clipboard', () => {
  for (const permission of ALLOWED_PERMISSIONS) {
    assert.equal(isAllowed(permission, DASHBOARD), false, `${permission} must be denied remotely`);
  }
});

test('an opaque "null" origin falls back to the sender URL', () => {
  // Chromium reports some file:// requests with a null origin; denying those
  // would break the mic and the clipboard on our own pages.
  assert.equal(isLocalPage({ url: 'file:///app/index.html', origin: 'null' }), true);
  assert.equal(isLocalPage({ url: 'file:///app/index.html', origin: '' }), true);
  assert.equal(isLocalPage({ url: 'http://127.0.0.1:8080/', origin: 'null' }), false);
  assert.equal(isLocalPage({}), false);
});

test('a remote origin is never rescued by a stale sender URL', () => {
  assert.equal(
    isLocalPage({ url: 'file:///app/index.html', origin: 'https://evil.example' }),
    false
  );
});
