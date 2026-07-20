'use strict';

// Meeting Master — main process entry point.
// Creates the single app window (frameless with native controls overlay on
// Windows), restores its last bounds, and registers all IPC handlers.

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, Menu, screen } = require('electron');
const { registerIpcHandlers } = require('./ipc');
const sseClient = require('./sseClient');
const paths = require('./paths');
const updater = require('./updater');

let mainWindow = null;

// ---- Single instance --------------------------------------------------------
// A second launch focuses the existing window instead of opening a duplicate.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// ---- Window-bounds persistence ---------------------------------------------

function boundsPath() {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function loadBounds() {
  try {
    const saved = JSON.parse(fs.readFileSync(boundsPath(), 'utf8'));
    if (!saved || typeof saved.width !== 'number' || typeof saved.height !== 'number') {
      return null;
    }
    // Only restore a position that is still on a connected display —
    // otherwise the window could open off-screen after a monitor change.
    if (typeof saved.x === 'number' && typeof saved.y === 'number') {
      const onScreen = screen.getAllDisplays().some(({ workArea }) =>
        saved.x < workArea.x + workArea.width &&
        saved.x + saved.width > workArea.x &&
        saved.y < workArea.y + workArea.height &&
        saved.y + saved.height > workArea.y
      );
      if (!onScreen) {
        delete saved.x;
        delete saved.y;
      }
    }
    return saved;
  } catch {
    return null;
  }
}

let saveTimer = null;
function saveBoundsDebounced() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
    try {
      fs.writeFileSync(boundsPath(), JSON.stringify(mainWindow.getNormalBounds()));
    } catch {
      // Bounds persistence is a nicety — never let it throw.
    }
  }, 400);
}

// ---- Titlebar overlay (Windows) --------------------------------------------
// The renderer is frameless with a CSS drag strip; Windows draws its native
// window controls as an overlay whose colors we keep in sync with the theme.
// MM_NATIVE_FRAME=1 restores the stock frame (escape hatch).

const useOverlay = process.platform === 'win32' && process.env.MM_NATIVE_FRAME !== '1';

const OVERLAY_COLORS = {
  light: { color: '#e6eaf1', symbolColor: '#57606d', height: 40 },
  dark: { color: '#0b0d13', symbolColor: '#9aa4b2', height: 40 },
};

function overlayForTheme(theme) {
  return OVERLAY_COLORS[theme === 'dark' ? 'dark' : 'light'];
}

/** Called from IPC when the renderer's theme changes. */
function setOverlayTheme(theme) {
  if (!useOverlay || !mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.setTitleBarOverlay(overlayForTheme(theme));
  } catch {
    // Not fatal — the overlay just keeps its previous colors.
  }
}

// ---- Window ----------------------------------------------------------------

function appIconPath() {
  // Packaged builds get the icon from the executable itself; this path serves
  // dev runs and Linux, where BrowserWindow needs an explicit image.
  const candidate = path.join(__dirname, '..', '..', 'build', 'icon.png');
  return fs.existsSync(candidate) ? candidate : undefined;
}

function createWindow() {
  const saved = loadBounds();
  mainWindow = new BrowserWindow({
    width: saved ? saved.width : 1150,
    height: saved ? saved.height : 820,
    x: saved && typeof saved.x === 'number' ? saved.x : undefined,
    y: saved && typeof saved.y === 'number' ? saved.y : undefined,
    minWidth: 900,
    minHeight: 650,
    backgroundColor: '#eef1f6',
    icon: appIconPath(),
    ...(useOverlay
      ? { titleBarStyle: 'hidden', titleBarOverlay: overlayForTheme('light') }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // sandbox must stay off for THIS window only: the preload script
      // require()s ../shared/schema.js, which a sandboxed preload cannot do
      // (sandboxed preloads only get a bundled subset of Node built-ins).
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.on('resize', saveBoundsDebounced);
  mainWindow.on('move', saveBoundsDebounced);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  // No application menu in packaged builds (the app is fully mouse/keyboard
  // driven); keep the default menu in dev for DevTools access.
  if (app.isPackaged) Menu.setApplicationMenu(null);

  // Move any bundled/legacy fonts into the update-proof user dir (see paths.js).
  paths.migrateFonts();

  // Handlers need a live window reference for dialogs and progress events,
  // so hand them a getter instead of the (possibly recreated) window itself.
  registerIpcHandlers(() => mainWindow, { setOverlayTheme });
  createWindow();

  // Live server events (SSE) + reachability probing, relayed to the renderer.
  sseClient.start(() => mainWindow);

  // Auto-updates, fetched from the home server (no-op in dev builds).
  updater.start(() => mainWindow);

  app.on('activate', () => {
    // macOS convention; harmless elsewhere.
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  sseClient.stop();
});

// Windows is the target platform: quit when the last window closes.
// We deliberately use this behavior everywhere (including macOS dev machines).
app.on('window-all-closed', () => {
  app.quit();
});
