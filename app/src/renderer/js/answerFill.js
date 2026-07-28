// Draft the answers the operator didn't have time to write.
//
// THE PROBLEM THIS SOLVES. A question is asked at 11:03. You type it down in
// two seconds. The answer arrives at 11:06, after three minutes of discussion,
// by which time you are writing down the next question. So you leave the answer
// blank and mean to come back to it — and by the end of the meeting there are
// six blanks and no memory of six answers.
//
// Every card carries the moment it was captured (capture.js stamps atMs), and
// whisper.cpp gives the server per-segment timestamps. Put those together and
// the server can read the ninety seconds of conversation that FOLLOWED each
// question and draft its answer, instead of hunting the whole transcript.
//
// The result is suggestions. Nothing reaches a card until the operator ticks it
// — the same contract as the AI-detected questions review, and the same UI
// language, because it is the same kind of decision.

import { setStatus, showError } from './status.js';
import { openModal, closeModal } from './modalKit.js';
import { updateCard } from './cardList.js';
import { offerAttendees } from './attendees.js';

let ctx = null;
let onCardsChanged = null;
let backdrop, listHost, addBtn, cancelBtn, countEl, introEl, datalist;
let rows = []; // [{cardId, check, answerInput, answererInput}]

export function initAnswerFill(context, opts = {}) {
  ctx = context;
  onCardsChanged = opts.onCardsChanged || function () {};

  backdrop = document.getElementById('answers-modal');
  listHost = document.getElementById('answers-list');
  addBtn = document.getElementById('answers-apply-btn');
  cancelBtn = document.getElementById('answers-cancel-btn');
  countEl = document.getElementById('answers-count');
  introEl = document.getElementById('answers-intro');
  datalist = document.getElementById('extract-participant-options');
  if (!backdrop || !listHost) return;

  addBtn.addEventListener('click', applySelected);
  cancelBtn.addEventListener('click', close);
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) close();
  });
  backdrop.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  });

  const btn = document.getElementById('fill-answers-btn');
  if (btn) btn.addEventListener('click', () => fillBlankAnswers());
}

/** Cards with a question and no answer, in list order. */
export function blankCards() {
  return (ctx.state.cards || []).filter(
    (c) => c && c.question && !String(c.answer || '').trim()
  );
}

/** Enable/disable the button from the current state. Called by updateButtons. */
export function refreshFillButton() {
  const btn = document.getElementById('fill-answers-btn');
  if (!btn || !ctx) return;
  const jobId = ctx.state.job && ctx.state.job.id;
  const n = blankCards().length;
  btn.disabled = !(jobId && ctx.state.transcript && n > 0);
  btn.title = n
    ? `Read the transcript around each of the ${n} unanswered question${n === 1 ? '' : 's'} and draft its answer`
    : 'Every question already has an answer';
}

async function fillBlankAnswers() {
  const api = ctx.api;
  if (!api || typeof api.draftAnswers !== 'function') {
    showError('Drafting answers needs the desktop app and a newer preload.');
    return;
  }
  const jobId = ctx.state.job && ctx.state.job.id;
  if (!jobId) {
    showError('Upload the meeting first — answers are drafted from its transcript.');
    return;
  }
  const blanks = blankCards();
  if (blanks.length === 0) {
    setStatus('Every question already has an answer.');
    return;
  }

  setStatus(
    `Reading the transcript around ${blanks.length} unanswered question${blanks.length === 1 ? '' : 's'}…`,
    { busy: true }
  );
  try {
    const { answers } = await api.draftAnswers(
      jobId,
      blanks.map((c) => ({
        id: c.id,
        question: c.question,
        // Cards captured outside a recording have no stamp; the server reads
        // the whole transcript for those rather than refusing.
        atMs: typeof c.atMs === 'number' ? c.atMs : null,
      })),
      (ctx.state.details && ctx.state.details.attendees) || []
    );
    openReview(Array.isArray(answers) ? answers : []);
  } catch (err) {
    showError(err && err.message ? err.message : String(err));
  }
}

