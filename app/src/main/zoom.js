'use strict';

// Smart UI zoom.
//
// Auto mode (default, UI_ZOOM empty) picks a zoom factor from the display
// the window currently sits on: big desktop monitors and projectors get
// larger text, laptop-scale displays stay at 100%. Physical size isn't
// exposed by the OS, so effective DIP width is the best available signal —
// a 1920-DIP display is either a big monitor at 100% scaling or a projector,
// and both want bigger text.
//
// Manual mode: Ctrl+= / Ctrl+- nudge and persist a fixed factor (UI_ZOOM in
// laptop.env, also settable in Settings); Ctrl+0 clears back to auto.

const { screen } = require('electron');
const config = require('./config');

const STEP = 0.05;
const MIN = 0.8;
const MAX = 1.5;

function autoFactorFor(win) {
  try {
    const display = screen.getDisplayMatching(win.getBounds());
    const width = display.workAreaSize.width; // DIP
    if (width >= 3000) return 1.25;
    if (width >= 1900) return 1.1;
    if (width >= 1600) return 1.05;
    return 1.0;
  } catch {
    return 1.0;
  }
}

function apply(win) {
  if (!win || win.isDestroyed()) return;
  const manual = Number(config.get().uiZoom);
  const factor = manual && manual >= MIN && manual <= MAX ? manual : autoFactorFor(win);
  win.webContents.setZoomFactor(factor);
}

function bump(win, delta) {
  const current = win.webContents.getZoomFactor();
  const next = Math.min(MAX, Math.max(MIN, Math.round((current + delta) * 100) / 100));
  config.save({ uiZoom: String(next) });
  win.webContents.setZoomFactor(next);
}

/** Wire a window: apply on load, re-derive on display moves (auto mode),
 *  and handle the Ctrl+= / Ctrl+- / Ctrl+0 shortcuts. */
function attach(win) {
  win.webContents.on('did-finish-load', () => apply(win));

  let moveTimer = null;
  win.on('move', () => {
    if (moveTimer) clearTimeout(moveTimer);
    moveTimer = setTimeout(() => {
      moveTimer = null;
      if (!config.get().uiZoom) apply(win); // auto follows the display
    }, 300);
  });

  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !input.control || input.alt || input.meta) return;
    if (input.key === '=' || input.key === '+') {
      event.preventDefault();
      bump(win, +STEP);
    } else if (input.key === '-') {
      event.preventDefault();
      bump(win, -STEP);
    } else if (input.key === '0') {
      event.preventDefault();
      config.save({ uiZoom: '' }); // back to auto
      apply(win);
    }
  });
}

/** Monitor changes (docking, projector plug-in) re-derive auto zoom. */
function init(getWindows) {
  const reapply = () => {
    if (config.get().uiZoom) return; // manual zoom is display-independent
    for (const win of getWindows()) apply(win);
  };
  screen.on('display-metrics-changed', reapply);
  screen.on('display-added', reapply);
  screen.on('display-removed', reapply);
}

module.exports = { attach, apply, init };
