// In-app summary editor. Lets the operator review and adjust the AI summary
// (Key Takeaways, Key Insights, Decisions, Action Items, Key Figures, Topics)
// BEFORE the PDF is generated — the same "you're in control of what goes out"
// idea as the question-approval step. Edits ctx.state.summary in place.
//
// Key Takeaways vs Key Insights is a real distinction, not a synonym pair:
// takeaways record what happened at the meeting, insights are the lessons to
// apply afterwards. Both ship as their own PDF section.

import { openModal, closeModal } from './modalKit.js';
import { withKeptInsights, reconcileKept } from './liveInsights.js';

let ctx = null;
let onSaved = null;

let backdrop, takeawaysEl, insightsEl, decisionsEl, actionsHost, figuresEl,
  topicsEl, ownerOptions, addActionBtn, saveBtn, cancelBtn, importText,
  importBtn, importNote;

const PRIORITIES = ['high', 'normal', 'low'];

export function initSummaryEdit(context, opts) {
  ctx = context;
  onSaved = (opts && opts.onSaved) || function () {};

  backdrop = document.getElementById('summary-modal');
  takeawaysEl = document.getElementById('sum-takeaways');
  insightsEl = document.getElementById('sum-insights');
  decisionsEl = document.getElementById('sum-decisions');
  actionsHost = document.getElementById('sum-actions');
  figuresEl = document.getElementById('sum-figures');
  topicsEl = document.getElementById('sum-topics');
  ownerOptions = document.getElementById('summary-owner-options');
  addActionBtn = document.getElementById('sum-add-action');
  saveBtn = document.getElementById('sum-save-btn');
  cancelBtn = document.getElementById('sum-cancel-btn');

  importText = document.getElementById('sum-import-text');
  importBtn = document.getElementById('sum-import-btn');
  importNote = document.getElementById('sum-import-note');

  addActionBtn.addEventListener('click', () => actionsHost.append(buildActionRow({})));
  saveBtn.addEventListener('click', save);
  cancelBtn.addEventListener('click', close);
  if (importBtn) importBtn.addEventListener('click', applyImport);
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

// ---- Import AI output --------------------------------------------------------
// Accepts the JSON an external model produced from the "Copy AI prompt"
// harness (renderer-side mirror of the server's summarize._coerce — kept
// intentionally forgiving: markdown fences, chatter around the JSON, string
// action items, snake_case keys).

function stringList(data, keys) {
  for (const key of keys) {
    const raw = data[key];
    if (Array.isArray(raw)) {
      return raw
        .map((item) => String(item ?? '').replace(/^[-•*]\s*/, '').trim())
        .filter(Boolean);
    }
  }
  return [];
}

export function parseAiSummary(rawText) {
  let text = String(rawText || '').trim();
  if (!text) throw new Error('Paste the AI reply first.');
  // Strip a ```json fence, or dig the outermost {...} out of surrounding prose.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) text = fenced[1].trim();
  if (!text.startsWith('{')) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) {
      throw new Error('No JSON object found — paste the model\'s full JSON reply.');
    }
    text = text.slice(start, end + 1);
  }
  let root;
  try {
    root = JSON.parse(text);
  } catch {
    throw new Error('That JSON could not be parsed — copy the model\'s reply exactly.');
  }
  if (!root || typeof root !== 'object' || Array.isArray(root)) {
    throw new Error('Expected a JSON object with keyTakeaways/decisions/… sections.');
  }
  // Combined harness shape {summary:{…}, questions:[…]} (v0.5.0) or the
  // older flat summary object — accept both.
  const data =
    root.summary && typeof root.summary === 'object' && !Array.isArray(root.summary)
      ? root.summary
      : root;
  const questions = (Array.isArray(root.questions) ? root.questions : [])
    .map((q) => {
      if (!q || typeof q !== 'object') return null;
      const question = String(q.question || '').trim();
      if (!question) return null;
      const answerer = String(q.answerer || '').trim();
      const confidence =
        answerer && String(q.confidence || '').trim().toLowerCase() === 'high' ? 'high' : 'low';
      return {
        question,
        answer: String(q.answer || '').trim(),
        answerer,
        directedTo: String(q.directedTo || q.directed_to || '').trim(),
        confidence,
      };
    })
    .filter(Boolean);
  const actionsRaw = Array.isArray(data.actionItems)
    ? data.actionItems
    : Array.isArray(data.action_items) ? data.action_items : [];
  const actionItems = actionsRaw
    .map((item) => {
      if (typeof item === 'string') {
        const task = item.replace(/^[-•*]\s*/, '').trim();
        return task ? { task, owner: '', due: '', priority: 'normal' } : null;
      }
      if (!item || typeof item !== 'object') return null;
      const task = String(item.task || item.action || '').trim();
      if (!task) return null;
      const priority = String(item.priority || 'normal').trim().toLowerCase();
      return {
        task,
        owner: String(item.owner || item.assignee || '').trim(),
        due: String(item.due || item.dueDate || item.when || '').trim(),
        priority: ['high', 'normal', 'low'].includes(priority) ? priority : 'normal',
      };
    })
    .filter(Boolean);
  const summary = {
    keyTakeaways: stringList(data, ['keyTakeaways', 'key_takeaways']),
    keyInsights: stringList(data, ['keyInsights', 'key_insights', 'insights']),
    decisions: stringList(data, ['decisions', 'decisionsMade']),
    actionItems,
    keyFigures: stringList(data, ['keyFigures', 'key_figures', 'figures']),
    topics: stringList(data, ['topics', 'topicsDiscussed']),
  };
  if (
    !summary.keyTakeaways.length && !summary.keyInsights.length &&
    !summary.decisions.length && !summary.actionItems.length &&
    !summary.keyFigures.length && !summary.topics.length && !questions.length
  ) {
    throw new Error('The JSON parsed but contained no summary sections or questions.');
  }
  return { ...summary, questions };
}

