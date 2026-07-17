// Orchestrates the "Generate & send" section: upload + polling, PDF
// rendering, opening, and emailing. Every failure lands on the status line —
// never an uncaught exception.

import { setStatus, showError, friendlyState, isBusyState } from './status.js';

// Renderer modules can't require() the CommonJS shared/schema.js; keep this
// list in sync with READY_STATES there.
const READY_STATES = ['ready', 'pdf_received', 'emailed'];

const POLL_INTERVAL_MS = 3000;

let ctx = null;
let pollTimer = null;
let els = null;

// Upload/poll concurrency guards: `uploading` serializes uploads (and is
// reflected in the button state); `pollInFlight` skips interval ticks while a
// status request is pending; `pollGeneration` invalidates responses that
// resolve after polling stopped or a newer job took over, so a slow
// out-of-order reply can never regress the persisted job state.
let uploading = false;
let pollInFlight = false;
let pollGeneration = 0;

export function initGenerate(context) {
  ctx = context;
  els = {
    pick: document.getElementById('pick-audio-btn'),
    generate: document.getElementById('generate-pdf-btn'),
    open: document.getElementById('open-pdf-btn'),
    send: document.getElementById('send-email-btn'),
  };

  els.pick.addEventListener('click', () => guarded(onPickAudio));
  els.generate.addEventListener('click', () => guarded(onGeneratePdf));
  els.open.addEventListener('click', () => guarded(onOpenPdf));
  els.send.addEventListener('click', () => guarded(onSendEmail));

  // Dev nicety: Ctrl+Shift+M loads the mock meeting fixture.
  document.addEventListener('keydown', onDevMockShortcut);

  // A renderer reload (or app restart) must not orphan a running job: the job
  // id is persisted, so resume polling if it never reached a terminal state.
  const job = ctx.state.job || {};
  if (ctx.api && job.id && job.state !== 'failed' && !READY_STATES.includes(job.state)) {
    setStatus(friendlyState(job.state || 'queued'), { busy: true });
    startPolling();
  }

  updateButtons(ctx);
}

// The meeting JSON exactly as POST /jobs expects it (schemaVersion 1).
function buildMeetingJson() {
  const d = ctx.state.details || {};
  return {
    schemaVersion: 1,
    details: {
      title: (d.title || '').trim(),
      date: d.date || '',
      time: d.time || '',
      attendees: Array.isArray(d.attendees) ? [...d.attendees] : [],
    },
    cards: (ctx.state.cards || []).map((c) => ({
      id: c.id,
      question: c.question,
      answer: c.answer,
      participant: c.participant,
    })),
    // Empty => the home server falls back to its preset recipients list.
    recipients: Array.isArray(ctx.state.recipients) ? [...ctx.state.recipients] : [],
    options: { ...(ctx.state.options || { whisperModel: 'large-v3-turbo', emailMode: 'home' }) },
  };
}

// Wrap handlers so any thrown/rejected error becomes a status-line message.
async function guarded(fn) {
  try {
    await fn();
  } catch (err) {
    showError(err && err.message ? err.message : String(err));
  }
}

function requireApi() {
  if (!ctx.api) {
    throw new Error('Desktop features are unavailable here (window.api is missing).');
  }
  return ctx.api;
}

// ---- Pick audio & start AI --------------------------------------------------

async function onPickAudio() {
  const api = requireApi();
  if (uploading) {
    setStatus('An upload is already in progress — wait for it to finish.');
    return;
  }
  const { filePath } = await api.pickWavFile();
  if (!filePath) {
    setStatus('No audio file picked — nothing was uploaded.');
    return;
  }

  // "New meeting" replaces state.job with a fresh object, so holding the
  // reference lets us detect a mid-upload reset and drop this continuation
  // instead of attaching the old meeting's job to the new meeting.
  const jobRef = ctx.state.job;
  uploading = true;
  updateButtons(ctx);
  setStatus('Uploading the recording to the home server…', { busy: true });
  try {
    const { jobId } = await api.uploadMeeting(buildMeetingJson(), filePath);
    if (ctx.state.job !== jobRef) {
      setStatus('Upload finished for a meeting that was discarded — ignored.');
      return;
    }
    ctx.state.job = { id: jobId, state: 'queued' };
    ctx.persist();
    startPolling();
  } finally {
    uploading = false;
    updateButtons(ctx);
  }
}

// ---- Polling ----------------------------------------------------------------

function startPolling() {
  stopPolling();
  pollOnce(); // immediate first check, then every 3s
  pollTimer = setInterval(pollOnce, POLL_INTERVAL_MS);
}

