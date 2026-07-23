'use strict';

// Preload: the ONLY bridge between the renderer and the main process.
// Exposes exactly the window.api surface documented in the project contract —
// nothing else (no ipcRenderer, no Node globals). Requires sandbox:false on
// the window because of the require() below.

const { contextBridge, ipcRenderer } = require('electron');
const { CHANNELS } = require('../shared/schema');

// Main-side handlers never reject; failures come back as a bare
// {error: string} object (exactly one key — see src/main/ipc.js). Re-throw
// those as clean Errors so renderer code can use ordinary try/catch. Payloads
// that legitimately carry an `error` field (e.g. {ok, emailed, error}) have
// other keys too and pass through untouched.
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
  uploadMeeting: (meeting, wavFilePath) => call(CHANNELS.JOB_UPLOAD, meeting, wavFilePath),
  getJobStatus: (jobId) => call(CHANNELS.JOB_STATUS, jobId),
  renderPdf: (meeting, transcript, summary) =>
    call(CHANNELS.PDF_RENDER, meeting, transcript, summary),
  openPdf: (pdfPath) => call(CHANNELS.PDF_OPEN, pdfPath),
  sendPdfViaHome: (jobId, pdfPath) => call(CHANNELS.PDF_SEND_HOME, jobId, pdfPath),
  sendPdfViaLaptop: (meeting, pdfPath) => call(CHANNELS.PDF_SEND_LAPTOP, meeting, pdfPath),
  pickWavFile: () => call(CHANNELS.FILE_PICK_WAV),
  pickSavePath: (defaultName) => call(CHANNELS.FILE_PICK_SAVE, defaultName),
  getConfig: () => call(CHANNELS.CONFIG_GET),
  getFullConfig: () => call(CHANNELS.CONFIG_GET_FULL),
  saveConfig: (values) => call(CHANNELS.CONFIG_SAVE, values),

  // App shell + live monitoring (v0.2.0)
  getAppInfo: () => call(CHANNELS.APP_INFO),
  setWindowOverlay: (theme) => call(CHANNELS.WINDOW_SET_OVERLAY, theme),
  getServerStatus: () => call(CHANNELS.SERVER_STATUS_GET),
  listJobs: (limit) => call(CHANNELS.JOBS_LIST, limit),
  getLogTail: (lines) => call(CHANNELS.LOGS_TAIL, lines),

  // Auto-update + fonts (v0.2.1)
  getUpdateState: () => call(CHANNELS.UPDATE_STATE_GET),
  checkForUpdate: () => call(CHANNELS.UPDATE_CHECK),
  installUpdate: () => call(CHANNELS.UPDATE_INSTALL),
  openFontsFolder: () => call(CHANNELS.FONTS_OPEN),

  // One app, two modes (v0.3.0)
  getMode: () => call(CHANNELS.MODE_GET),
  setMode: (mode) => call(CHANNELS.MODE_SET, mode),

  // External-AI escape hatch (v0.4.0)
  getJobPrompt: (jobId) => call(CHANNELS.JOB_PROMPT, jobId),
  retrySummary: (jobId) => call(CHANNELS.JOB_SUMMARIZE_RETRY, jobId),
  getEmailPreview: (jobId) => call(CHANNELS.JOB_EMAIL_PREVIEW, jobId),
  getJobNames: (jobId) => call(CHANNELS.JOB_NAMES_GET, jobId),
  applyJobNames: (jobId, mapping) => call(CHANNELS.JOB_NAMES_APPLY, jobId, mapping),
  saveTextFile: (filePath, text) => call(CHANNELS.FILE_SAVE_TEXT, filePath, text),

  // In-app recording (v0.8.0)
  recStart: (meta) => call(CHANNELS.REC_START, meta),
  recAppend: (recId, seq, chunk, elapsedMs) =>
    call(CHANNELS.REC_APPEND, recId, seq, chunk, elapsedMs),
  recStop: (recId, info) => call(CHANNELS.REC_STOP, recId, info),
  recDiscard: (recId) => call(CHANNELS.REC_DISCARD, recId),
  recListOrphans: () => call(CHANNELS.REC_ORPHANS),
  recResolveOrphan: (recId, action) => call(CHANNELS.REC_ORPHAN_RESOLVE, recId, action),
  recStat: (filePath) => call(CHANNELS.REC_STAT, filePath),
  recOpenFolder: () => call(CHANNELS.REC_OPEN_FOLDER),
  onRecEvent: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on(CHANNELS.REC_EVENT, listener);
    return () => ipcRenderer.removeListener(CHANNELS.REC_EVENT, listener);
  },

  // Live mid-meeting transcription (v0.9.0)
  liveSupportGet: () => call(CHANNELS.LIVE_SUPPORT_GET),
  liveModelDownload: (name) => call(CHANNELS.LIVE_MODEL_DOWNLOAD, name),
  liveModelDelete: (name) => call(CHANNELS.LIVE_MODEL_DELETE, name),
  liveStart: (opts) => call(CHANNELS.LIVE_START, opts),
  livePcm: (chunk, rms) => call(CHANNELS.LIVE_PCM, chunk, rms),
  liveStop: () => call(CHANNELS.LIVE_STOP),
  onLiveEvent: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on(CHANNELS.LIVE_EVENT, listener);
    return () => ipcRenderer.removeListener(CHANNELS.LIVE_EVENT, listener);
  },
  onLiveModelEvent: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on(CHANNELS.LIVE_MODEL_EVENT, listener);
    return () => ipcRenderer.removeListener(CHANNELS.LIVE_MODEL_EVENT, listener);
  },

  // Server-mode window pages (boot page + Dashboard tab in the one window)
  getSidecarState: () => call(CHANNELS.SIDECAR_STATE_GET),
  retrySidecar: () => call(CHANNELS.SIDECAR_RETRY),
  openServerLog: () => call(CHANNELS.SIDECAR_OPEN_LOG),
  onSidecarState: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on(CHANNELS.SIDECAR_STATE, listener);
    return () => ipcRenderer.removeListener(CHANNELS.SIDECAR_STATE, listener);
  },

  // Subscribe to main->renderer progress events; returns an unsubscribe fn.
  onJobProgress: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on(CHANNELS.JOB_PROGRESS, listener);
    return () => ipcRenderer.removeListener(CHANNELS.JOB_PROGRESS, listener);
  },

  // Subscribe to main->renderer server events (SSE relays + reachability
  // status changes); returns an unsubscribe fn.
  onServerEvent: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on(CHANNELS.SERVER_EVENT, listener);
    return () => ipcRenderer.removeListener(CHANNELS.SERVER_EVENT, listener);
  },

  // Subscribe to app-update state changes; returns an unsubscribe fn.
  onAppUpdate: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on(CHANNELS.APP_UPDATE, listener);
    return () => ipcRenderer.removeListener(CHANNELS.APP_UPDATE, listener);
  },
});
