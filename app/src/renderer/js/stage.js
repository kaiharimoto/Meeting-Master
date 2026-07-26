// Stage-aware Meeting screen shell.
//
// The workflow has clean, detectable stages; this module derives the current
// one from existing state (nothing new is persisted) and adapts the screen:
// panels that don't matter right now collapse to a one-line summary, a
// next-step strip names the single action that matters, and exactly ONE
// button is visually promoted. The UI suggests, never fights: clicking a
// panel header toggles it manually, and a manual choice sticks until the
// stage changes (or New meeting).
//
// Stages:
//   setup      – blank/being filled, nothing recorded
//   live       – recording running (recorder.js recActive)
//   captured   – a recording is attached, no job yet
//   processing – job queued/normalizing/transcribing/summarizing
//   review     – transcript/summary/pdf present — the polish-and-send phase
//   done       – emailed

let ctx = null;
let els = null;
let currentStage = null;
// Per-stage manual overrides: panelId -> true (collapsed) | false (expanded).
let overrides = {};

const PANEL_IDS = ['panel-details', 'panel-qa', 'panel-record', 'panel-generate'];

// Which panels collapse by default in each stage.
const COLLAPSED = {
  setup: ['panel-generate'],
  live: ['panel-details', 'panel-generate'],
  captured: ['panel-details'],
  processing: ['panel-details', 'panel-record'],
  review: ['panel-details', 'panel-record'],
  done: ['panel-details', 'panel-record', 'panel-qa'],
};

const BUSY_JOB_STATES = ['queued', 'normalizing', 'transcribing', 'summarizing'];

export function initStage(context) {
  ctx = context;
  els = {
    screen: document.getElementById('screen-meeting'),
    strip: document.getElementById('next-step'),
    stripText: document.getElementById('next-step-text'),
    panels: PANEL_IDS.map((id) => document.getElementById(id)).filter(Boolean),
  };
  if (!els.screen || els.panels.length === 0) return;

  for (const panel of els.panels) {
    const header = panel.querySelector('h2');
    if (!header) continue;
    header.classList.add('stage-toggle');

    // The heading's contents move INSIDE a real button. An <h2> with a click
    // handler is invisible to the keyboard, and collapsed content is
    // display:none — so before this, a keyboard user could not reach a
    // collapsed panel at all. The button lives inside the h2 so the heading
    // keeps its semantics and the section's aria-labelledby chain still
    // resolves to this text.
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'panel-toggle';
    toggle.setAttribute('aria-expanded', 'true');
    while (header.firstChild) toggle.append(header.firstChild);
    header.append(toggle);

    toggle.addEventListener('click', () => {
      const collapsed = panel.classList.contains('is-collapsed');
      overrides[panel.id] = !collapsed; // remember the user's choice this stage
      panel.classList.toggle('is-collapsed', !collapsed);
      toggle.setAttribute('aria-expanded', String(collapsed));
      renderSummaries();
    });

    // Summary line shown only while collapsed.
    const summary = document.createElement('div');
    summary.className = 'panel-summary';
    header.closest('.panel-heading-row')
      ? header.closest('.panel-heading-row').after(summary)
      : header.after(summary);
  }

  document.addEventListener('mm:job', refreshStage);
  document.addEventListener('mm:stage', refreshStage);
  refreshStage();
}

function computeStage() {
  const s = ctx.state;
  const job = s.job || {};
  if (typeof ctx.recActive === 'function' && ctx.recActive()) return 'live';
  if (job.id && BUSY_JOB_STATES.includes(job.state)) return 'processing';
  if (job.state === 'emailed') return 'done';
  if (s.transcript || s.summary || s.pdfPath || job.state === 'ready' || job.state === 'pdf_received') {
    return 'review';
  }
  if (s.recording && s.recording.filePath) return 'captured';
  return 'setup';
}

// The one action that matters right now: [text, promoted button id | null].
function nextStep(stage) {
  const s = ctx.state;
  switch (stage) {
    case 'live':
      return ['Recording. Capture Q&A with Q — stop when the meeting ends.', 'rec-stop-btn'];
    case 'captured':
      return ["Recording attached — generate the transcript when you're ready.", 'pick-audio-btn'];
    case 'processing':
      return ['The home server is working on it — progress shows below.', null];
    case 'review':
      if (s.transcript && !s.summary) {
        return ['Transcript ready — check the names, then Start AI.', 'start-ai-btn'];
      }
      if (s.summary && !s.pdfPath) {
        return ['Summary ready — review it, then generate the PDF.', 'generate-pdf-btn'];
      }
      if (s.pdfPath) return ['PDF ready — open it, then send the email.', 'send-email-btn'];
      return ['Review the results, then generate the PDF.', 'generate-pdf-btn'];
    case 'done':
      return ["Emailed. Start a new meeting whenever you're ready.", 'new-meeting-btn'];
    default:
      return ['Fill in the details, then start recording when the meeting begins.', 'rec-start-btn'];
  }
}

export function refreshStage() {
  if (!ctx || !els || !els.screen) return;
  const stage = computeStage();
  if (stage !== currentStage) {
    currentStage = stage;
    overrides = {}; // stage transitions re-apply defaults; user re-overrides freely
  }
  els.screen.dataset.stage = stage;

  const collapsedDefaults = COLLAPSED[stage] || [];
  for (const panel of els.panels) {
    const collapsed =
      overrides[panel.id] !== undefined
        ? overrides[panel.id]
        : collapsedDefaults.includes(panel.id);
    panel.classList.toggle('is-collapsed', collapsed);
    const toggle = panel.querySelector('.panel-toggle');
    if (toggle) toggle.setAttribute('aria-expanded', String(!collapsed));
  }

  const [text, promotedId] = nextStep(stage);
  if (els.strip && els.stripText) {
    els.strip.hidden = false;
    els.stripText.textContent = text;
  }
  for (const btn of document.querySelectorAll('.btn-promoted')) {
    btn.classList.remove('btn-promoted');
  }
  if (promotedId) {
    const btn = document.getElementById(promotedId);
    if (btn) btn.classList.add('btn-promoted');
  }

  renderSummaries();
}

function renderSummaries() {
  const s = ctx.state;
  const d = s.details || {};
  const attendees = Array.isArray(d.attendees) ? d.attendees.length : 0;
  const cards = (s.cards || []).length;
  const rec = s.recording;
  setSummary(
    'panel-details',
    [d.title || 'Untitled meeting', [d.date, d.time].filter(Boolean).join(' '), `${attendees} attendee${attendees === 1 ? '' : 's'}`]
      .filter(Boolean)
      .join(' · ')
  );
  setSummary('panel-qa', cards === 0 ? 'No questions captured' : `${cards} question${cards === 1 ? '' : 's'} captured`);
  setSummary(
    'panel-record',
    rec && rec.filePath
      ? `Recording attached — ${fmtDur(rec.durationMs)}`
      : 'No recording attached'
  );
  setSummary('panel-generate', nextStep(currentStage || 'setup')[0]);
}

function setSummary(panelId, text) {
  const panel = document.getElementById(panelId);
  if (!panel) return;
  const summary = panel.querySelector('.panel-summary');
  if (summary) summary.textContent = text;
}

function fmtDur(ms) {
  const totalSec = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  const m = Math.floor(totalSec / 60);
  return m >= 1 ? `${m} min` : `${totalSec} s`;
}
