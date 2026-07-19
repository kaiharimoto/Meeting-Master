'use strict';

// SSE consumer for the home server's /events stream, living in the MAIN
// process (the renderer has no network access and must never see the bearer
// token). Every event is re-emitted to the renderer over CHANNELS.SERVER_EVENT
// as {type:'sse', event, data, id}; connection/reachability changes are
// emitted as {type:'status', status}.
//
// Resilience model:
//   * exponential backoff reconnect (1s -> 30s), reset after a healthy open;
//   * Last-Event-ID sent on reconnect so the server can replay missed events
//     (an unknown id just yields a fresh `hello` snapshot);
//   * a watchdog aborts the stream if nothing (data OR ping) arrives for 45s;
//   * while SSE is down, a 30s GET /health probe keeps reachability honest.
// Failure here is COSMETIC by design — the renderer's 3s polling remains the
// functional fallback for the meeting workflow.

const { CHANNELS } = require('../shared/schema');
const config = require('./config');

const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 30000;
const WATCHDOG_MS = 45000;
const HEALTH_PROBE_MS = 30000;

let getWindow = null;
let abortController = null;
let reconnectTimer = null;
let watchdogTimer = null;
let healthTimer = null;
let backoffMs = BACKOFF_MIN_MS;
let lastEventId = null;
let generation = 0; // invalidates stale loops after stop()/restart()

let status = {
  configured: false,
  reachability: 'unknown', // 'ok' | 'unreachable' | 'unconfigured' | 'unknown'
  sse: 'off', // 'connected' | 'connecting' | 'off'
  serverUrl: '',
  serverVersion: null,
  lastEventAt: null,
};

function send(payload) {
  const win = getWindow && getWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send(CHANNELS.SERVER_EVENT, payload);
  }
}

function setStatus(patch) {
  status = { ...status, ...patch };
  send({ type: 'status', status });
}

function getStatus() {
  return status;
}

// ---- SSE frame parsing ------------------------------------------------------

function dispatchFrame(frame) {
  let event = 'message';
  let id = null;
  const dataLines = [];
  for (const rawLine of frame.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (!line || line.startsWith(':')) continue; // comment/ping
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') dataLines.push(value);
    else if (field === 'id') id = value;
    // 'retry' is handled implicitly by our own backoff policy.
  }
  if (id) lastEventId = id;
  if (dataLines.length === 0) return;

  let data = dataLines.join('\n');
  try {
    data = JSON.parse(data);
  } catch {
    // Non-JSON data passes through as a string.
  }
  status.lastEventAt = Date.now();
  if (event === 'hello' && data && typeof data === 'object') {
    setStatus({
      reachability: 'ok',
      configured: Boolean(data.configured),
      serverVersion: data.version || null,
    });
  }
  send({ type: 'sse', event, data, id });
}

// ---- Connection loop --------------------------------------------------------

function armWatchdog() {
  if (watchdogTimer) clearTimeout(watchdogTimer);
  watchdogTimer = setTimeout(() => {
    // Silent for too long — the connection is probably dead. Abort; the
    // catch/finally in connect() schedules the reconnect.
    if (abortController) abortController.abort();
  }, WATCHDOG_MS);
}

async function connect(gen) {
  const cfg = config.get();
  if (!cfg.serverUrl || !cfg.bearerToken) {
    setStatus({ reachability: 'unconfigured', sse: 'off', serverUrl: cfg.serverUrl || '' });
    return; // config:save triggers restart() when this changes
  }

  setStatus({ sse: 'connecting', serverUrl: cfg.serverUrl });
  abortController = new AbortController();
  let openedAt = 0;

  try {
    const headers = {
      Authorization: `Bearer ${cfg.bearerToken}`,
      Accept: 'text/event-stream',
    };
    if (lastEventId) headers['Last-Event-ID'] = String(lastEventId);

    const res = await fetch(`${cfg.serverUrl.replace(/\/$/, '')}/events`, {
      headers,
      signal: abortController.signal,
    });
    if (gen !== generation) return;
    if (!res.ok || !res.body) {
      throw new Error(`events stream returned HTTP ${res.status}`);
    }

    setStatus({ sse: 'connected', reachability: 'ok' });
    openedAt = Date.now();
    stopHealthProbe(); // stream liveness supersedes polling /health

    const decoder = new TextDecoder();
    let buffer = '';
    armWatchdog();
    for await (const chunk of res.body) {
      if (gen !== generation) return;
      armWatchdog();
      buffer += decoder.decode(chunk, { stream: true });
      let sep;
      while ((sep = buffer.search(/\n\n|\r\n\r\n/)) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + (buffer[sep] === '\r' ? 4 : 2));
        if (frame.trim()) dispatchFrame(frame);
      }
      if (buffer.length > 1024 * 1024) buffer = ''; // runaway guard
    }
    throw new Error('events stream ended');
  } catch (err) {
    if (gen !== generation) return; // stopped/restarted — not an error
    // Reset backoff only after a PROVEN-healthy stream (survived >10s). A
    // reset on mere HTTP 200 would pin a flapping connection (open, die,
    // reconnect) at the minimum interval forever.
    if (openedAt && Date.now() - openedAt > 10000) backoffMs = BACKOFF_MIN_MS;
    scheduleReconnect(gen);
  } finally {
    // Guarded by generation: an old loop unwinding late must not clear the
    // NEW connection's watchdog.
    if (gen === generation && watchdogTimer) {
      clearTimeout(watchdogTimer);
      watchdogTimer = null;
    }
  }
}

function scheduleReconnect(gen) {
  setStatus({ sse: 'connecting' });
  startHealthProbe(); // keep reachability honest while the stream is down
  if (reconnectTimer) clearTimeout(reconnectTimer);
  const delay = backoffMs;
  backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
  reconnectTimer = setTimeout(() => {
    if (gen === generation) connect(gen);
  }, delay);
}

// ---- Health probe (fallback while SSE is down) ------------------------------

function startHealthProbe() {
  if (healthTimer) return;
  const gen = generation;
  const probe = async () => {
    const homeClient = require('./homeClient');
    try {
      const body = await homeClient.health();
      if (gen !== generation) return; // restarted while in flight — stale
      setStatus({
        reachability: 'ok',
        configured: Boolean(body && body.configured),
        serverVersion: (body && body.version) || status.serverVersion,
      });
    } catch {
      if (gen !== generation) return;
      const cfg = config.get();
      setStatus({
        reachability: cfg.serverUrl && cfg.bearerToken ? 'unreachable' : 'unconfigured',
      });
    }
  };
  probe();
  healthTimer = setInterval(probe, HEALTH_PROBE_MS);
}

function stopHealthProbe() {
  if (healthTimer) {
    clearInterval(healthTimer);
    healthTimer = null;
  }
}

// ---- Public lifecycle -------------------------------------------------------

function start(windowGetter) {
  getWindow = windowGetter;
  restart();
}

function restart() {
  stop();
  generation += 1;
  backoffMs = BACKOFF_MIN_MS;
  lastEventId = null;
  connect(generation);
}

function stop() {
  generation += 1;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (watchdogTimer) clearTimeout(watchdogTimer);
  reconnectTimer = null;
  watchdogTimer = null;
  stopHealthProbe();
  if (abortController) {
    abortController.abort();
    abortController = null;
  }
  status = { ...status, sse: 'off' };
}

module.exports = { start, restart, stop, getStatus };
