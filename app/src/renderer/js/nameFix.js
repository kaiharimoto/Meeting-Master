// Fix-names modal: whisper + the AI misspell people ("Kai", "Ky", "Kye"…).
// Lists every distinct name in the meeting; editing a box corrects that
// spelling EVERYWHERE (attendees, card participants, detected-question
// answerer/directedTo, summary action-item owners), and giving two entries
// the same name merges them into one person.

let ctx = null;
let onApplied = null;
let backdrop, rowsHost, noteEl;

export function initNameFix(context, opts) {
  ctx = context;
  onApplied = (opts && opts.onApplied) || function () {};
  backdrop = document.getElementById('names-modal');
  rowsHost = document.getElementById('names-rows');
  noteEl = document.getElementById('names-note');

  document.getElementById('names-apply-btn').addEventListener('click', apply);
  document.getElementById('names-cancel-btn').addEventListener('click', close);
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) close();
  });
  backdrop.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  });
}

function close() {
  backdrop.hidden = true;
}

/** Every distinct name in the meeting, in first-seen order. */
export function collectNames(state) {
  const seen = new Map(); // casefolded -> original spelling first seen
  const add = (name) => {
    const trimmed = String(name || '').trim();
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    if (!seen.has(key)) seen.set(key, trimmed);
  };
  for (const a of (state.details && state.details.attendees) || []) add(a);
  for (const c of state.cards || []) add(c.participant);
  for (const q of state.extractedQuestions || []) {
    add(q.answerer);
    add(q.directedTo);
  }
  const s = state.summary;
  if (s && typeof s === 'object' && Array.isArray(s.actionItems)) {
    for (const item of s.actionItems) add(item && item.owner);
  }
  return [...seen.values()];
}

export function openNameFix() {
  const names = collectNames(ctx.state);
  rowsHost.replaceChildren();
  noteEl.textContent = '';
  if (names.length === 0) {
    noteEl.textContent = 'No names found in this meeting yet.';
  }
  for (const name of names) {
    const row = document.createElement('div');
    row.className = 'field name-fix-row';
    const label = document.createElement('label');
    label.textContent = name;
    const input = document.createElement('input');
    input.type = 'text';
    input.value = name;
    input.dataset.original = name;
    row.append(label, input);
    rowsHost.append(row);
  }
  backdrop.hidden = false;
  const first = rowsHost.querySelector('input');
  if (first) first.focus();
}

function apply() {
  // original (casefolded) -> corrected spelling. Blank keeps the original.
  const mapping = new Map();
  for (const input of rowsHost.querySelectorAll('input')) {
    const from = input.dataset.original;
    const to = String(input.value || '').trim();
    if (to && to !== from) mapping.set(from.toLowerCase(), to);
  }
  if (mapping.size === 0) {
    close();
    return;
  }
  const fix = (name) => {
    const trimmed = String(name || '').trim();
    return mapping.get(trimmed.toLowerCase()) || trimmed;
  };

  const state = ctx.state;
  // Attendees: rename, then merge duplicates (case-insensitive, keep first).
  const attendees = [];
  const seen = new Set();
  for (const a of (state.details && state.details.attendees) || []) {
    const fixed = fix(a);
    if (!fixed || seen.has(fixed.toLowerCase())) continue;
    seen.add(fixed.toLowerCase());
    attendees.push(fixed);
  }
  if (state.details) state.details.attendees = attendees;

  for (const c of state.cards || []) c.participant = fix(c.participant);
  for (const q of state.extractedQuestions || []) {
    q.answerer = fix(q.answerer);
    q.directedTo = fix(q.directedTo);
  }
  const s = state.summary;
  if (s && typeof s === 'object' && Array.isArray(s.actionItems)) {
    for (const item of s.actionItems) {
      if (item) item.owner = fix(item.owner);
    }
  }

  ctx.persist();
  close();
  onApplied(mapping.size);
}
