'use strict';

// The meeting progress map's own window: tall, narrow, always on top.
//
// Shaped for where it actually sits — beside a slide deck or a call, on a
// second screen, glanced at rather than read. Hence portrait, hence
// always-on-top, hence its own window rather than a panel inside the operator
// window that would be behind the thing being presented.
//
// Modelled on miniManager.js, with three deliberate differences:
//
//   * It is RESIZABLE and remembers its bounds. The mini strip is a fixed
//     300x84 remote control; this is something the operator arranges once
//     against their own screen layout and expects to find there next time.
//   * It does NOT close when recording stops. The strip's job ends with the
//     recording; the map's does not — the minute after a meeting ends is
//     exactly when someone wants to read what it turned into.
//   * Opening it does not minimize the operator window. The two are meant to be
//     on screen together.
//
// It must close when the OPERATOR window closes, though, and that is not a
// nicety: app.on('window-all-closed') only quits when the last window goes, so
// an always-on-top map left behind would keep the whole app alive — with its
// live loop still asking the home server about a meeting that ended.

const path = require('path');
const { BrowserWindow, screen } = require('electron');

let mapWindow = null;

function isOpen() {
  return Boolean(mapWindow && !mapWindow.isDestroyed());
}

/** The window itself, for the broadcast emitter in ipc.js. Never stored. */
function get() {
  return isOpen() ? mapWindow : null;
}

function open({ loadBounds, saveBounds } = {}) {
  if (isOpen()) {
    mapWindow.focus();
    return { ok: true };
  }
  const { workArea } = screen.getPrimaryDisplay();
  const saved = typeof loadBounds === 'function' ? loadBounds('map') : null;
  // Portrait by default, parked against the right edge — out of the way of
  // whatever is being presented, which is nearly always landscape and centred.
  const width = saved ? saved.width : 440;
  const height = saved ? saved.height : Math.max(600, workArea.height - 80);

  mapWindow = new BrowserWindow({
    width,
    height,
    x: saved && typeof saved.x === 'number'
      ? saved.x
      : workArea.x + workArea.width - width - 24,
    y: saved && typeof saved.y === 'number' ? saved.y : workArea.y + 24,
    minWidth: 320,
    minHeight: 400,
    frame: false,
    resizable: true,
    maximizable: false,
    alwaysOnTop: true,
    skipTaskbar: false, // unlike the mini strip: this one is a window you find
    backgroundColor: '#0b0d13',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload require()s ../shared/schema.js
    },
  });

  mapWindow.loadFile(path.join(__dirname, '..', 'renderer', 'map.html'));
  if (typeof saveBounds === 'function') {
    const remember = () => saveBounds('map', mapWindow);
    mapWindow.on('resize', remember);
    mapWindow.on('move', remember);
  }
  mapWindow.on('closed', () => {
    mapWindow = null;
  });
  return { ok: true };
}

function close() {
  if (isOpen()) mapWindow.close();
}

/** Always-on-top is a toggle, not a fact: it is in the way while you type into
 *  the operator window, and the point of the thing while you present. */
function setPinned(pinned) {
  if (!isOpen()) return { ok: false, pinned: false };
  mapWindow.setAlwaysOnTop(Boolean(pinned));
  return { ok: true, pinned: Boolean(pinned) };
}

function isPinned() {
  return isOpen() ? mapWindow.isAlwaysOnTop() : false;
}

/** Map state from liveMap -> the window. No-op while it is closed, which is the
 *  normal case: the map keeps building whether anyone is watching or not. */
function forwardState(channel, payload) {
  if (!isOpen()) return;
  mapWindow.webContents.send(channel, payload);
}

module.exports = { open, close, isOpen, get, setPinned, isPinned, forwardState };
