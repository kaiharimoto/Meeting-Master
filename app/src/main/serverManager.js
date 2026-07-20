'use strict';

// Home-server mode: owns the bundled Python server ("sidecar").
//
// The unified installer ships the PyInstaller onedir server under
// resources/server/. In server mode this module spawns it with MM_SIDECAR=1
// (which tells the Python side to skip its own tray/browser/self-update),
// waits for /health, and keeps it alive with a bounded crash-restart loop.
// The Electron window then just shows the server's own dashboard.
//
// The sidecar reads the SAME config home the standalone server always used
// (%APPDATA%\MeetingMaster), so a machine migrating from the old
// MeetingMaster-HomeServer install keeps its settings, data and models.
//
// States surfaced to the boot page / tray:
//   starting  – spawned, waiting for /health
//   running   – healthy, dashboard is loadable
//   external  – something is already serving OUR version on the port
//               (typically a dev `python -m app.main`) — adopt it, don't spawn
//   conflict  – a DIFFERENT version is already on the port (usually the old
//               standalone Home Server install) — tell the operator to
//               uninstall it, never fight over the port
//   failed    – spawn/health/crash-loop failure; Retry available
//   stopped   – not started (operator mode) or shut down for quit/update

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { app } = require('electron');

const HEALTH_TIMEOUT_MS = 2500;
const START_DEADLINE_MS = 45 * 1000; // whisper models are NOT loaded on boot; 45s is generous
const MAX_RESTARTS = 3;
const RESTART_DELAYS_MS = [2000, 5000, 10000];

let child = null;
let stopping = false;
let restarts = 0;
let restartTimer = null;
let state = { state: 'stopped', message: '', port: 8080, url: '', version: null };
const listeners = new Set();

// ---- Config home (mirrors server/app/config.py:config_home) -----------------

function configHome() {
  const override = process.env.MEETING_MASTER_HOME;
  if (override) return override;
  if (process.platform === 'win32') {
    const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(base, 'MeetingMaster');
  }
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'MeetingMaster');
}

