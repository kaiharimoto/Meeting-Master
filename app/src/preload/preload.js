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

  // Subscribe to main->renderer progress events; returns an unsubscribe fn.
  onJobProgress: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on(CHANNELS.JOB_PROGRESS, listener);
    return () => ipcRenderer.removeListener(CHANNELS.JOB_PROGRESS, listener);
  },
});