function stopPolling() {
  pollGeneration += 1; // invalidate any response still in flight
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function pollOnce() {
  const jobId = ctx.state.job && ctx.state.job.id;
  if (!jobId) {
    stopPolling();
    return;
  }
  if (pollInFlight) return; // a slow request is still pending — skip this tick

  const gen = pollGeneration;
  let job;
  pollInFlight = true;
  try {
    job = await ctx.api.getJobStatus(jobId);
  } catch (err) {
    if (gen !== pollGeneration) return; // polling stopped/superseded meanwhile
    // 401/404 cannot heal on their own — stop instead of spinning forever.
    if (/returned 401 /.test(err.message)) {
      stopPolling();
      showError(
        'The home server rejected the token (401) — make sure BEARER_TOKEN ' +
          'matches on both machines, then upload again.'
      );
      return;
    }
    if (/returned 404 /.test(err.message)) {
      stopPolling();
      showError(
        'The home server no longer knows this job (404) — its data may have ' +
          'been cleared. Upload the recording again.'
      );
      return;
    }
    // Transient network blips are expected over a home connection: keep
    // polling, but tell the operator what is happening.
    setStatus(`Waiting for the home server… (${err.message})`, { busy: true });
    return;
  } finally {
    pollInFlight = false;
  }
  if (gen !== pollGeneration) return; // stale response — a newer one already won

  ctx.state.job.state = job.state;
  if (job.transcript) ctx.state.transcript = job.transcript;
  if (job.summary !== null && job.summary !== undefined) ctx.state.summary = job.summary;
  ctx.persist();
  updateButtons(ctx);

  if (job.state === 'failed') {
    stopPolling();
    showError(`AI processing failed on the home server${job.error ? `: ${job.error}` : '.'}`);
  } else if (READY_STATES.includes(job.state)) {
    stopPolling();
    setStatus(friendlyState(job.state));
  } else {
    // Append a live percentage when the server reports one (transcription).
    let text = friendlyState(job.state);
    if (typeof job.progress === 'number' && job.progress > 0) {
      text += ` — ${job.progress}%`;
    }
    setStatus(text, { busy: isBusyState(job.state) });
  }
}

// ---- Generate / open PDF ------------------------------------------------------

async function onGeneratePdf() {
  const api = requireApi();
  setStatus('Rendering the PDF…', { busy: true });
  // Works even before/without AI results: the print template shows a
  // placeholder when summary is null.
  const { pdfPath, fontUsed, warning } = await api.renderPdf(
    buildMeetingJson(),
    ctx.state.transcript,
    ctx.state.summary
  );

  ctx.state.pdfPath = pdfPath;
  ctx.persist();
  updateButtons(ctx);

  if (!fontUsed && warning) {
    showError(`PDF saved to ${pdfPath} — but: ${warning}`);
  } else {
    setStatus(`PDF saved to ${pdfPath}${warning ? ` (${warning})` : ''}`);
  }
}

async function onOpenPdf() {
  const api = requireApi();
  if (!ctx.state.pdfPath) {
    showError('Generate the PDF first.');
    return;
  }
  await api.openPdf(ctx.state.pdfPath);
}

// ---- Send email -----------------------------------------------------------------

async function onSendEmail() {
  const api = requireApi();
  if (!ctx.state.pdfPath) {
    showError('Generate the PDF first — there is nothing to email yet.');
    return;
  }

  const cfg = ctx.config || (await api.getConfig());

  if (cfg.emailMode === 'laptop') {
    setStatus('Sending the email from this laptop via Gmail…', { busy: true });
    await api.sendPdfViaLaptop(buildMeetingJson(), ctx.state.pdfPath);
    setStatus('Email sent from this laptop.');
    return;
  }

  // Default: home mode — the home server emails the PDF for this job.
  const jobId = ctx.state.job && ctx.state.job.id;
  if (!jobId) {
    showError(
      'Home email mode needs an AI job for this meeting — run "Pick audio & start AI" ' +
        'first, or set EMAIL_MODE=laptop to send directly.'
    );
    return;
  }

  setStatus('Sending the PDF to the home server for emailing…', { busy: true });
  const result = await api.sendPdfViaHome(jobId, ctx.state.pdfPath);
  if (result && result.emailed) {
    setStatus('Email sent by the home server.');
  } else {
    const detail = result && result.error ? `: ${result.error}` : '.';
    showError(`The home server stored the PDF but could not send the email${detail}`);
  }
}

// ---- Button enable/disable -----------------------------------------------------

export function updateButtons(context) {
  if (!els) return;
  const c = context || ctx;
  const hasApi = Boolean(c.api);
  els.pick.disabled = !hasApi || uploading;
  els.generate.disabled = !hasApi; // PDF works even without AI results
  els.open.disabled = !hasApi || !c.state.pdfPath;
  els.send.disabled = !hasApi || !c.state.pdfPath;
}

// ---- Dev shortcut ----------------------------------------------------------------

async function onDevMockShortcut(e) {
  if (!(e.ctrlKey && e.shiftKey && (e.key === 'M' || e.key === 'm'))) return;
  e.preventDefault();
  try {
    // Dev-only nicety: the fixture only exists relative to the source tree,
    // and fetch() may reject file: URLs — both failure modes are silent.
    const res = await fetch('../../test/fixtures/mockMeeting.json');
    if (!res.ok) return;
    const mock = await res.json();

    ctx.state.details = mock.details || ctx.state.details;
    ctx.state.cards = mock.cards || [];
    ctx.state.recipients = mock.recipients || [];
    ctx.state.options = mock.options || ctx.state.options;
    ctx.state.transcript = mock.transcript || null;
    ctx.state.summary = mock.summary || null;
    ctx.persist();
    ctx.renderAll();
    setStatus('Mock meeting loaded (dev shortcut).');
  } catch {
    // Packaged build or fetch-blocked environment: silently unavailable.
  }
}
