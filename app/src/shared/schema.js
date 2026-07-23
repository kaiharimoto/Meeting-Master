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
  JOB_EMAIL_PREVIEW: 'job:emailPreview',
  JOB_NAMES_GET: 'job:namesGet',
  JOB_NAMES_APPLY: 'job:namesApply',
  FILE_SAVE_TEXT: 'file:saveText',
  // In-app recording (v0.8.0)
  REC_START: 'rec:start',
  REC_APPEND: 'rec:append',
  REC_STOP: 'rec:stop',
  REC_DISCARD: 'rec:discard',
  REC_ORPHANS: 'rec:orphans',
  REC_ORPHAN_RESOLVE: 'rec:orphanResolve',
  REC_STAT: 'rec:stat',
  REC_OPEN_FOLDER: 'rec:openFolder',
  REC_EVENT: 'rec:event', // main -> renderer push (force-stop on window close)
  // Live mid-meeting transcription (v0.9.0)
  LIVE_SUPPORT_GET: 'live:supportGet',
  LIVE_MODEL_DOWNLOAD: 'live:modelDownload',
  LIVE_MODEL_DELETE: 'live:modelDelete',
  LIVE_MODEL_EVENT: 'live:modelEvent', // main -> renderer push (download progress)
  LIVE_START: 'live:start',
  LIVE_PCM: 'live:pcm',
  LIVE_STOP: 'live:stop',
  LIVE_EVENT: 'live:event', // main -> renderer push (segments, lag, flag candidates)
  // Usability batch (v0.10.0)
  PREFLIGHT_GET: 'preflight:get',
  MINI_OPEN: 'mini:open',
  MINI_CMD: 'mini:cmd', // mini window -> main; relayed to the main renderer as a push
  MINI_STATUS: 'mini:status', // main renderer -> main; relayed to the mini window
  MINI_STATE: 'mini:state', // main -> mini window push (timer/level/status)
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
