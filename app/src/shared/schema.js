'use strict';

// Single source of truth for IPC channel names and job lifecycle states.
// Required by both the main process (src/main/ipc.js) and the preload script.
// Job states must stay in sync with server/app/models.py (JobState).

const SCHEMA_VERSION = 1;

const CHANNELS = Object.freeze({
  JOB_UPLOAD: 'job:upload',
  JOB_STATUS: 'job:status',
  JOB_PROGRESS: 'job:progress',
  PDF_RENDER: 'pdf:render',
  PDF_OPEN: 'pdf:open',
  PDF_SEND_HOME: 'pdf:sendHome',
  PDF_SEND_LAPTOP: 'pdf:sendLaptop',
  FILE_PICK_WAV: 'file:pickWav',
  FILE_PICK_SAVE: 'file:pickSave',
  CONFIG_GET: 'config:get',
  CONFIG_SAVE: 'config:save',
  CONFIG_GET_FULL: 'config:getFull',
  // App shell + live monitoring (v0.2.0)
  APP_INFO: 'app:info',
  WINDOW_SET_OVERLAY: 'window:setOverlay',
  SERVER_EVENT: 'server:event', // main -> renderer push (SSE + reachability)
  SERVER_STATUS_GET: 'server:statusGet',
  JOBS_LIST: 'jobs:list',
  LOGS_TAIL: 'logs:tail',
  // Auto-update + fonts (v0.2.1)
  APP_UPDATE: 'app:update', // main -> renderer push (update state changes)
  UPDATE_STATE_GET: 'update:stateGet',
  UPDATE_CHECK: 'update:check',
  UPDATE_INSTALL: 'update:install',
  FONTS_OPEN: 'fonts:open',
  // One app, two modes (v0.3.0)
  MODE_GET: 'mode:get',
  MODE_SET: 'mode:set',
  SIDECAR_STATE: 'sidecar:state', // main -> renderer push (server-mode boot page)
  SIDECAR_STATE_GET: 'sidecar:stateGet',
  SIDECAR_RETRY: 'sidecar:retry',
  SIDECAR_OPEN_LOG: 'sidecar:openLog',
  // External-AI escape hatch (v0.4.0)
  JOB_PROMPT: 'job:prompt',
  JOB_SUMMARIZE_RETRY: 'job:summarizeRetry',
  FILE_SAVE_TEXT: 'file:saveText',
});

const JOB_STATES = Object.freeze([
  'queued',
  'normalizing',
  'transcribing',
  'summarizing',
  'ready',
  'pdf_received',
  'emailed',
  'failed',
]);

// States in which the transcript + summary are available to render the PDF.
const READY_STATES = Object.freeze(['ready', 'pdf_received', 'emailed']);

module.exports = { SCHEMA_VERSION, CHANNELS, JOB_STATES, READY_STATES };
