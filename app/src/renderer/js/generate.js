// Orchestrates the "Generate & send" section: upload + polling, PDF
// rendering, opening, and emailing. Every failure lands on the status line —
// never an uncaught exception.

import { setStatus, showError, friendlyState, isBusyState } from './status.js';
import { renderExtractPrompt, captureExtracted } from './extractReview.js';
import { saveCurrentToHistory } from './history.js';
import { showToast } from './toast.js';
import { showProblem, clearProblem } from './problems.js';
import { FIRST_TRANSCRIPT_KEY } from './checklist.js';
import { copyText } from './clipboard.js';
import { isTypingTarget, anyModalOpen, matchChord } from './keys.js';

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

// Transcription ETA: wall-clock start of the transcribing state, so progress
// percent can be projected into "~N min left".
let transcribeStartedAt = null;
let lastPolledState = null;

// Jobs whose recipient list the operator has confirmed this session (the
// preset list lives on the server and is otherwise invisible from here).
const confirmedSendJobs = new Set();

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

  // Explicit file upload — bypasses any attached in-app recording.
  els.pickFile = document.getElementById('pick-file-btn');
  if (els.pickFile) els.pickFile.addEventListener('click', () => guarded(onPickFileExplicit));

  // Transcript escape hatch (v0.4.0): grab the raw transcript / the exact AI
  // prompt so an EXTERNAL model can write the summary when the local one
  // can't (context overflow etc.); its JSON reply imports via Edit summary.
  els.copyTranscript = document.getElementById('copy-transcript-btn');
  els.saveTranscript = document.getElementById('save-transcript-btn');
  els.copyPrompt = document.getElementById('copy-ai-prompt-btn');
  if (els.copyTranscript) els.copyTranscript.addEventListener('click', () => guarded(onCopyTranscript));
  if (els.saveTranscript) els.saveTranscript.addEventListener('click', () => guarded(onSaveTranscript));
  if (els.copyPrompt) els.copyPrompt.addEventListener('click', () => guarded(onCopyAiPrompt));
  els.startAi = document.getElementById('start-ai-btn');
  if (els.startAi) els.startAi.addEventListener('click', () => guarded(startAi));

  // Dev nicety: Ctrl+Shift+M loads the mock meeting fixture.
  document.addEventListener('keydown', onDevMockShortcut);

  // A renderer reload (or app restart) must not orphan a running job: the job
  // id is persisted, so resume polling if it never reached a terminal state.
  maybeResumePolling();

  updateButtons(ctx);
}

// Resume polling if the current job is mid-pipeline (used at boot, after a
// history snapshot restores a meeting, and after "New meeting"). When the
// current job is terminal or absent this STOPS any leftover interval — an
// interval leaked from a previous meeting would otherwise poll the restored
// job and fire spurious ready/failed toasts.
export function maybeResumePolling() {
  const job = ctx.state.job || {};
  if (ctx.api && job.id && job.state && job.state !== 'failed' &&
      !READY_STATES.includes(job.state)) {
    setStatus(friendlyState(job.state || 'queued'), { busy: true });
    startPolling();
  } else {
    stopPolling();
  }
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
    // Two-step flow: the server stops after transcription so names can be
    // reviewed/fixed BEFORE any AI reads them; "Start AI" runs the rest.
    options: {
      ...(ctx.state.options || { whisperModel: 'large-v3-turbo', emailMode: 'home' }),
      skipAi: true,
    },
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

  // An attached in-app recording wins over the file picker. Verify it still
  // exists first — a missing file falls back to the picker instead of a
  // confusing upload error.
  let filePath = null;
  const rec = ctx.state.recording;
  if (rec && rec.filePath && typeof api.recStat === 'function') {
    let exists = false;
    try {
      const s = await api.recStat(rec.filePath);
      exists = Boolean(s && s.exists);
    } catch {
      exists = false;
    }
    if (exists) {
      filePath = rec.filePath;
    } else {
      ctx.state.recording = null;
      ctx.persist();
      showToast({
        kind: 'error',
        title: 'The attached recording file is missing',
        message: 'It may have been deleted from the recordings folder — pick an audio file instead.',
      });
    }
  }

  if (!filePath) {
    ({ filePath } = await api.pickWavFile());
    if (!filePath) {
      setStatus('No audio file picked — nothing was uploaded.');
      return;
    }
  }

  await uploadAudio(filePath);
}

