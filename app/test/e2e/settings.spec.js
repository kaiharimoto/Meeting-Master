'use strict';

// Settings screen, exercised in plain Chromium against the real renderer
// HTML/JS. window.api (normally provided by the Electron preload) is stubbed
// before any page script runs. The stub starts UNconfigured so the Settings
// modal auto-opens, then records what saveConfig() receives.

const path = require('path');
const { pathToFileURL } = require('url');
const { test, expect } = require('@playwright/test');

const INDEX_URL = pathToFileURL(
  path.resolve(__dirname, '..', '..', 'src', 'renderer', 'index.html')
).href;

// base64url (no padding) of
//   {"url":"https://homepc.tail-abc.ts.net","token":"secret-token-123"}
const CONNECTION_CODE =
  'eyJ1cmwiOiJodHRwczovL2hvbWVwYy50YWlsLWFiYy50cy5uZXQiLCJ0b2tlbiI6InNlY3JldC10b2tlbi0xMjMifQ';
const EXPECTED_URL = 'https://homepc.tail-abc.ts.net';
const EXPECTED_TOKEN = 'secret-token-123';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    // Records every saveConfig payload so the test can assert on it.
    window.__savedConfigs = [];
    window.api = {
      // Unconfigured on launch -> the Settings modal auto-opens.
      getConfig: async () => ({
        serverUrl: '',
        emailMode: 'home',
        pageSize: 'Letter',
        hasToken: false,
        configPath: '/dev/null',
      }),
      getFullConfig: async () => ({
        serverUrl: '',
        hasToken: false,
        emailMode: 'home',
        pageSize: 'Letter',
        smtpUser: '',
        hasSmtpPassword: false,
      }),
      saveConfig: async (values) => {
        window.__savedConfigs.push(values);
        return {
          serverUrl: values.serverUrl || '',
          emailMode: values.emailMode || 'home',
          pageSize: values.pageSize || 'Letter',
          smtpUser: values.smtpUser || '',
          hasToken: Boolean(values.token),
          hasSmtpPassword: Boolean(values.smtpPassword),
          configPath: '/dev/null',
        };
      },
      onJobProgress: () => () => {},
      openServerAdmin: async () => {
        window.__adminOpened = (window.__adminOpened || 0) + 1;
        return { ok: true };
      },
    };
  });
  await page.goto(INDEX_URL);
});

test('Settings auto-opens unconfigured; Apply decodes the code and Save persists url+token', async ({
  page,
}) => {
  const modal = page.locator('#settings-modal');
  const codeInput = page.locator('#settings-code-input');
  const urlInput = page.locator('#settings-url-input');

  // Unconfigured launch auto-opens the modal with the welcome message.
  await expect(modal).toBeVisible();
  await expect(page.locator('#settings-welcome')).toBeVisible();

  // Paste the connection code and Apply -> the URL field is populated.
  await codeInput.fill(CONNECTION_CODE);
  await page.locator('#settings-apply-code-btn').click();
  await expect(urlInput).toHaveValue(EXPECTED_URL);

  // Save -> saveConfig receives the decoded url + token.
  await page.locator('#settings-save-btn').click();
  await expect(modal).toBeHidden();

  const saved = await page.evaluate(() => window.__savedConfigs);
  expect(saved).toHaveLength(1);
  expect(saved[0].serverUrl).toBe(EXPECTED_URL);
  expect(saved[0].token).toBe(EXPECTED_TOKEN);
});


test('the home server settings button is gated on being connected', async ({ page }) => {
  // The remote dashboard authenticates with the saved bearer token, so without
  // a server URL and a token the button would only ever open a 401.
  const adminBtn = page.locator('#settings-admin-btn');
  await expect(page.locator('#settings-modal')).toBeVisible();
  await expect(adminBtn).toBeDisabled();
  await expect(page.locator('#settings-admin-note')).toContainText('Connect to a home server first');

  // Pair the laptop, and it becomes available.
  await page.evaluate(() => {
    window.api.getFullConfig = async () => ({
      serverUrl: 'https://homepc.tail-abc.ts.net',
      hasToken: true,
      emailMode: 'home',
      pageSize: 'Letter',
      smtpUser: '',
      hasSmtpPassword: false,
    });
  });
  await page.locator('#settings-cancel-btn').click();
  await page.locator('#settings-btn').click();
  await expect(adminBtn).toBeEnabled();

  await adminBtn.click();
  expect(await page.evaluate(() => window.__adminOpened)).toBe(1);
});
