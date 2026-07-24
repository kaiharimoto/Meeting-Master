'use strict';

// Meeting Master — main process entry point.
//
// ONE app, TWO modes (chosen on first run, stored as APP_MODE in laptop.env):
//   operator – the meeting-capture UI (frameless shell, SSE monitoring, PDF)
//   server   – runs the bundled Python home server as a sidecar and shows its
//              dashboard; lives in the tray and starts at login
// No mode chosen yet → a small chooser window (mode.html) asks, then the app
// relaunches into the choice.

const path = require('path');
const fs = require('fs');
const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  desktopCapturer,
  dialog,
  screen,
  session,
  shell,
} = require('electron');
const { CHANNELS } = require('../shared/schema');
const { registerIpcHandlers } = require('./ipc');
const config = require('./config');
const sseClient = require('./sseClient');
const serverManager = require('./serverManager');
const paths = require('./paths');
const recorder = require('./recorder');
const updater = require('./updater');
const zoom = require('./zoom');
const permissions = require('./permissions');

let mainWindow = null;
let tray = null;

// ---- Single instance --------------------------------------------------------
// A second launch focuses (and un-hides, for the tray case) the existing window.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      mainWindow.show();
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

// ---- Titlebar overlay (Windows, operator mode) ------------------------------
// The operator renderer is frameless with a CSS drag strip; Windows draws its
// native window controls as an overlay whose colors we keep in sync with the
// theme. MM_NATIVE_FRAME=1 restores the stock frame (escape hatch).

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
    // Windows without an overlay (boot/chooser edge) — not fatal.
  }
}

// ---- Windows ----------------------------------------------------------------

function appIconPath() {
  // Packaged builds get the icon from the executable itself; this path serves
  // dev runs and Linux, where BrowserWindow needs an explicit image.
  const candidate = path.join(__dirname, '..', '..', 'build', 'icon.png');
  return fs.existsSync(candidate) ? candidate : undefined;
}

function rendererFile(name) {
  return path.join(__dirname, '..', 'renderer', name);
}

/** Operator mode: the full meeting-capture app (unchanged from v0.2.x). */
function createOperatorWindow() {
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

  mainWindow.loadFile(rendererFile('index.html'));
  zoom.attach(mainWindow);

  mainWindow.on('resize', saveBoundsDebounced);
  mainWindow.on('move', saveBoundsDebounced);

  // Closing mid-recording needs an explicit decision: everything captured so
  // far is already fsynced to disk, but a silent close would still surprise.
  mainWindow.on('close', (event) => {
    if (!recorder.isActive() || forceCloseWithRecording) return;
    event.preventDefault();
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      buttons: ['Keep recording', 'Stop recording and close'],
      defaultId: 0,
      cancelId: 0,
      title: 'Recording in progress',
      message: 'A meeting recording is running.',
      detail: 'Everything captured so far is already saved on disk.',
    });
    if (choice === 1) {
      forceCloseWithRecording = true;
      // Ask the renderer to run its normal stop path (flush + finalize +
      // attach); onRecordingStopped() below closes the window once done. If
      // the renderer never answers, abandon the session — it comes back as a
      // recoverable orphan on the next launch, nothing is lost.
      mainWindow.webContents.send(CHANNELS.REC_EVENT, { type: 'force-stop' });
      forceCloseTimer = setTimeout(() => {
        recorder.abandonActive();
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
      }, 4000);
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ---- Close-while-recording (operator window) --------------------------------

let forceCloseWithRecording = false;
let forceCloseTimer = null;

/** IPC hook: the renderer finished (or discarded) a recording session. */
function onRecordingStopped() {
  if (!forceCloseWithRecording) return;
  if (forceCloseTimer) {
    clearTimeout(forceCloseTimer);
    forceCloseTimer = null;
  }
  // Give the renderer a beat to persist the attachment to localStorage —
  // recStop resolves in the renderer only after this handler returns.
  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
  }, 250);
}

