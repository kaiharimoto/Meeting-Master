'use strict';

// The home server's own dashboard, opened from the laptop over Tailscale.
//
// WHY A WINDOW AND NOT A FORM IN THE RENDERER. The server already has a
// settings UI — ~250 lines of form markup plus the save/validate/render logic
// in dashboard.js — and it is stated in four docstrings that the dashboard is
// the ONE place this is configured. Rebuilding it here would make two copies
// that drift the first time a field is added, and this very release adds
// fields. Instead the server serves that same page at a second, bearer-gated
// mount (/admin, see server/app/routes/admin.py) and this window loads it.
//
// SECURITY, and every line of it matters:
//
//   * The bearer token is attached by onBeforeSendHeaders, in the MAIN
//     process. It never enters a renderer JS context, which is the same
//     invariant ipc.js keeps for every other credential in this app. A page
//     fetched over the network must never be able to read it.
//   * NO preload. `window.api` is for our own file:// pages. Handing it to a
//     remote document would give the server's HTML the whole IPC surface.
//   * contextIsolation on, nodeIntegration off, sandbox on — the defaults we
//     want, stated rather than assumed, because this is the only window in the
//     app that loads a document over HTTP.
//   * A non-persistent partition, so nothing from this origin outlives the
//     window.
//   * Navigation is pinned to the server's origin and the /admin prefix.
//     Anything else opens in the real browser instead. Without this, one bad
//     link in the served page navigates a token-injecting window somewhere it
//     shouldn't go — and the header filter below is scoped to the same prefix
//     so the token cannot ride along even if navigation were bypassed.

const { BrowserWindow, session, shell } = require('electron');
const config = require('./config');

let adminWindow = null;

function isOpen() {
  return Boolean(adminWindow && !adminWindow.isDestroyed());
}

/** The /admin URL and origin for the configured home server. */
function target() {
  const cfg = config.get();
  const base = (cfg.serverUrl || '').replace(/\/+$/, '');
  if (!base) {
    throw new Error('No home server is configured — paste a connection code in Settings first.');
  }
  if (!cfg.bearerToken) {
    throw new Error('No bearer token is saved — paste the connection code again in Settings.');
  }
  let origin;
  try {
    origin = new URL(base).origin;
  } catch {
    throw new Error(`The saved home server URL is not a valid URL: ${base}`);
  }
  return { url: `${base}/admin`, origin, token: cfg.bearerToken };
}

function open(getMainWindow) {
  if (isOpen()) {
    adminWindow.focus();
    return { ok: true };
  }

  const { url, origin, token } = target();

  // Non-persistent: the session dies with the window, so no cookie or cache
  // from the server's origin is left on the laptop.
  const ses = session.fromPartition('mm-admin');

  // Scoped to the admin prefix on THIS origin. A filter matching every URL
  // would attach the home server's token to any request the page managed to
  // make elsewhere, so the narrow pattern is the security control here.
  ses.webRequest.onBeforeSendHeaders(
    { urls: [`${origin}/admin*`] },
    (details, callback) => {
      callback({
        requestHeaders: { ...details.requestHeaders, Authorization: `Bearer ${token}` },
      });
    }
  );

  const parent = typeof getMainWindow === 'function' ? getMainWindow() : null;
  adminWindow = new BrowserWindow({
    width: 1100,
    height: 860,
    minWidth: 720,
    minHeight: 520,
    parent: parent && !parent.isDestroyed() ? parent : undefined,
    title: 'Home server settings',
    autoHideMenuBar: true,
    backgroundColor: '#0b0d13',
    webPreferences: {
      session: ses,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Deliberately no preload — see the header comment.
    },
  });

  const allowed = (candidate) => {
    try {
      const parsed = new URL(candidate);
      return parsed.origin === origin && parsed.pathname.startsWith('/admin');
    } catch {
      return false;
    }
  };

  adminWindow.webContents.on('will-navigate', (event, candidate) => {
    if (!allowed(candidate)) {
      event.preventDefault();
      shell.openExternal(candidate).catch(() => {});
    }
  });

  adminWindow.webContents.setWindowOpenHandler(({ url: candidate }) => {
    if (!allowed(candidate)) shell.openExternal(candidate).catch(() => {});
    return { action: 'deny' };
  });

  adminWindow.on('closed', () => {
    adminWindow = null;
  });

  adminWindow.loadURL(url);
  return { ok: true };
}

function close() {
  if (isOpen()) adminWindow.close();
}

module.exports = { open, close, isOpen, target };
