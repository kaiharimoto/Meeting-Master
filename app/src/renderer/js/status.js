// Status line: friendly text per job state, a tiny spinner while the home
// server is working, and red error messages. Also renders api.onJobProgress
// events pushed from the main process.

const STATE_TEXT = {
  uploading: 'Uploading the recording to the home server…',
  queued: 'Waiting in the queue on the home PC…',
  normalizing: 'Preparing the audio (16 kHz mono) on the home PC…',
  transcribing: 'Transcribing on the home PC…',
  summarizing: 'Writing the AI summary on the home PC…',
  ready: 'Transcript and summary are ready — you can generate the PDF.',
  pdf_received: 'The home server received the PDF.',
  emailed: 'Email sent by the home server.',
  failed: 'The home server reported a failure.',
};

// States (including the synthetic "uploading") that show the spinner.
const BUSY_STATES = new Set(['uploading', 'queued', 'normalizing', 'transcribing', 'summarizing']);

let lineEl = null;
let textEl = null;
let spinnerEl = null;

export function initStatus(ctx) {
  lineEl = document.getElementById('status-line');
  textEl = document.getElementById('status-text');
  spinnerEl = document.getElementById('status-spinner');

  if (ctx.api && typeof ctx.api.onJobProgress === 'function') {
    ctx.api.onJobProgress((progress) => {
      if (!progress) return;
      const text = progress.message || friendlyState(progress.state);
      if (progress.state === 'failed') showError(text);
      else setStatus(text, { busy: isBusyState(progress.state) });
    });
  }
}

export function friendlyState(state) {
  return STATE_TEXT[state] || String(state || '');
}

export function isBusyState(state) {
  return BUSY_STATES.has(state);
}

export function setStatus(text, { busy = false } = {}) {
  if (!textEl) return;
  lineEl.classList.remove('is-error');
  textEl.textContent = text;
  spinnerEl.hidden = !busy;
}

export function showError(text) {
  if (!textEl) return;
  lineEl.classList.add('is-error');
  textEl.textContent = text;
  spinnerEl.hidden = true;
}
