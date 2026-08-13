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
const serverManager = require('./serverManager');

const FIRST_CHECK_DELAY_MS = 20 * 1000;
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
// Server mode polls its OWN sidecar's loopback feed (a 355-byte yml) — check
// often, so a release the sidecar just cached installs within minutes, not
// hours ("it's not updating" field report, v0.3.0).
const SERVER_CHECK_INTERVAL_MS = 15 * 60 * 1000;

let getWindow = null;
let checkTimer = null;
let started = false;
const subscribers = new Set(); // main-process listeners (tray menu refresh)

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
  for (const cb of subscribers) {
    try {
      cb(state);
    } catch {
      // Listeners must never break update handling.
    }
  }
}

/** Main-process subscription to state changes (the renderer uses onAppUpdate);
 *  returns an unsubscribe fn. */
function subscribe(cb) {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
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

// Why the feed cannot be polled, in words the operator can act on — or null
// when it can. This is deliberately a MESSAGE and not a boolean: "the feed
// isn't configured" used to be indistinguishable from "no update exists", and
// the tray then cheerfully reported "You're up to date (v0.19.3)" to someone
// staring at a dashboard that said v0.20.0 was waiting. An update check that
// could not run must never be reported as an update check that found nothing.
function feedProblem(cfg) {
  if (config.resolveMode(cfg) === 'server') {
    if (!serverManager.serverBearerToken()) {
      // The token is minted by the dashboard's "Save & Finish" (setup/routes
      // save()), and the feed is bearer-gated, so an unfinished setup cannot
      // self-update at all.
      return (
        'This server has not finished setup, so it has no access token yet — ' +
        'and the update feed needs one. Open the Settings tab on the ' +
        'dashboard and click "Save & Finish", then check again.'
      );
    }
    return null;
  }
  if (!cfg.serverUrl || !cfg.bearerToken) {
    return 'No home server is configured yet — add its address and token in Settings, then check again.';
  }
  return null;
}

function feedConfig() {
  const cfg = config.get();
  if (feedProblem(cfg)) return null;
  if (config.resolveMode(cfg) === 'server') {
    // Server mode: this machine IS the update hub. The sidecar watches GitHub
    // and caches releases; we update from its own loopback feed, using the
    // server's bearer token (read from the shared config home).
    return {
      url: `http://127.0.0.1:${serverManager.serverPort()}/updates/laptop`,
      token: serverManager.serverBearerToken(),
    };
  }
  return { url: `${cfg.serverUrl.replace(/\/$/, '')}/updates/laptop`, token: cfg.bearerToken };
}

function configureFeed() {
  const autoUpdater = autoUpdaterOrNull();
  if (!autoUpdater) {
    setState({ supported: false, error: 'This build has no updater component.' });
    return false;
  }
  const problem = feedProblem(config.get());
  if (problem) {
    setState({ supported: false, error: problem });
    return false;
  }
  const feed = feedConfig();
  autoUpdater.setFeedURL({ provider: 'generic', url: feed.url });
  autoUpdater.requestHeaders = { Authorization: `Bearer ${feed.token}` };
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true; // updates apply even with no click
  autoUpdater.allowPrerelease = true; // our releases are marked pre-release
  setState({ supported: true, error: null });
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
    // Carries its reason like every other unsupported state: "no update" and
    // "never looked" must stay tellable apart wherever this is read.
    setState({ supported: false, error: 'Development builds do not self-update.' });
    return;
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
  const interval =
    config.resolveMode() === 'server' ? SERVER_CHECK_INTERVAL_MS : CHECK_INTERVAL_MS;
  checkTimer = setInterval(checkNow, interval);
}

/** Called from IPC / the tray when the user clicks "Restart to update". */
async function installNow() {
  const autoUpdater = autoUpdaterOrNull();
  if (!autoUpdater || !state.downloaded) {
    return { ok: false, error: 'No downloaded update is ready yet.' };
  }
  const serverMode = config.resolveMode() === 'server';
  if (serverMode) {
    // A server we merely adopted (or a conflicting old install) is not ours
    // to stop — its exe would stay loaded from resources/server and wreck
    // the silent NSIS upgrade.
    const sidecar = serverManager.getState().state;
    if (sidecar === 'external' || sidecar === 'conflict') {
      return {
        ok: false,
        error:
          'Another server instance is running outside this app — close it (or reboot), then try again.',
      };
    }
    // Mirror the old standalone guard: never yank the server mid-meeting.
    const busy = await serverManager.activeJobCount();
    if (busy > 0) {
      return {
        ok: false,
        error: `${busy} job(s) still processing — try again when the pipeline is idle.`,
      };
    }
  }
  setImmediate(async () => {
    // Server mode: stop the sidecar FIRST so the installer never finds its
    // files in use (the NSIS installer only knows how to wait for OUR exe).
    if (serverMode) {
      await serverManager.stop();
    }
    // isSilent=true, isForceRunAfter=true: silent NSIS upgrade, relaunch after.
    autoUpdater.quitAndInstall(true, true);
  });
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

module.exports = { start, stop, checkNow, installNow, getState, onConfigChanged, subscribe };
