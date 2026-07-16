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
