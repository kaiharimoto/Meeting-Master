// AI question-review flow. When the home server finishes, it returns candidate
// Q&A pairs it detected in the transcript. These are NEVER added to the meeting
// automatically — this module surfaces a "Review N detected questions" prompt,
// and an approval modal where the operator culls the list, fixes the answerer,
// and adds the kept ones as ordinary (editable) Q&A cards.

import { setStatus } from './status.js';
import { openModal, closeModal } from './modalKit.js';

let ctx = null;
let onCardsAdded = null;

// Q&A panel prompt (banner + button) shown when there are unreviewed candidates.
let promptHost = null;

// Modal elements.
let backdrop, listHost, countEl, datalist, addBtn, cancelBtn, allBtn, noneBtn;

// Per-open working set: one entry per candidate row.
let rows = [];

export function makeId() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return window.crypto.randomUUID();
  }
  return `card-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function pending() {
  const qs = ctx.state.extractedQuestions;
  return Array.isArray(qs) ? qs : [];
}

// ---- De-dupe extracted questions against cards the operator already typed ---

// Common function words are ignored when matching so they can't, on their own,
// make two genuinely different questions look like duplicates.
const STOPWORDS = new Set([
  'the', 'and', 'for', 'was', 'are', 'were', 'been', 'this', 'that', 'with',
  'you', 'your', 'our', 'their', 'they', 'them', 'how', 'who', 'what', 'when',
  'where', 'which', 'will', 'would', 'could', 'can', 'should', 'about', 'into',
  'from', 'have', 'has', 'had', 'does', 'did', 'any', 'not', 'but', 'get',
]);

export function normQ(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Content words only: length > 2 and not a stopword.
function tokenSet(norm) {
  return new Set(norm.split(' ').filter((w) => w.length > 2 && !STOPWORDS.has(w)));
}

// True when two questions are the same or near-identical. Uses Jaccard overlap
// for near-identical wording, plus a containment check (on CONTENT words) so a
// short typed question sitting inside a longer AI phrasing also counts as a
// duplicate — but requires ≥ 2 shared content words so a single common word
// can't collapse two distinct questions.
export function isDuplicate(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const sa = tokenSet(a);
  const sb = tokenSet(b);
  if (sa.size === 0 || sb.size === 0) return false;
  let shared = 0;
  sa.forEach((w) => { if (sb.has(w)) shared += 1; });
  const union = sa.size + sb.size - shared;
  const jaccard = union > 0 ? shared / union : 0;
  const smaller = Math.min(sa.size, sb.size);
  const containment = smaller > 0 ? shared / smaller : 0;
  return jaccard >= 0.7 || (smaller >= 2 && shared >= 2 && containment >= 0.9);
}

// Capture AI candidates into state, dropping any that duplicate an existing
// manual card (the operator already typed that question during the meeting)
// or a live candidate the operator already dismissed mid-meeting. Un-actioned
// LIVE candidates are merged in (the post-meeting version wins on duplicates
// — better model, full transcript) so nothing flagged live silently vanishes.
export function captureExtracted(questions) {
  const list = Array.isArray(questions) ? questions : [];
  const existing = (ctx.state.cards || []).map((c) => normQ(c.question)).filter(Boolean);
  const lf = ctx.state.liveFlags || {};
  const dismissed = Array.isArray(lf.dismissed) ? lf.dismissed : [];
  const livePending = Array.isArray(lf.pending) ? lf.pending : [];

  const deduped = list.filter((q) => {
    if (!q || !q.question) return false;
    const nq = normQ(q.question);
    return (
      !existing.some((e) => isDuplicate(nq, e)) &&
      !dismissed.some((d) => isDuplicate(nq, d))
    );
  });

  const carriedLive = livePending.filter((p) => {
    if (!p || !p.question) return false;
    const np = normQ(p.question);
    return (
      np &&
      !deduped.some((q) => isDuplicate(np, normQ(q.question))) &&
      !existing.some((e) => isDuplicate(np, e))
    );
  });

  ctx.state.extractedQuestions = [...deduped, ...carriedLive];
  if (livePending.length > 0) {
    lf.pending = [];
    // liveFlags.js re-renders (empties) its inline list on this event —
    // a DOM event avoids an import cycle between the two modules.
    document.dispatchEvent(new CustomEvent('mm:liveflags'));
  }
  return ctx.state.extractedQuestions.length;
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
  cancelBtn.addEventListener('click', close);
  allBtn.addEventListener('click', () => setAll(true));
  noneBtn.addEventListener('click', () => setAll(false));

  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) close();
  });
  backdrop.addEventListener('keydown', onModalKeydown);
}

// Escape closes. Tab is trapped by modalKit, which owns that behaviour for
// every dialog (this module used to carry its own copy).
function onModalKeydown(e) {
  if (e.key === 'Escape') {
    e.preventDefault();
    close();
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

  updateCount();
  openModal(backdrop, addBtn);
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

  // Confidence flag: the AI wasn't sure who answered — worth a glance before
  // you approve it. (Empty answerer is always low-confidence server-side.)
  const lowConfidence = candidate.confidence === 'low';
  if (lowConfidence) {
    row.classList.add('is-unsure');
    const flag = document.createElement('span');
    flag.className = 'extract-flag';
    flag.textContent = 'check answerer';
    flag.title = 'The AI was unsure who answered — please confirm.';
    meta.append(flag);
  }

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

  close();
  onCardsAdded();
  renderExtractPrompt();
  setStatus(
    kept.length === 1
      ? 'Added 1 question to the Q&A list.'
      : `Added ${kept.length} questions to the Q&A list.`
  );
}

function close() {
  closeModal(backdrop);
  rows = [];
  listHost.replaceChildren();
}
