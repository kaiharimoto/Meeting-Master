'use strict';

// Preload for the NON-operator windows: the first-run mode chooser
// (mode.html) and the server-mode window (serverBoot.html, and the loopback
// dashboard it hands off to). Exposes only the small surface those pages
// need — none of the meeting/PDF/config IPC the operator renderer gets.

const { contextBridge, ipcRenderer } = require('electron');
const { CHANNELS } = require('../shared/schema');

// Same {error} unwrapping contract as the main preload (see src/main/ipc.js).
async function call(channel, ...args) {
  const result = await ipcRenderer.invoke(channel, ...args);
  if (
    result &&
    typeof result === 'object' &&
    typeof result.error === 'string' &&
    Object.keys(result).length === 1
  ) {
    throw new Error(result.error);
  }
  return result;
}

contextBridge.exposeInMainWorld('api', {
  getAppInfo: () => call(CHANNELS.APP_INFO),
  getMode: () => call(CHANNELS.MODE_GET),
  setMode: (mode) => call(CHANNELS.MODE_SET, mode),
  getSidecarState: () => call(CHANNELS.SIDECAR_STATE_GET),
  retrySidecar: () => call(CHANNELS.SIDECAR_RETRY),
  openServerLog: () => call(CHANNELS.SIDECAR_OPEN_LOG),

  // Subscribe to sidecar state changes; returns an unsubscribe fn.
  onSidecarState: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on(CHANNELS.SIDECAR_STATE, listener);
    return () => ipcRenderer.removeListener(CHANNELS.SIDECAR_STATE, listener);
  },
});
