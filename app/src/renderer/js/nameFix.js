// Fix-names modal: whisper + the AI misspell people ("Kai", "Ky", "Kye"…).
// Lists every distinct name in the meeting; editing a box corrects that
// spelling EVERYWHERE (attendees, card participants, detected-question
// answerer/directedTo, summary action-item owners), and giving two entries
// the same name merges them into one person.

let ctx = null;
let onApplied = null;
let onStartAi = null;
let backdrop, rowsHost, noteEl, applyBtn, applyAiBtn;

export function initNameFix(context, opts) {
  ctx = context;
  onApplied = (opts && opts.onApplied) || function () {};
  onStartAi = (opts && opts.onStartAi) || null;
  backdrop = document.getElementById('names-modal');
  rowsHost = document.getElementById('names-rows');
  noteEl = document.getElementById('names-note');
  applyBtn = document.getElementById('names-apply-btn');
  applyAiBtn = document.getElementById('names-apply-ai-btn');

  applyBtn.addEventListener('click', () => apply(false));
  if (applyAiBtn) applyAiBtn.addEventListener('click', () => apply(true));
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

function buildRow(name, count, suggest) {
  const row = document.createElement('div');
  row.className = 'field name-fix-row';
  const label = document.createElement('label');
  label.textContent = count > 0 ? `${name} ×${count}` : name;
  if (suggest) label.textContent += ` → ${suggest}?`;
  const input = document.createElement('input');
  input.type = 'text';
  input.value = suggest || name; // a suggested merge target comes prefilled
  input.dataset.original = name;
  row.append(label, input);
  return row;
}

export async function openNameFix() {
  // Local names (attendees, cards, questions, owners) …
  const seen = new Map(); // casefold -> {name, count, suggest}
  for (const name of collectNames(ctx.state)) {
    seen.set(name.toLowerCase(), { name, count: 0, suggest: '' });
  }
  // … enriched with candidates harvested from the TRANSCRIPT itself, so
  // misspellings the AI would otherwise ingest surface for review first.
  const jobId = ctx.state.job && ctx.state.job.id;
  if (jobId && ctx.api && typeof ctx.api.getJobNames === 'function') {
    try {
      const { names } = await ctx.api.getJobNames(jobId);
      for (const cand of names || []) {
        const key = cand.name.toLowerCase();
        const existing = seen.get(key);
        if (existing) {
          existing.count = Math.max(existing.count, cand.count || 0);
          if (cand.suggest) existing.suggest = existing.suggest || cand.suggest;
        } else {
          seen.set(key, { name: cand.name, count: cand.count || 0, suggest: cand.suggest || '' });
        }
      }
    } catch {
      // Transcript scan is an enrichment — the local list still works.
    }
  }

  rowsHost.replaceChildren();
  noteEl.textContent = '';
  if (seen.size === 0) {
    noteEl.textContent = 'No names found in this meeting yet.';
  } else {
    noteEl.textContent = 'Corrections rewrite the transcript before the AI reads it.';
  }
  for (const entry of seen.values()) {
    rowsHost.append(buildRow(entry.name, entry.count, entry.suggest));
  }
  if (applyAiBtn) {
    applyAiBtn.hidden = !(
      jobId && onStartAi && ctx.api && typeof ctx.api.retrySummary === 'function'
    );
  }
  backdrop.hidden = false;
  const first = rowsHost.querySelector('input');
  if (first) first.focus();
}

async function apply(startAiAfter) {
  // original (casefolded) -> corrected spelling. Blank keeps the original.
  const mapping = new Map();
  for (const input of rowsHost.querySelectorAll('input')) {
    const from = input.dataset.original;
    const to = String(input.value || '').trim();
    if (to && to !== from) mapping.set(from.toLowerCase(), to);
  }
  if (mapping.size === 0) {
    close();
    if (startAiAfter && onStartAi) onStartAi(); // nothing to fix — just run
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

  // Mirror the corrections into the local transcript copy, and push the
  // mapping to the SERVER so the stored transcript (what the AI, prompts and
  // downloads read) is corrected too.
  const rawMapping = {};
  for (const input of rowsHost.querySelectorAll('input')) {
    const from = input.dataset.original;
    const to = String(input.value || '').trim();
    if (to && to !== from) rawMapping[from] = to;
  }
  if (state.transcript && state.transcript.text) {
    let text = state.transcript.text;
    for (const [from, to] of Object.entries(rawMapping)) {
      text = text.replace(new RegExp(`\\b${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), to);
    }
    state.transcript = { ...state.transcript, text };
  }
  const jobId = state.job && state.job.id;
  if (jobId && ctx.api && typeof ctx.api.applyJobNames === 'function') {
    try {
      await ctx.api.applyJobNames(jobId, rawMapping);
    } catch (err) {
      noteEl.textContent = `Saved locally, but the server rewrite failed: ${err.message}`;
      ctx.persist();
      onApplied(mapping.size);
      return; // keep the modal open so the operator sees the warning
    }
  }

  ctx.persist();
  close();
  onApplied(mapping.size);
  if (startAiAfter && onStartAi) onStartAi();
}
