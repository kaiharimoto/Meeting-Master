'use strict';

// Which token the app sends in SERVER mode. v0.22.4 made the local server's
// own token always win there, which fixed a home PC 401ing against itself —
// and broke a laptop left in server mode but paired with the real home PC:
// every upload carried the laptop's own token and 401'd. The rule is now
// "own token only when the URL is this machine"; these pin that test.

const test = require('node:test');
const assert = require('node:assert');

const { targetsThisMachine } = require('../../src/main/config');

const HOST = 'KAI-DESKTOP';
const IFACES = {
  Ethernet: [{ address: '192.168.86.30' }],
  Tailscale: [{ address: '100.101.102.103' }, { address: 'fd7a:115c:a1e0::1' }],
};
const here = (url) => targetsThisMachine(url, HOST, IFACES);

test('no URL, loopback and the wildcard address are this machine', () => {
  assert.equal(here(''), true);
  assert.equal(here('http://127.0.0.1:8080'), true);
  assert.equal(here('http://localhost:8080'), true);
  assert.equal(here('http://[::1]:8080'), true);
});

test('own hostname, bare or as a Tailscale name, is this machine', () => {
  assert.equal(here('http://KAI-DESKTOP:8080'), true);
  assert.equal(here('https://kai-desktop.tail-abc.ts.net'), true);
});

test("own interface addresses are this machine", () => {
  assert.equal(here('http://192.168.86.30:8080'), true);
  assert.equal(here('http://100.101.102.103:8080'), true);
  assert.equal(here('http://[fd7a:115c:a1e0::1]:8080'), true);
});

test('another machine is not — the pasted token must be used', () => {
  assert.equal(here('http://192.168.86.24:8080'), false);
  assert.equal(here('https://homepc.tail-abc.ts.net'), false);
  assert.equal(here('http://KAI-DESKTOP-2:8080'), false); // prefix, not a label
  assert.equal(here('not a url'), false);
});
