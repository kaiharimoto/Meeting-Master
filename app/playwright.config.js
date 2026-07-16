'use strict';

const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: 'test/e2e',
  use: {
    browserName: 'chromium',
    launchOptions: {
      // The renderer uses <script type="module"> loaded from file:// URLs.
      // Stock Chromium blocks module loads between file:// URLs (CORS), so
      // allow it for the tests — Electron itself allows this natively.
      args: ['--allow-file-access-from-files'],
    },
  },
});
