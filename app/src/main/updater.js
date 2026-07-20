'use strict';

// Auto-updates for the laptop app, served BY THE HOME SERVER (electron-updater
// "generic" provider pointed at <serverUrl>/updates/laptop with the bearer
// token as a request header). The home server is the update hub: it watches
// GitHub for new releases and caches the installer + latest.yml; the laptop
// never needs GitHub access or credentials.
//
// Behavior: check shortly after launch and every few hours; download in the
// background; notify the renderer when an update is ready ("Restart to
// update"); also auto-install on the next quit (autoInstallOnAppQuit). Every
// failure here is non-fatal and quiet — updates are a convenience, never a
// blocker. No-op in dev (unpackaged) builds.

const { app } = require('electron');
const { CHANNELS } = require('../shared/schema');
const config = require('./config');

const FIRST_CHECK_DELAY_MS = 20 * 1000;
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

let getWindow = null;
let checkTimer = null;
let started = false;

let state = {
  supported: false, // false in dev builds / when unconfigured
  checking: false,
  available: null, // version string once an update is known
  downloaded: null, // version string once ready to install
  error: null,
};

function send(payload) {
  const win = getWindow && getWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send(CHANNELS.APP_UPDATE, payload);
  }
}

function setState(patch) {
  state = { ...state, ...patch };
  send({ type: 'state', state });
}

function getState() {
  return state;
}

function autoUpdaterOrNull() {
  try {
    // Required lazily so a broken optional dependency can never stop boot.
    return require('electron-updater').autoUpdater;
  } catch {
    return null;
  }
}

function configureFeed() {
  const autoUpdater = autoUpdaterOrNull();
  if (!autoUpdater) return false;
  const cfg = config.get();
  if (!cfg.serverUrl || !cfg.bearerToken) {
    setState({ supported: false });
    return false;
  }
  autoUpdater.setFeedURL({
    provider: 'generic',
    url: `${cfg.serverUrl.replace(/\/$/, '')}/updates/laptop`,
  });
  autoUpdater.requestHeaders = { Authorization: `Bearer ${cfg.bearerToken}` };
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true; // updates apply even with no click
  autoUpdater.allowPrerelease = true; // our releases are marked pre-release
  setState({ supported: true });
  return true;
}

async function checkNow() {
  const autoUpdater = autoUpdaterOrNull();
  if (!autoUpdater || !app.isPackaged) return;
  if (!configureFeed()) return;
  try {
    setState({ checking: true, error: null });
    await autoUpdater.checkForUpdates();
  } catch (err) {
    // Common + expected: server offline, or it hasn't cached an update yet.
    setState({ error: (err && err.message) || String(err) });
  } finally {
    setState({ checking: false });
  }
}

function start(windowGetter) {
  getWindow = windowGetter;
  if (started) return;
  started = true;

  if (!app.isPackaged) {
    setState({ supported: false });
    return; // dev runs never self-update
  }
  const autoUpdater = autoUpdaterOrNull();
  if (!autoUpdater) return;

  autoUpdater.on('update-available', (info) => {
    setState({ available: (info && info.version) || 'unknown' });
  });
  autoUpdater.on('update-not-available', () => {
    // Keep `downloaded`: an already-downloaded update still installs on quit
    // (autoInstallOnAppQuit), so the "restart to update" offer must survive
    // a later feed check that reports nothing newer than the running version.
    setState({ available: null });
  });
  autoUpdater.on('update-downloaded', (info) => {
    setState({ downloaded: (info && info.version) || state.available || 'unknown' });
  });
  autoUpdater.on('error', (err) => {
    setState({ error: (err && err.message) || String(err) });
  });

  setTimeout(checkNow, FIRST_CHECK_DELAY_MS);
  checkTimer = setInterval(checkNow, CHECK_INTERVAL_MS);
}

/** Called from IPC when the user clicks "Restart to update". */
function installNow() {
  const autoUpdater = autoUpdaterOrNull();
  if (!autoUpdater || !state.downloaded) {
    return { ok: false, error: 'No downloaded update is ready yet.' };
  }
  // isSilent=true, isForceRunAfter=true: silent NSIS upgrade, relaunch after.
  setImmediate(() => autoUpdater.quitAndInstall(true, true));
  return { ok: true, error: null };
}

/** Reconfigure + recheck after the server URL/token changes. */
function onConfigChanged() {
  if (!app.isPackaged) return;
  checkNow();
}

function stop() {
  if (checkTimer) clearInterval(checkTimer);
  checkTimer = null;
}

module.exports = { start, stop, checkNow, installNow, getState, onConfigChanged };