async function applyImport() {
  if (!importText) return;
  try {
    const s = parseAiSummary(importText.value);
    takeawaysEl.value = linesToText(s.keyTakeaways);
    // Insights kept from the live rail lead — an import must not silently drop
    // what the operator picked by hand during the meeting.
    insightsEl.value = linesToText(withKeptInsights(ctx.state, s.keyInsights));
    decisionsEl.value = linesToText(s.decisions);
    figuresEl.value = linesToText(s.keyFigures);
    topicsEl.value = linesToText(s.topics);
    actionsHost.replaceChildren(...s.actionItems.map((item) => buildActionRow(item)));
    importText.value = '';
    let note = 'Imported — review the fields, then Save.';
    // Combined harness replies also carry Q&A candidates: feed them into the
    // same review-and-approve flow the local model uses (never auto-added).
    if (s.questions && s.questions.length) {
      const { captureExtracted, renderExtractPrompt } = await import('./extractReview.js');
      ctx.state.questionsReviewed = false;
      captureExtracted(s.questions);
      renderExtractPrompt();
      note = `Imported — ${s.questions.length} detected question(s) await review in the Q&A panel. Review the fields, then Save.`;
    }
    importNote.textContent = note;
  } catch (err) {
    importNote.textContent = err.message || String(err);
  }
}

export function openSummaryEdit() {
  if (importText) importText.value = '';
  if (importNote) importNote.textContent = '';
  const s = currentSummary();
  takeawaysEl.value = linesToText(s.keyTakeaways);
  insightsEl.value = linesToText(s.keyInsights);
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

  openModal(backdrop, takeawaysEl);
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
  const insights = textToLines(insightsEl.value);
  // An insight edited out here stays out: forget it as a kept one, or the next
  // AI run would re-assert it and quietly undo the edit.
  reconcileKept(ctx.state, insights);
  ctx.state.summary = {
    keyTakeaways: textToLines(takeawaysEl.value),
    keyInsights: insights,
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
  closeModal(backdrop);
}
