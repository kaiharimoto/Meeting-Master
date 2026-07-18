// AI question-review flow. When the home server finishes, it returns candidate
// Q&A pairs it detected in the transcript. These are NEVER added to the meeting
// automatically — this module surfaces a "Review N detected questions" prompt,
// and an approval modal where the operator culls the list, fixes the answerer,
// and adds the kept ones as ordinary (editable) Q&A cards.

import { setStatus } from './status.js';

let ctx = null;
let onCardsAdded = null;

// Q&A panel prompt (banner + button) shown when there are unreviewed candidates.
let promptHost = null;

// Modal elements.
let backdrop, listHost, countEl, datalist, addBtn, cancelBtn, allBtn, noneBtn;

// Per-open working set: one entry per candidate row.
let rows = [];

function makeId() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return window.crypto.randomUUID();
  }
  return `card-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function pending() {
  const qs = ctx.state.extractedQuestions;
  return Array.isArray(qs) ? qs : [];
}

export function initExtractReview(context, opts) {
  ctx = context;
  onCardsAdded = (opts && opts.onCardsAdded) || function () {};

  promptHost = document.getElementById('extract-review');
  backdrop = document.getElementById('extract-modal');
  listHost = document.getElementById('extract-list');
  countEl = document.getElementById('extract-selected-count');
  datalist = document.getElementById('extract-participant-options');
  addBtn = document.getElementById('extract-add-btn');
  cancelBtn = document.getElementById('extract-cancel-btn');
  allBtn = document.getElementById('extract-all-btn');
  noneBtn = document.getElementById('extract-none-btn');

  addBtn.addEventListener('click', addSelected);
  cancelBtn.addEventListener('click', closeModal);
  allBtn.addEventListener('click', () => setAll(true));
  noneBtn.addEventListener('click', () => setAll(false));

  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) closeModal();
  });
  backdrop.addEventListener('keydown', onModalKeydown);
}

// Visible, enabled focusable controls inside the modal, in DOM order.
function focusables() {
  return Array.from(
    backdrop.querySelectorAll('button, input, [tabindex]:not([tabindex="-1"])')
  ).filter((el) => !el.disabled && el.offsetParent !== null);
}

// Escape closes; Tab is trapped so focus can never leave the modal (matching
// the card-capture modal). Without the trap, Tab past the last control would
// escape to the page behind the backdrop and Escape would stop working.
function onModalKeydown(e) {
  if (e.key === 'Escape') {
    e.preventDefault();
    closeModal();
    return;
  }
  if (e.key !== 'Tab') return;
  const items = focusables();
  if (items.length === 0) return;
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  if (e.shiftKey && (active === first || !backdrop.contains(active))) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (active === last || !backdrop.contains(active))) {
    e.preventDefault();
    first.focus();
  }
}

// Show/hide the "N detected questions" prompt in the Q&A panel.
export function renderExtractPrompt() {
  if (!promptHost) return;
  const n = pending().length;
  if (n === 0 || ctx.state.questionsReviewed) {
    promptHost.hidden = true;
    promptHost.replaceChildren();
    return;
  }

  promptHost.hidden = false;
  promptHost.replaceChildren();

  const text = document.createElement('span');
  text.className = 'extract-review-text';
  const strong = document.createElement('strong');
  strong.textContent = String(n);
  text.append('The AI detected ', strong, n === 1 ? ' question' : ' questions', ' in the recording.');

  const review = document.createElement('button');
  review.type = 'button';
  review.className = 'btn btn-primary btn-small';
  review.textContent = 'Review & add';
  review.addEventListener('click', openExtractModal);

  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'btn btn-secondary btn-small';
  dismiss.textContent = 'Dismiss';
  dismiss.addEventListener('click', () => {
    ctx.state.questionsReviewed = true;
    ctx.persist();
    renderExtractPrompt();
  });

  promptHost.append(text, review, dismiss);
}

export function openExtractModal() {
  const candidates = pending();
  if (candidates.length === 0) return;

  // Populate the answerer datalist from this meeting's attendees.
  const attendees = (ctx.state.details && ctx.state.details.attendees) || [];
  datalist.replaceChildren(
    ...attendees.map((name) => {
      const option = document.createElement('option');
      option.value = name;
      return option;
    })
  );

  rows = [];
  listHost.replaceChildren();
  candidates.forEach((q, i) => listHost.append(buildRow(q, i)));

  backdrop.hidden = false;
  updateCount();
  addBtn.focus();
}

function buildRow(candidate, index) {
  const row = document.createElement('div');
  row.className = 'extract-row';

  const check = document.createElement('input');
  check.type = 'checkbox';
  check.checked = true; // default-included; culling = unchecking
  check.className = 'extract-check';
  check.id = `extract-check-${index}`;
  check.setAttribute('aria-label', `Keep question: ${candidate.question}`);
  check.addEventListener('change', () => {
    row.classList.toggle('is-off', !check.checked);
    updateCount();
  });

  const content = document.createElement('div');
  content.className = 'extract-content';

  const q = document.createElement('label');
  q.className = 'extract-q';
  q.setAttribute('for', check.id);
  q.textContent = candidate.question || '';
  content.append(q);

  if (candidate.answer) {
    const a = document.createElement('div');
    a.className = 'extract-a';
    a.textContent = candidate.answer;
    content.append(a);
  }

  const meta = document.createElement('div');
  meta.className = 'extract-meta';

  const answererLabel = document.createElement('label');
  answererLabel.className = 'extract-answerer-label';
  answererLabel.append('Answered by ');
  const answerer = document.createElement('input');
  answerer.type = 'text';
  answerer.className = 'extract-answerer';
  answerer.autocomplete = 'off';
  answerer.setAttribute('list', 'extract-participant-options');
  answerer.value = candidate.answerer || '';
  answerer.placeholder = 'Who answered?';
  answererLabel.append(answerer);
  meta.append(answererLabel);

  // Lower-confidence culling aid: who the question seemed aimed at, when the
  // model guessed someone other than the answerer.
  if (candidate.directedTo && candidate.directedTo !== candidate.answerer) {
    const directed = document.createElement('span');
    directed.className = 'extract-directed';
    directed.textContent = `directed to ${candidate.directedTo}`;
    meta.append(directed);
  }

  content.append(meta);

  const checkWrap = document.createElement('div');
  checkWrap.className = 'extract-check-wrap';
  checkWrap.append(check);

  row.append(checkWrap, content);
  rows.push({ candidate, check, answerer });
  return row;
}

function setAll(state) {
  rows.forEach((r) => {
    r.check.checked = state;
    r.check.closest('.extract-row').classList.toggle('is-off', !state);
  });
  updateCount();
}

function updateCount() {
  const selected = rows.filter((r) => r.check.checked).length;
  countEl.textContent = `${selected} of ${rows.length} selected`;
  addBtn.disabled = selected === 0;
}

function addSelected() {
  const kept = rows.filter((r) => r.check.checked);
  if (kept.length === 0) return;

  kept.forEach((r) => {
    ctx.state.cards.push({
      id: makeId(),
      question: r.candidate.question || '',
      answer: r.candidate.answer || '',
      participant: r.answerer.value.trim(),
    });
  });

  // Reviewed: clear the candidates so the prompt disappears and re-opening the
  // modal can't double-add. Kept items now live as editable cards.
  ctx.state.extractedQuestions = [];
  ctx.state.questionsReviewed = true;
  ctx.persist();

  closeModal();
  onCardsAdded();
  renderExtractPrompt();
  setStatus(
    kept.length === 1
      ? 'Added 1 question to the Q&A list.'
      : `Added ${kept.length} questions to the Q&A list.`
  );
}

function closeModal() {
  backdrop.hidden = true;
  rows = [];
  listHost.replaceChildren();
}
