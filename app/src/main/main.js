'use strict';

// Meeting Master — main process entry point.
// Creates the single app window and registers all IPC handlers.

const path = require('path');
const { app, BrowserWindow } = require('electron');
const { registerIpcHandlers } = require('./ipc');

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1150,
    height: 820,
    minWidth: 900,
    minHeight: 650,
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

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  // Handlers need a live window reference for dialogs and progress events,
  // so hand them a getter instead of the (possibly recreated) window itself.
  registerIpcHandlers(() => mainWindow);
  createWindow();

  app.on('activate', () => {
    // macOS convention; harmless elsewhere.
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Windows is the target platform: quit when the last window closes.
// We deliberately use this behavior everywhere (including macOS dev machines).
app.on('window-all-closed', () => {
  app.quit();
});