/** Options shared by the chooser and server windows (native frame — those
 *  pages have no CSS drag strip). */
function plainWindowOptions(extra) {
  return {
    backgroundColor: '#eef1f6',
    icon: appIconPath(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // the preload require()s ../shared/schema.js
    },
    ...extra,
  };
}

/** First run: the mode chooser. The choice relaunches the app (see ipc.js). */
function createChooserWindow() {
  mainWindow = new BrowserWindow(
    plainWindowOptions({ width: 860, height: 620, resizable: false })
  );
  mainWindow.loadFile(rendererFile('mode.html'));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/** Server mode: boot page while the sidecar starts, then the FULL meeting
 *  UI (index.html) — the dashboard lives inside it as a sidebar tab. Same
 *  chrome + preload as the operator window. */
function createServerWindow(startHidden) {
  const saved = loadBounds();
  mainWindow = new BrowserWindow({
    width: saved ? saved.width : 1150,
    height: saved ? saved.height : 820,
    minWidth: 900,
    minHeight: 650,
    show: !startHidden,
    backgroundColor: '#eef1f6',
    icon: appIconPath(),
    ...(useOverlay
      ? { titleBarStyle: 'hidden', titleBarOverlay: overlayForTheme('light') }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload require()s ../shared/schema.js
    },
  });

  mainWindow.loadFile(rendererFile('serverBoot.html'));
  zoom.attach(mainWindow);
  mainWindow.on('resize', saveBoundsDebounced);
  mainWindow.on('move', saveBoundsDebounced);

  // Dashboard buttons that need the APP (not the server): plain links to
  // /setup/action/* which we intercept here — the loopback page itself has
  // no IPC on purpose. A real browser hitting those URLs gets an info page.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (handleDashboardAction(url)) event.preventDefault();
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) =>
    handleDashboardAction(url) ? { action: 'deny' } : { action: 'allow' }
  );

  // Closing the window keeps the server running — the app lives in the tray.
  // Only when a tray actually exists: without one, a hidden window would be
  // an invisible, unquittable app, so let the close become a real quit.
  mainWindow.on('close', (event) => {
    if (!quitting && tray) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // A recreated window (tray → Open after a close) must sync to the CURRENT
  // sidecar state — no state transition is coming to do it for us.
  showingDashboard = false;
  syncServerWindowContent();
}

// ---- Server mode wiring -----------------------------------------------------

let quitting = false;
let showingDashboard = false;

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createServerWindow(false);
  } else {
    mainWindow.show();
    mainWindow.focus();
  }
}

async function installFromTray() {
  const result = await updater.installNow();
  if (result && !result.ok && result.error) {
    dialog.showErrorBox('Meeting Master', result.error);
  }
}

/** Dashboard action links (server-mode window only). Returns true when the
 *  URL was one of ours and the navigation should be swallowed. */
function handleDashboardAction(url) {
  let pathname;
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== '127.0.0.1') return false;
    pathname = parsed.pathname;
  } catch {
    return false;
  }
  if (pathname === '/setup/action/open-notes') {
    showMainWindow(); // the meeting UI IS the main window now
    return true;
  }
  if (pathname === '/setup/action/app-update') {
    if (updater.getState().downloaded) installFromTray();
    else checkForUpdatesFromTray();
    return true;
  }
  return false;
}

let updateCheckRunning = false;
/** One click, whole chain: make the SIDECAR fetch/cache the newest GitHub
 *  release, then make the APP check the freshly-updated loopback feed. This
 *  is the "update NOW" path — without it the two update stages only meet on
 *  their timers and an eager operator sees "not updating". */
