// In-app summary editor. Lets the operator review and adjust the AI summary
// (Key Takeaways, Decisions, Action Items, Key Figures, Topics) BEFORE the PDF
// is generated — the same "you're in control of what goes out" idea as the
// question-approval step. Edits ctx.state.summary in place.

let ctx = null;
let onSaved = null;

let backdrop, takeawaysEl, decisionsEl, actionsHost, figuresEl, topicsEl,
  ownerOptions, addActionBtn, saveBtn, cancelBtn;

const PRIORITIES = ['high', 'normal', 'low'];

export function initSummaryEdit(context, opts) {
  ctx = context;
  onSaved = (opts && opts.onSaved) || function () {};

  backdrop = document.getElementById('summary-modal');
  takeawaysEl = document.getElementById('sum-takeaways');
  decisionsEl = document.getElementById('sum-decisions');
  actionsHost = document.getElementById('sum-actions');
  figuresEl = document.getElementById('sum-figures');
  topicsEl = document.getElementById('sum-topics');
  ownerOptions = document.getElementById('summary-owner-options');
  addActionBtn = document.getElementById('sum-add-action');
  saveBtn = document.getElementById('sum-save-btn');
  cancelBtn = document.getElementById('sum-cancel-btn');

  addActionBtn.addEventListener('click', () => actionsHost.append(buildActionRow({})));
  saveBtn.addEventListener('click', save);
  cancelBtn.addEventListener('click', close);
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(); });
  backdrop.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
  });
}

// The current structured summary, or one derived from a legacy prose string so
// Save never silently discards it. Null/empty starts blank for hand-authoring.
function currentSummary() {
  const s = ctx.state.summary;
  if (s && typeof s === 'object' && !Array.isArray(s)) return s;
  if (typeof s === 'string' && s.trim()) {
    // Legacy plain-prose summary: seed the takeaways with its paragraphs so the
    // content survives editing instead of being overwritten by an empty object.
    return { keyTakeaways: s.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean) };
  }
  return {};
}

function linesToText(list) {
  return (Array.isArray(list) ? list : []).filter(Boolean).join('\n');
}

function textToLines(text) {
  return String(text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

export function openSummaryEdit() {
  const s = currentSummary();
  takeawaysEl.value = linesToText(s.keyTakeaways);
  decisionsEl.value = linesToText(s.decisions);
  figuresEl.value = linesToText(s.keyFigures);
  topicsEl.value = linesToText(s.topics);

  // Owner suggestions = this meeting's attendees.
  const attendees = (ctx.state.details && ctx.state.details.attendees) || [];
  ownerOptions.replaceChildren(
    ...attendees.map((name) => {
      const o = document.createElement('option');
      o.value = name;
      return o;
    })
  );

  actionsHost.replaceChildren();
  const items = Array.isArray(s.actionItems) ? s.actionItems : [];
  if (items.length === 0) {
    actionsHost.append(buildActionRow({}));
  } else {
    items.forEach((a) => actionsHost.append(buildActionRow(a || {})));
  }

  backdrop.hidden = false;
  takeawaysEl.focus();
}

function buildActionRow(a) {
  const row = document.createElement('div');
  row.className = 'action-edit-row';

  const task = document.createElement('input');
  task.type = 'text';
  task.className = 'ae-task';
  task.placeholder = 'Task';
  task.value = a.task || '';

  const owner = document.createElement('input');
  owner.type = 'text';
  owner.className = 'ae-owner';
  owner.placeholder = 'Owner';
  owner.autocomplete = 'off';
  owner.setAttribute('list', 'summary-owner-options');
  owner.value = a.owner || '';

  const due = document.createElement('input');
  due.type = 'text';
  due.className = 'ae-due';
  due.placeholder = 'Due';
  due.value = a.due || '';

  const priority = document.createElement('select');
  priority.className = 'ae-priority';
  PRIORITIES.forEach((p) => {
    const o = document.createElement('option');
    o.value = p;
    o.textContent = p.charAt(0).toUpperCase() + p.slice(1);
    priority.append(o);
  });
  priority.value = PRIORITIES.includes(a.priority) ? a.priority : 'normal';

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'ae-del';
  del.textContent = '×';
  del.title = 'Remove this action item';
  del.setAttribute('aria-label', 'Remove action item');
  del.addEventListener('click', () => row.remove());

  row.append(task, owner, due, priority, del);
  return row;
}

function collectActions() {
  const out = [];
  actionsHost.querySelectorAll('.action-edit-row').forEach((row) => {
    const task = row.querySelector('.ae-task').value.trim();
    if (!task) return; // a row with no task is dropped
    out.push({
      task,
      owner: row.querySelector('.ae-owner').value.trim(),
      due: row.querySelector('.ae-due').value.trim(),
      priority: row.querySelector('.ae-priority').value,
    });
  });
  return out;
}

function save() {
  ctx.state.summary = {
    keyTakeaways: textToLines(takeawaysEl.value),
    decisions: textToLines(decisionsEl.value),
    actionItems: collectActions(),
    keyFigures: textToLines(figuresEl.value),
    topics: textToLines(topicsEl.value),
  };
  ctx.persist();
  close();
  onSaved();
}

function close() {
  backdrop.hidden = true;
}
