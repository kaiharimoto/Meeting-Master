'use strict';

// Mini mode: a compact always-on-top recording strip (mini.html) so the full
// window can be minimized in a meeting room. The MediaRecorder lives in the
// MAIN window's renderer, so the mini window is a remote control:
//
//   mini buttons  → MINI_CMD  → main → relayed to the main renderer
//   recorder tick → MINI_STATUS → main → relayed to the mini window (MINI_STATE)
//
// Opening the strip minimizes the main window; closing it (or the recording
// ending) restores it.

const path = require('path');
const { BrowserWindow, screen } = require('electron');

let miniWindow = null;

function isOpen() {
  return Boolean(miniWindow && !miniWindow.isDestroyed());
}

function open(getMainWindow) {
  if (isOpen()) {
    miniWindow.focus();
    return { ok: true };
  }
  const main = getMainWindow();
  const { workArea } = screen.getPrimaryDisplay();
  miniWindow = new BrowserWindow({
    width: 300,
    height: 84,
    x: workArea.x + workArea.width - 320,
    y: workArea.y + 16,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    alwaysOnTop: true,
    skipTaskbar: true, // the main window (minimized) keeps the taskbar entry
    backgroundColor: '#0b0d13',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload require()s ../shared/schema.js
    },
  });
  miniWindow.loadFile(path.join(__dirname, '..', 'renderer', 'mini.html'));
  miniWindow.on('closed', () => {
    miniWindow = null;
    restore(getMainWindow); // closing the strip always brings the app back
  });
  if (main && !main.isDestroyed()) main.minimize();
  return { ok: true };
}

function close() {
  if (isOpen()) miniWindow.close(); // 'closed' handler restores the main window
}

function restore(getMainWindow) {
  const main = getMainWindow();
  if (main && !main.isDestroyed()) {
    main.restore();
    main.show();
    main.focus();
  }
}

/** Recorder status from the main renderer → the strip (and lifecycle). */
function forwardStatus(payload, getMainWindow) {
  if (!isOpen()) return;
  if (payload && payload.status === 'idle') {
    // Recording ended (stop/discard) — the strip's job is done.
    close();
    return;
  }
  miniWindow.webContents.send(require('../shared/schema').CHANNELS.MINI_STATE, payload);
}

module.exports = { open, close, isOpen, restore, forwardStatus };