async function checkForUpdatesFromTray() {
  if (updateCheckRunning) return;
  updateCheckRunning = true;
  try {
    const base = `http://127.0.0.1:${serverManager.serverPort()}`;
    try {
      await fetch(`${base}/setup/install/update-check`, { method: 'POST' });
      // Wait (bounded) for the sidecar's GitHub check/download to finish.
      const deadline = Date.now() + 3 * 60 * 1000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 3000));
        const state = await (await fetch(`${base}/setup/state`)).json();
        const task = (state.tasks || {})['update-check'];
        if (!task || task.state !== 'running') break;
      }
    } catch {
      // Sidecar unreachable — the app-side check below still tells the truth.
    }
    await updater.checkNow();
    const s = updater.getState();
    if (s.downloaded) return; // the tray item + tooltip already offer the restart
    dialog.showMessageBox({
      type: 'info',
      title: 'Meeting Master',
      message: s.available
        ? `Update v${s.available} found — downloading now. The tray shows "Restart to update" when it's ready.`
        : s.error
          ? `Update check failed: ${s.error}`
          : `You're up to date (v${app.getVersion()}).`,
    });
  } finally {
    updateCheckRunning = false;
  }
}

function refreshTray() {
  if (!tray) return;
  const updateReady = Boolean(updater.getState().downloaded);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Meeting Master', click: showMainWindow },
      {
        label: 'Open dashboard in browser',
        click: () => shell.openExternal(serverManager.dashboardUrl()),
      },
      {
        label: 'Open data & settings folder',
        click: () => shell.openPath(serverManager.configHome()),
      },
      { type: 'separator' },
      { label: 'Check for updates now', click: checkForUpdatesFromTray },
      ...(updateReady
        ? [{ label: `Restart to update (v${updater.getState().downloaded})`, click: installFromTray }]
        : []),
      {
        label: 'Quit',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ])
  );
  tray.setToolTip(
    updateReady ? 'Meeting Master — update ready (restart to apply)' : 'Meeting Master — home server'
  );
}

function createTray() {
  const icon = appIconPath();
  if (!icon) return; // packaged builds always have it; dev without icons skips the tray
  try {
    tray = new Tray(icon);
    tray.on('click', showMainWindow);
    refreshTray();
    updater.subscribe(refreshTray);
  } catch {
    tray = null; // headless/dev environments without a tray — window still works
  }
}

/** Swap window content between the boot page (starting/failed/conflict/
 *  stopped) and the live dashboard, based on the CURRENT sidecar state.
 *  Driven from state emissions, window (re)creation, and its own retry
 *  timer — never from emissions alone, so a recreated window or a failed
 *  dashboard load can always converge instead of wedging on the boot page. */
let dashboardRetryTimer = null;
function syncServerWindowContent() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const s = serverManager.getState().state;
  const up = s === 'running' || s === 'external';
  if (up && !showingDashboard) {
    showingDashboard = true;
    // The one window: full meeting UI with the dashboard as a sidebar tab.
    mainWindow.loadFile(rendererFile('index.html'));
  } else if (!up && showingDashboard) {
    showingDashboard = false;
    mainWindow.loadFile(rendererFile('serverBoot.html'));
  }
}

let sidecarWasUp = false;
function wireSidecarToWindow() {
  serverManager.onState((state) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(CHANNELS.SIDECAR_STATE, state);
    }
    syncServerWindowContent();

    // The moment the sidecar first comes up, its update feed (and bearer
    // token in server.env) exists — don't wait 4 h for the next timer check.
    const up = state.state === 'running' || state.state === 'external';
    if (up && !sidecarWasUp) updater.onConfigChanged();
    sidecarWasUp = up;
  });
}

function startServerMode(startHidden) {
  createServerWindow(startHidden);
  createTray();
  wireSidecarToWindow();
  serverManager.start();

  // Live events for the notes studio (config.get() resolves the local
  // sidecar's URL/token in server mode, so this streams from ourselves).
  sseClient.start(activeWindow);

  // Updates come from the sidecar's own loopback feed; the tray offers the
  // restart, and quitting installs automatically (autoInstallOnAppQuit).
  updater.start(() => mainWindow);

  if (app.isPackaged) {
    // An always-on home server should survive reboots without a manual launch.
    app.setLoginItemSettings({ openAtLogin: true, args: ['--tray-start'] });
  }
}