function openReview(answers) {
  // A drafted blank is the model saying "the transcript doesn't answer this",
  // which is a real answer to the operator but not one worth a review row.
  const found = answers.filter((a) => a && String(a.answer || '').trim());
  const empty = answers.length - found.length;

  if (found.length === 0) {
    setStatus(
      'The transcript did not answer any of the blank questions — they may have ' +
        'been answered after the recording stopped, or not at all.'
    );
    return;
  }

  refreshDatalist();
  rows = [];
  listHost.replaceChildren();
  for (const answer of found) {
    const card = (ctx.state.cards || []).find((c) => c.id === answer.id);
    if (!card) continue; // deleted while the request was in flight
    listHost.append(buildRow(card, answer));
  }

  introEl.textContent =
    empty > 0
      ? `Drafted ${found.length} answer${found.length === 1 ? '' : 's'} from the transcript. ` +
        `${empty} question${empty === 1 ? ' had' : 's had'} no answer in the recording and ${empty === 1 ? 'is' : 'are'} left blank.`
      : `Drafted ${found.length} answer${found.length === 1 ? '' : 's'} from the transcript.`;

  updateCount();
  setStatus(`Drafted ${found.length} answer${found.length === 1 ? '' : 's'} — review them.`);
  openModal(backdrop, addBtn);
}

function refreshDatalist() {
  if (!datalist) return;
  const attendees = (ctx.state.details && ctx.state.details.attendees) || [];
  datalist.replaceChildren(
    ...attendees.map((name) => {
      const option = document.createElement('option');
      option.value = name;
      return option;
    })
  );
}

function buildRow(card, answer) {
  const row = document.createElement('div');
  row.className = 'extract-row answer-row';
  if (answer.confidence === 'low') row.classList.add('is-unsure');

  const check = document.createElement('input');
  check.type = 'checkbox';
  check.className = 'extract-check';
  // Low-confidence drafts start UNTICKED: the operator opts in to the ones the
  // model was unsure about, rather than opting out of them.
  check.checked = answer.confidence !== 'low';
  check.setAttribute('aria-label', `Use this answer for: ${card.question}`);
  check.addEventListener('change', updateCount);
  row.append(check);

  const body = document.createElement('div');
  body.className = 'extract-body';

  const q = document.createElement('div');
  q.className = 'extract-q';
  q.textContent = card.question;
  body.append(q);

  const answerInput = document.createElement('textarea');
  answerInput.className = 'answer-draft';
  answerInput.rows = 2;
  answerInput.value = answer.answer || '';
  answerInput.setAttribute('aria-label', `Drafted answer for: ${card.question}`);
  body.append(answerInput);

  const meta = document.createElement('div');
  meta.className = 'extract-meta';

  const answererLabel = document.createElement('label');
  answererLabel.className = 'extract-answerer-label';
  answererLabel.append('Answered by ');
  const answererInput = document.createElement('input');
  answererInput.type = 'text';
  answererInput.className = 'extract-answerer';
  answererInput.autocomplete = 'off';
  answererInput.setAttribute('list', 'extract-participant-options');
  answererInput.value = answer.answerer || '';
  answererInput.placeholder = 'Who answered?';
  answererLabel.append(answererInput);
  meta.append(answererLabel);

  if (answer.confidence === 'low') {
    const flag = document.createElement('span');
    flag.className = 'extract-flag';
    flag.textContent = 'check this one';
    flag.title =
      'The transcript did not plainly contain this answer — read it before using it.';
    meta.append(flag);
  }
  if (typeof card.atMs === 'number') {
    const stamp = document.createElement('span');
    stamp.className = 'extract-directed';
    stamp.textContent = `asked at ${fmtStamp(card.atMs)}`;
    meta.append(stamp);
  }
  body.append(meta);

  row.append(body);
  rows.push({ cardId: card.id, check, answerInput, answererInput });
  return row;
}

function fmtStamp(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function updateCount() {
  const selected = rows.filter((r) => r.check.checked).length;
  countEl.textContent = `${selected} of ${rows.length} selected`;
  addBtn.disabled = selected === 0;
}

function applySelected() {
  const kept = rows.filter((r) => r.check.checked);
  if (kept.length === 0) return;

  const named = [];
  for (const row of kept) {
    const answer = row.answerInput.value.trim();
    if (!answer) continue; // emptied in review = "no thanks"
    const participant = row.answererInput.value.trim();
    const patch = { answer };
    // Never blank an answerer the operator already typed themselves.
    const card = (ctx.state.cards || []).find((c) => c.id === row.cardId);
    if (participant && !(card && card.participant)) patch.participant = participant;
    updateCard(row.cardId, patch);
    if (patch.participant) named.push(patch.participant);
  }

  close();
  onCardsChanged();
  if (named.length) offerAttendees(named);
  setStatus(
    `Filled ${kept.length} answer${kept.length === 1 ? '' : 's'} — edit any of them on the card.`
  );
}

function close() {
  closeModal(backdrop);
  rows = [];
  listHost.replaceChildren();
}