/** "Upload audio file…": always the picker, even with a recording attached. */
async function onPickFileExplicit() {
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
  await uploadAudio(filePath);
}

async function uploadAudio(filePath) {
  const api = requireApi();
  // "New meeting" replaces state.job with a fresh object, so holding the
  // reference lets us detect a mid-upload reset and drop this continuation
  // instead of attaching the old meeting's job to the new meeting.
  const jobRef = ctx.state.job;
  uploading = true;
  updateButtons(ctx);
  // A fresh upload is a fresh attempt — retire the previous failure cards.
  clearProblem('pipeline');
  clearProblem('email');
  setStatus('Uploading the recording to the home server…', { busy: true });
  try {
    const { jobId } = await api.uploadMeeting(buildMeetingJson(), filePath);
    if (ctx.state.job !== jobRef) {
      setStatus('Upload finished for a meeting that was discarded — ignored.');
      return;
    }
    ctx.state.job = { id: jobId, state: 'queued' };
    // A re-run on the same meeting (no "New meeting") must surface the NEW
    // recording's detected questions — clear the prior review so pollOnce's
    // `!questionsReviewed` capture guard doesn't drop them.
    ctx.state.extractedQuestions = [];
    ctx.state.questionsReviewed = false;
    ctx.persist();
    renderExtractPrompt();
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
  // Identity snapshot: "New meeting" / history-open replace state.job with a
  // fresh object; a response that resolves after that must not write the old
  // meeting's results into the new meeting's state.
  const jobRef = ctx.state.job;
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
  if (ctx.state.job !== jobRef) return; // meeting was replaced mid-flight

  ctx.state.job.state = job.state;
  ctx.state.job.progress = typeof job.progress === 'number' ? job.progress : null;
  if (job.state !== lastPolledState) {
    lastPolledState = job.state;
    transcribeStartedAt = job.state === 'transcribing' ? Date.now() : null;
  }
  if (job.transcript) {
    ctx.state.transcript = job.transcript;
    // First-run checklist: the pipeline has produced a transcript once.
    try {
      localStorage.setItem(FIRST_TRANSCRIPT_KEY, '1');
    } catch {
      // Storage unavailable — the checklist item just stays open.
    }
  }
  if (job.summary !== null && job.summary !== undefined) ctx.state.summary = job.summary;
  // Capture AI-detected Q&A candidates once (they are approved, not auto-added),
  // dropping any that duplicate a card the operator already typed. Guard on
  // !reviewed so a late poll can't resurrect a list the user culled.
  if (Array.isArray(job.questions) && job.questions.length && !ctx.state.questionsReviewed) {
    captureExtracted(job.questions);
  }
  ctx.persist();
  updateButtons(ctx);
  renderExtractPrompt();
  // Let passive views (the Activity pipeline) re-render on each poll result.
  document.dispatchEvent(new CustomEvent('mm:job'));

  if (job.state === 'failed') {
    stopPolling();
    showError(`AI processing failed on the home server${job.error ? `: ${job.error}` : '.'}`);
    // Persistent card with the remedies attached — a failed pipeline stage is
    // not transient, and its fix shouldn't depend on a toast you missed.
    showProblem({
      id: 'pipeline',
      title: 'AI processing failed on the home server',
      detail: job.error || 'The home server reported a failure.',
      actions: [
        { label: 'Retry AI', primary: true, onClick: () => startAi() },
        {
          label: 'Copy AI prompt',
          onClick: () => els.copyPrompt && els.copyPrompt.click(),
        },
      ],
    });
  } else if (READY_STATES.includes(job.state)) {
    stopPolling();
    // Two-step checkpoint: transcript done, AI deliberately not run yet
    // (options.skipAi → summary is null, no questions, no AI errors). An AI
    // run that produced nothing still stores an EMPTY summary object, so
    // null summary + no questions is unambiguous.
    if (
      job.state === 'ready' && job.summary == null &&
      !job.summaryError && !job.questionsError &&
      !(Array.isArray(job.questions) && job.questions.length) &&
      job.transcript
    ) {
      updateButtons(ctx);
      setStatus('Transcript ready — review the names, then click Start AI.');
      showToast({
        kind: 'success',
        title: 'Transcript ready',
        message: 'Check the detected names (misspellings get merged), then Start AI.',
      });
      if (ctx.state.namesPromptedJobId !== job.id) {
        ctx.state.namesPromptedJobId = job.id; // auto-open once per job
        ctx.persist();
        import('./nameFix.js').then((m) => m.openNameFix()).catch(() => {});
      }
      return;
    }
    // A ready job can still carry per-AI-stage failures (transcript done,
    // summary and/or Q&A extraction failed) — say so LOUDLY with remedies,
    // never silently ship an empty summary (v0.4.x field report).
    if (job.summaryError || job.questionsError) {
      const failedBits = [
        job.summaryError ? 'summary' : null,
        job.questionsError ? 'Q&A detection' : null,
      ].filter(Boolean).join(' and ');
      const reason = job.summaryError || job.questionsError;
      showError(`Transcript is ready, but the AI ${failedBits} failed: ${reason}`);
      showProblem({
        id: 'pipeline',
        title: `AI ${failedBits} failed — the transcript is safe`,
        detail:
          `${reason}. Retry (e.g. after lowering the context window in the ` +
          'server Settings), or hand the transcript to an external AI.',
        actions: [
          { label: 'Retry summary', primary: true, onClick: () => startAi() },
          {
            label: 'Copy AI prompt',
            onClick: () => els.copyPrompt && els.copyPrompt.click(),
          },
        ],
      });
    } else {
      clearProblem('pipeline'); // a clean result retires the failure card
      setStatus(friendlyState(job.state));
      showToast({
        kind: 'success',
        title: 'Summary & Q&A are ready',
        message: 'Review the detected questions, then generate the PDF.',
      });
    }
  } else {
    // Append a live percentage when the server reports one (transcription),
    // plus a projected time remaining — waiting with an ETA feels completely
    // different from waiting without one.
    let text = friendlyState(job.state);
    if (typeof job.progress === 'number' && job.progress > 0) {
      text += ` — ${job.progress}%`;
      if (job.state === 'transcribing' && transcribeStartedAt && job.progress >= 5) {
        const elapsed = Date.now() - transcribeStartedAt;
        const remainMs = (elapsed * (100 - job.progress)) / job.progress;
        text += ` · ${fmtEta(remainMs)}`;
      }
    }
    setStatus(text, {
      busy: isBusyState(job.state),
      progress: typeof job.progress === 'number' ? job.progress : null,
    });
  }
}

function fmtEta(ms) {
  if (ms < 60000) return 'under a minute left';
  const min = Math.round(ms / 60000);
  return `~${min} min left`;
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
  // A generated PDF is a natural checkpoint — snapshot the meeting to history.
  saveCurrentToHistory();

  if (!fontUsed && warning) {
    showError(`PDF saved to ${pdfPath} — but: ${warning}`);
  } else {
    setStatus(`PDF saved to ${pdfPath}${warning ? ` (${warning})` : ''}`);
    showToast({ kind: 'success', title: 'PDF saved', message: pdfPath });
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
    showToast({ kind: 'success', title: 'Email sent', message: 'Sent from this laptop via Gmail.' });
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

  // The preset recipient list lives on the SERVER and is invisible from this
  // laptop — confirm who actually gets the email once per meeting, with the
  // real resolved recipients + subject when the server can tell us.
  if (!confirmedSendJobs.has(jobId)) {
    let prompt = 'Send the meeting PDF to the preset recipient list now?';
    try {
      if (typeof api.getEmailPreview === 'function') {
        const preview = await api.getEmailPreview(jobId);
        const to = Array.isArray(preview.recipients)
          ? preview.recipients.join(', ')
          : preview.to || '';
        prompt =
          `Send the meeting PDF now?\n\n` +
          (to ? `To: ${to}\n` : '') +
          (preview.subject ? `Subject: ${preview.subject}` : '');
      }
    } catch {
      // Preview unavailable — fall back to the generic confirmation.
    }
    if (!window.confirm(prompt)) {
      setStatus('Email not sent.');
      return;
    }
    confirmedSendJobs.add(jobId);
  }

  setStatus('Sending the PDF to the home server for emailing…', { busy: true });
  const result = await api.sendPdfViaHome(jobId, ctx.state.pdfPath);
  if (result && result.emailed) {
    clearProblem('email');
    setStatus('Email sent by the home server.');
    showToast({ kind: 'success', title: 'Email sent', message: 'Delivered by the home server.' });
  } else {
    const detail = result && result.error ? `: ${result.error}` : '.';
    showError(`The home server stored the PDF but could not send the email${detail}`);
    showProblem({
      id: 'email',
      title: 'The email could not be sent',
      detail:
        (result && result.error ? `${result.error}. ` : '') +
        'The PDF is stored on the home server — retry, or send it yourself.',
      actions: [
        { label: 'Retry send', primary: true, onClick: () => els.send && els.send.click() },
        {
          label: 'Email text…',
          onClick: () => {
            const btn = document.getElementById('email-text-btn');
            if (btn) btn.click();
          },
        },
      ],
    });
  }
}

// ---- Button enable/disable -----------------------------------------------------

export function updateButtons(context) {
  if (!els) return;
  const c = context || ctx;
  const hasApi = Boolean(c.api);
  // No uploads while a recording is running — the file is still being written.
  const recBusy = typeof c.recActive === 'function' && c.recActive();
  els.pick.disabled = !hasApi || uploading || recBusy;
  if (els.pickFile) els.pickFile.disabled = !hasApi || uploading || recBusy;
  els.generate.disabled = !hasApi; // PDF works even without AI results
  els.open.disabled = !hasApi || !c.state.pdfPath;
  els.send.disabled = !hasApi || !c.state.pdfPath;
  const transcriptText = c.state.transcript && c.state.transcript.text;
  if (els.copyTranscript) els.copyTranscript.disabled = !transcriptText;
  if (els.saveTranscript) {
    els.saveTranscript.disabled =
      !transcriptText || !hasApi || typeof c.api.saveTextFile !== 'function';
  }
  if (els.copyPrompt) {
    // The server composes the prompt, so it needs the job to still exist there.
    const jobId = c.state.job && c.state.job.id;
    els.copyPrompt.disabled =
      !hasApi || !jobId || !transcriptText || typeof c.api.getJobPrompt !== 'function';
  }
  if (els.startAi) {
    const jobId = c.state.job && c.state.job.id;
    els.startAi.disabled =
      !hasApi || !jobId || !transcriptText || typeof c.api.retrySummary !== 'function';
  }
  const emailBtn = document.getElementById('email-text-btn');
  if (emailBtn) {
    const jobId = c.state.job && c.state.job.id;
    emailBtn.disabled = !hasApi || !jobId || typeof c.api.getEmailPreview !== 'function';
  }
}

// ---- Transcript / external-AI escape hatch ----------------------------------

/** Start (or re-run) the AI stages on the server's stored transcript. */
export async function startAi() {
  const jobId = ctx.state.job && ctx.state.job.id;
  if (!jobId || !ctx.api || typeof ctx.api.retrySummary !== 'function') return;
  try {
    await ctx.api.retrySummary(jobId);
    ctx.state.job.state = 'summarizing';
    ctx.persist();
    setStatus('Running the AI summary + question detection…', { busy: true });
    maybeResumePolling();
  } catch (err) {
    showError(err && err.message ? err.message : String(err));
  }
}

function transcriptOrExplain() {
  const text = ctx.state.transcript && ctx.state.transcript.text;
  if (!text) {
    showError('No transcript yet — it appears once the AI job has transcribed the audio.');
    return null;
  }
  return text;
}

async function onCopyTranscript() {
  const text = transcriptOrExplain();
  if (!text) return;
  if (!(await copyText(text))) {
    showError('Could not copy to the clipboard — use "Save transcript" to write it to a file instead.');
    return;
  }
  setStatus('Transcript copied to the clipboard.');
  showToast({ kind: 'success', title: 'Transcript copied', message: 'Paste it anywhere.' });
}

async function onSaveTranscript() {
  const text = transcriptOrExplain();
  if (!text) return;
  const title = (ctx.state.details && ctx.state.details.title) || 'meeting';
  const safe = title.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'meeting';
  const { filePath } = await ctx.api.pickSavePath(`${safe}-transcript.txt`);
  if (!filePath) return;
  await ctx.api.saveTextFile(filePath, text); // renderer has no fs — main writes it
  setStatus(`Transcript saved: ${filePath}`);
}

async function onCopyAiPrompt() {
  const jobId = ctx.state.job && ctx.state.job.id;
  if (!jobId) {
    showError('No AI job for this meeting — upload the recording first (the prompt embeds the transcript held by the server).');
    return;
  }
  setStatus('Fetching the AI prompt…', { busy: true });
  const { text } = await ctx.api.getJobPrompt(jobId);
  if (!(await copyText(text))) {
    // The prompt isn't shown anywhere to select by hand, so offer the file
    // route rather than leaving the operator with no way to get at it.
    showError('Could not copy to the clipboard — save the prompt to a file instead.');
    showToast({
      kind: 'error',
      title: 'Clipboard unavailable',
      message: 'Save the AI prompt as a .txt file and open it from there.',
      action: { label: 'Save prompt…', onClick: () => guarded(() => savePromptToFile(text)) },
    });
    return;
  }
  setStatus('AI prompt copied — paste it into your model, then import its JSON reply via Edit summary.');
  showToast({
    kind: 'success',
    title: 'AI prompt copied',
    message: 'Paste into Claude/ChatGPT; import the JSON reply via Edit summary → Import AI output.',
  });
}

async function savePromptToFile(text) {
  if (!ctx.api || typeof ctx.api.pickSavePath !== 'function') return;
  const title = (ctx.state.details && ctx.state.details.title) || 'meeting';
  const safe = title.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'meeting';
  const { filePath } = await ctx.api.pickSavePath(`${safe}-ai-prompt.txt`);
  if (!filePath) return;
  await ctx.api.saveTextFile(filePath, text);
  setStatus(`AI prompt saved: ${filePath}`);
}

// ---- Dev shortcut ----------------------------------------------------------------

async function onDevMockShortcut(e) {
  if (!matchChord(e, 'ctrl+shift+m')) return;
  // Guards every other global shortcut has and this one didn't: never fire
  // while typing, never fire over an open dialog.
  if (isTypingTarget(e.target) || anyModalOpen()) return;
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
    ctx.state.extractedQuestions = mock.questions || [];
    ctx.state.questionsReviewed = false;
    ctx.persist();
    ctx.renderAll();
    setStatus('Mock meeting loaded (dev shortcut).');
  } catch {
    // Packaged build or fetch-blocked environment: silently unavailable.
  }
}