function readServerEnv() {
  try {
    const text = fs.readFileSync(path.join(configHome(), 'server.env'), 'utf8');
    const values = {};
    for (const rawLine of String(text).split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      values[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
    return values;
  } catch {
    return {};
  }
}

function serverPort() {
  const parsed = parseInt(readServerEnv().SERVER_PORT, 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : 8080;
}

/** The server's own bearer token — used by the updater to fetch the localhost
 *  update feed in server mode. Empty until the server is configured. */
function serverBearerToken() {
  return readServerEnv().BEARER_TOKEN || '';
}

function dashboardUrl() {
  return `http://127.0.0.1:${state.port}/setup`;
}

function serverLogPath() {
  return path.join(configHome(), 'server.log');
}

// ---- State ------------------------------------------------------------------

function setState(patch) {
  state = { ...state, ...patch, url: '' };
  state.url = dashboardUrl();
  for (const cb of listeners) {
    try {
      cb(state);
    } catch {
      // A broken listener must never take the manager down.
    }
  }
}

function getState() {
  return state;
}

/** Subscribe to state changes; returns an unsubscribe fn. */
function onState(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

// ---- Health probe -----------------------------------------------------------

async function probeHealth(port) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal });
    if (!resp.ok) return null;
    const body = await resp.json().catch(() => ({}));
    return { version: typeof body.version === 'string' ? body.version : null };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---- Sidecar location -------------------------------------------------------

function bundledSidecarExe() {
  const exe = process.platform === 'win32' ? 'MeetingMasterServer.exe' : 'MeetingMasterServer';
  return path.join(process.resourcesPath, 'server', exe);
}

/** How to launch the server: the bundled exe when packaged, or the dev
 *  checkout's Python (server/.venv or python3) when running from source. */
function launchSpec() {
  if (app.isPackaged) {
    const exe = bundledSidecarExe();
    if (!fs.existsSync(exe)) {
      return { error: 'The bundled home server is missing from this install (resources/server). Reinstall Meeting Master.' };
    }
    return { command: exe, args: [], cwd: path.dirname(exe) };
  }
  // Dev fallback: run the FastAPI server from the repo checkout.
  const serverDir = path.resolve(app.getAppPath(), '..', 'server');
  if (!fs.existsSync(path.join(serverDir, 'app', 'main.py'))) {
    return { error: `Dev run: server checkout not found at ${serverDir} — start it manually (python -m app.main).` };
  }
  const venvPython =
    process.platform === 'win32'
      ? path.join(serverDir, '.venv', 'Scripts', 'python.exe')
      : path.join(serverDir, '.venv', 'bin', 'python');
  const python = fs.existsSync(venvPython) ? venvPython : 'python3';
  return { command: python, args: ['-m', 'app.desktop'], cwd: serverDir };
}

// ---- Lifecycle --------------------------------------------------------------

async function start() {
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  stopping = false;
  const port = serverPort();
  setState({ state: 'starting', message: 'Starting the home server…', port });

  // Adopt-or-conflict: if the port already answers /health it is either our
  // own version (a dev server — use it) or an older standalone install that
  // must be removed (two servers fighting over one port helps nobody).
  const existing = await probeHealth(port);
  if (existing) {
    if (existing.version === app.getVersion()) {
      setState({ state: 'external', message: 'Using the already-running home server.', version: existing.version });
      return;
    }
    setState({
      state: 'conflict',
      version: existing.version,
      message:
        `Another Meeting Master server (v${existing.version || 'unknown'}) is already running on port ${port} — ` +
        'probably the old standalone "Meeting Master Home Server" install. ' +
        'Uninstall it from Windows Settings → Apps (your settings and data are kept), then click Retry.',
    });
    return;
  }

  const spec = launchSpec();
  if (spec.error) {
    setState({ state: 'failed', message: spec.error });
    return;
  }

  let spawned;
  try {
    spawned = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: { ...process.env, MM_SIDECAR: '1' },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    setState({ state: 'failed', message: `Could not launch the home server: ${err.message}` });
    return;
  }
  child = spawned;

  // The frozen sidecar logs to <config home>/server.log itself; piping stdout
  // here only matters for dev runs, where seeing uvicorn output is handy.
  if (!app.isPackaged) {
    spawned.stdout?.on('data', (d) => process.stdout.write(`[sidecar] ${d}`));
    spawned.stderr?.on('data', (d) => process.stderr.write(`[sidecar] ${d}`));
  } else {
    spawned.stdout?.resume();
    spawned.stderr?.resume();
  }

  spawned.on('error', (err) => {
    if (child !== spawned) return;
    child = null;
    setState({ state: 'failed', message: `Could not launch the home server: ${err.message}` });
  });

  spawned.on('exit', (code) => {
    if (child !== spawned) return;
    child = null;
    if (stopping) {
      setState({ state: 'stopped', message: '' });
      return;
    }
    // Unexpected death: bounded restart loop, then give up loudly.
    if (restarts < MAX_RESTARTS) {
      const delay = RESTART_DELAYS_MS[Math.min(restarts, RESTART_DELAYS_MS.length - 1)];
      restarts += 1;
      setState({
        state: 'starting',
        message: `The home server stopped unexpectedly (exit ${code}) — restarting (${restarts}/${MAX_RESTARTS})…`,
      });
      restartTimer = setTimeout(() => {
        restartTimer = null;
        start();
      }, delay);
    } else {
      setState({
        state: 'failed',
        message:
          `The home server keeps crashing (exit ${code}). ` +
          `See the log at ${serverLogPath()} for the reason.`,
      });
    }
  });

  // Wait for /health. The spawn can die mid-wait; the exit handler above owns
  // that transition, so just stop waiting when the child changes under us.
  const deadline = Date.now() + START_DEADLINE_MS;
  while (Date.now() < deadline) {
    if (child !== spawned) return; // crashed/replaced — exit handler took over
    const health = await probeHealth(port);
    if (health) {
      restarts = 0;
      setState({ state: 'running', message: '', version: health.version });
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (child === spawned) {
    setState({
      state: 'failed',
      message:
        `The home server did not come up on port ${port} within ${START_DEADLINE_MS / 1000}s. ` +
        `See the log at ${serverLogPath()}.`,
    });
  }
}

/** Operator clicked Retry on the boot page: reset the crash budget and start over. */
async function retry() {
  restarts = 0;
  await stop();
  await start();
}

/** Fire-and-forget kill for quit paths that cannot await (before-quit). */
function kill() {
  stopping = true;
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  if (child) {
    try {
      child.kill();
    } catch {
      // Already gone.
    }
  }
}

/** Graceful stop: kill and wait (bounded) for the process to exit. Used before
 *  installing an update so the installer never hits in-use sidecar files. */
function stop() {
  return new Promise((resolve) => {
    const current = child;
    kill();
    if (!current) {
      setState({ state: 'stopped', message: '' });
      resolve();
      return;
    }
    const timer = setTimeout(resolve, 5000);
    current.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

module.exports = {
  start,
  stop,
  kill,
  retry,
  getState,
  onState,
  dashboardUrl,
  serverPort,
  serverBearerToken,
  serverLogPath,
  configHome,
};
