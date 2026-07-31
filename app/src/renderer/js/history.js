// Meeting history: save snapshots of past meetings and reopen them later
// (to review, regenerate the PDF, or re-send). Stored in localStorage,
// separate from the single "current meeting" state.

import { showError } from './status.js';
import { buildEmptyState } from './emptyState.js';
import { openModal, closeModal } from './modalKit.js';

const HISTORY_KEY = 'meetingmaster.history.v1';
const MAX_SNAPSHOTS = 60;

// Meeting fields worth snapshotting (everything needed to fully restore + reprint).
const SNAPSHOT_FIELDS = [
  'meetingId', 'details', 'cards', 'recipients', 'options', 'summary',
  'questions', 'extractedQuestions', 'questionsReviewed', 'transcript',
  'pdfPath', 'job', 'recording',
];

let ctx = null;
let onOpened = null;
let onStartFrom = null;
let backdrop, listHost, saveBtn, closeBtn;

export function initHistory(context, opts) {
  ctx = context;
  onOpened = (opts && opts.onOpened) || function () {};
  onStartFrom = (opts && opts.onStartFrom) || function () {};

  backdrop = document.getElementById('history-modal');
  listHost = document.getElementById('history-list');
  saveBtn = document.getElementById('history-save-btn');
  closeBtn = document.getElementById('history-close-btn');

  document.getElementById('history-btn').addEventListener('click', openHistory);
  saveBtn.addEventListener('click', () => {
    saveCurrentToHistory();
    renderList();
  });
  closeBtn.addEventListener('click', close);
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(); });
  backdrop.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
  });
}

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function store(list) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, MAX_SNAPSHOTS)));
  } catch {
    // Quota/unavailable storage should never break the app.
  }
}

// Does the current meeting hold anything worth keeping?
function hasContent() {
  const s = ctx.state;
  const hasSummary =
    s.summary && (typeof s.summary === 'string' ||
      (typeof s.summary === 'object' &&
        Object.values(s.summary).some((v) => Array.isArray(v) && v.length)));
  return Boolean(
    (s.details && s.details.title) ||
    (s.cards && s.cards.length) ||
    hasSummary
  );
}

// Upsert a snapshot of the current meeting, keyed by meetingId so re-saving the
// same meeting updates its entry instead of duplicating it. Returns true if saved.
export function saveCurrentToHistory() {
  if (!hasContent()) return false;
  const list = load();
  const snap = { savedAt: new Date().toISOString() };
  SNAPSHOT_FIELDS.forEach((f) => { snap[f] = ctx.state[f]; });
  if (!snap.meetingId) snap.meetingId = `m-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const idx = list.findIndex((s) => s.meetingId && s.meetingId === snap.meetingId);
  if (idx >= 0) list[idx] = snap;
  else list.unshift(snap);
  store(list);
  return true;
}

export function openHistory() {
  renderList();
  openModal(backdrop, closeBtn);
}

function fmtSaved(iso) {
  // Best-effort local datetime; falls back to the raw string.
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso || '';
    return d.toLocaleString();
  } catch {
    return iso || '';
  }
}

function renderList() {
  const list = load();
  listHost.replaceChildren();

  if (list.length === 0) {
    listHost.append(
      buildEmptyState({
        icon: 'clock',
        title: 'No saved meetings yet',
        hint: 'Generating a PDF saves one automatically — or click “Save current”.',
      })
    );
    return;
  }

  list.forEach((snap) => {
    const row = document.createElement('div');
    row.className = 'history-row';

    const info = document.createElement('div');
    info.className = 'history-info';
    const title = document.createElement('div');
    title.className = 'history-title';
    title.textContent = (snap.details && snap.details.title) || 'Untitled meeting';
    const meta = document.createElement('div');
    meta.className = 'history-meta';
    const date = (snap.details && snap.details.date) || '';
    const n = (snap.cards && snap.cards.length) || 0;
    meta.textContent =
      `${date ? date + ' · ' : ''}${n} question${n === 1 ? '' : 's'} · saved ${fmtSaved(snap.savedAt)}`;
    info.append(title, meta);

    const actions = document.createElement('div');
    actions.className = 'history-actions';

    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'btn btn-secondary btn-small';
    open.textContent = 'Open';
    open.addEventListener('click', () => openSnapshot(snap));

    const reuse = document.createElement('button');
    reuse.type = 'button';
    reuse.className = 'btn btn-secondary btn-small';
    reuse.textContent = 'Start like this';
    reuse.title =
      'Start a NEW meeting with this one\u2019s title, attendees and recipients — ' +
      'and none of its content';
    reuse.addEventListener('click', () => startFrom(snap));

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn btn-secondary btn-small history-del';
    del.textContent = 'Delete';
    del.addEventListener('click', () => {
      if (!confirm('Delete this saved meeting? This cannot be undone.')) return;
      store(load().filter((s) => s.meetingId !== snap.meetingId));
      renderList();
    });

    actions.append(open, reuse, del);
    row.append(info, actions);
    listHost.append(row);
  });
}

// The same people, the same title, the same distribution list, week after
// week — and today none of it carries over, so a recurring review costs two
// minutes of retyping before anyone has said anything. This copies the SETUP
// and nothing else: no cards, no recording, no transcript, no summary, no job.
function startFrom(snap) {
  if (typeof ctx.recActive === 'function' && ctx.recActive()) {
    showError('A recording is in progress — stop or discard it before starting a new meeting.');
    return;
  }
  // app.js owns the reset (and snapshotting the outgoing meeting to History,
  // exactly as "New meeting" does) — this only says what to seed it with.
  const details = (snap.details && typeof snap.details === 'object') ? snap.details : {};
  onStartFrom({
    details: {
      title: details.title || '',
      // Today's meeting is today's, whatever the template says.
      date: todayIso(),
      time: details.time || '11:00',
      attendees: Array.isArray(details.attendees) ? [...details.attendees] : [],
    },
    recipients: Array.isArray(snap.recipients) ? [...snap.recipients] : [],
    options: snap.options && typeof snap.options === 'object' ? { ...snap.options } : null,
  });
  close();
}

// Local (not UTC) yyyy-mm-dd — the same rule app.js uses for a new meeting.
function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate()
  ).padStart(2, '0')}`;
}

function openSnapshot(snap) {
  if (typeof ctx.recActive === 'function' && ctx.recActive()) {
    showError('A recording is in progress — stop or discard it before opening a saved meeting.');
    return;
  }
  const cur = ctx.state;
  const dirty = hasContent() && (!cur.meetingId || cur.meetingId !== snap.meetingId);
  if (dirty && !confirm(
    'Open this saved meeting? Save the current one first if you want to keep it — ' +
    'it will be replaced by what you open.'
  )) {
    return;
  }
  // Preserve the current meeting so it isn't lost by opening another.
  if (dirty) saveCurrentToHistory();

  SNAPSHOT_FIELDS.forEach((f) => {
    if (snap[f] !== undefined) ctx.state[f] = snap[f];
  });
  // Legacy snapshots predate audio attachments — never leave another
  // meeting's recording attached to the one just opened.
  if (snap.recording === undefined) ctx.state.recording = null;
  ctx.persist();
  close();
  onOpened();
}

function close() {
  closeModal(backdrop);
}