/** The window renderer-facing IPC talks to (kept as a getter — the window
 *  can be recreated from the tray). */
function activeWindow() {
  return mainWindow;
}

function startOperatorMode() {
  createOperatorWindow();

  // Live server events (SSE) + reachability probing, relayed to the renderer.
  sseClient.start(() => mainWindow);

  // Auto-updates, fetched from the home server (no-op in dev builds).
  updater.start(() => mainWindow);

  if (app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: false });
  }
}

// ---- App lifecycle ----------------------------------------------------------

app.whenReady().then(() => {
  // No application menu in packaged builds (the app is fully mouse/keyboard
  // driven); keep the default menu in dev for DevTools access.
  if (app.isPackaged) Menu.setApplicationMenu(null);

  // Move any bundled/legacy fonts into the update-proof user dir (see paths.js).
  paths.migrateFonts();

  // Web permissions for OUR file:// pages only (see permissions.js for the
  // allowlist and why it must stay complete).
  const senderUrl = (webContents) =>
    (webContents && !webContents.isDestroyed() && webContents.getURL()) || '';

  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(permissions.isAllowed(permission, { url: senderUrl(webContents) }));
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin) =>
    permissions.isAllowed(permission, {
      url: senderUrl(webContents),
      origin: requestingOrigin,
    })
  );

  // System-audio (loopback) capture for the "also record computer audio"
  // option — Windows-only in Electron/Chromium. getDisplayMedia requires a
  // video source even for audio-only use; the renderer stops the video track
  // immediately and mixes only the audio into the recording bus.
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    const url = (request && request.frame && request.frame.url) || '';
    if (!url.startsWith('file:') || process.platform !== 'win32') {
      callback(null); // deny — dashboard pages and non-Windows never capture
      return;
    }
    desktopCapturer
      .getSources({ types: ['screen'] })
      .then((sources) => {
        if (!sources.length) {
          callback(null);
          return;
        }
        callback({ video: sources[0], audio: 'loopback' });
      })
      .catch(() => callback(null));
  });

  // Handlers need a live window reference for dialogs and progress events,
  // so hand them a getter instead of the (possibly recreated) window itself.
  // activeWindow prefers the notes studio when it is open (server mode).
  registerIpcHandlers(activeWindow, { setOverlayTheme, onRecordingStopped });

  // Smart zoom: auto factor follows display changes (docking, projectors).
  zoom.init(() => (mainWindow && !mainWindow.isDestroyed() ? [mainWindow] : []));

  const resolved = config.resolveMode();
  if (resolved === 'server') {
    startServerMode(process.argv.includes('--tray-start'));
  } else if (resolved === 'operator') {
    startOperatorMode();
  } else {
    createChooserWindow();
  }

  app.on('activate', () => {
    // macOS convention; harmless elsewhere.
    if (BrowserWindow.getAllWindows().length === 0) {
      const m = config.resolveMode();
      if (m === 'server') createServerWindow(false);
      else if (m === 'operator') createOperatorWindow();
      else createChooserWindow();
    }
  });
});

app.on('before-quit', () => {
  quitting = true;
  // A still-open recording session becomes a recoverable orphan (finalized
  // stays false); the next launch offers to attach it.
  recorder.abandonActive();
  sseClient.stop();
  // Fire-and-forget: TerminateProcess is effectively instant, and the NSIS
  // installer (autoInstallOnAppQuit) takes seconds to initialize — the
  // explicit "Restart to update" path awaits a full stop() first anyway.
  serverManager.kill();
});

// Operator/chooser: quit when the last window closes (Windows is the target
// platform; we use this everywhere, including macOS dev machines).
// Server mode: the window hides to the tray instead, so this only fires on a
// real quit — unless there IS no tray, in which case closing must quit.
app.on('window-all-closed', () => {
  if (config.resolveMode() !== 'server' || quitting || !tray) {
    app.quit();
  }
});
