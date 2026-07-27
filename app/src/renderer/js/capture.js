// Keyboard-first Q&A capture: a global "Q" opens the modal, Tab flows
// question -> answer -> participant, Enter commits, Escape cancels.
//
// The modal is the deliberate, all-fields path. The inline bar at the top of
// the panel (quickCapture.js) is the fast path; both commit through addCard()
// so there is exactly one place a card comes into existence.

import { isTypingTarget, anyModalOpen, matchChord } from './keys.js';
import { openModal, closeModal, isModalOpen } from './modalKit.js';

let ctx = null;
let onCardsChanged = null;
let editingCard = null; // null => creating a new card; otherwise edited in place

let backdrop, modalTitle, questionEl, answerEl, participantEl, datalist;
let saveBtn, saveAddBtn, cancelBtn;

function makeId() {
  // crypto.randomUUID exists in every Chromium the app runs in; the fallback
  // covers non-secure test contexts just in case.
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return window.crypto.randomUUID();
  }
  return `card-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * The single commit path for a new card. Returns the created card so callers
 * can reference it (the quick bar announces it; the modal keeps its id).
 * Persists and notifies — callers only decide what to do with focus.
 */
export function addCard({ question, answer = '', participant = '' }) {
  const card = {
    id: makeId(),
    question: String(question || '').trim(),
    answer: String(answer || '').trim(),
    participant: String(participant || '').trim(),
  };
  if (!card.question) return null;
  ctx.state.cards.push(card);
  ctx.persist();
  onCardsChanged();
  return card;
}

export function initCapture(context, opts) {
  ctx = context;
  onCardsChanged = opts.onCardsChanged;

  backdrop = document.getElementById('card-modal');
  modalTitle = document.getElementById('card-modal-title');
  questionEl = document.getElementById('card-question');
  answerEl = document.getElementById('card-answer');
  participantEl = document.getElementById('card-participant');
  datalist = document.getElementById('participant-options');
  saveBtn = document.getElementById('card-save-btn');
  saveAddBtn = document.getElementById('card-save-add-btn');
  cancelBtn = document.getElementById('card-cancel-btn');

  document.addEventListener('keydown', onGlobalKeydown);
  backdrop.addEventListener('keydown', onModalKeydown);
  saveBtn.addEventListener('click', () => commit({ keepOpen: false }));
  if (saveAddBtn) saveAddBtn.addEventListener('click', () => commit({ keepOpen: true }));
  cancelBtn.addEventListener('click', close);

  // Clicking the dimmed area (not the dialog itself) cancels, like Escape.
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) close();
  });

  questionEl.addEventListener('input', () => questionEl.classList.remove('field-invalid'));
}

function onGlobalKeydown(e) {
  if (e.key !== 'q' && e.key !== 'Q') return;
  if (e.ctrlKey || e.metaKey || e.altKey) return; // leave shortcuts alone
  if (isTypingTarget(e.target)) return; // typing "q" into a field is just text
  if (isModalOpen(backdrop)) return; // already open
  // Don't hijack "q" while another modal (e.g. Settings) is open.
  if (anyModalOpen(backdrop)) return;
  e.preventDefault();
  openCardModal(null);
}

/**
 * Open the modal — pass a card from state.cards to edit it in place, or
 * `{ prefill }` to seed a new card's fields (the quick bar's "more fields…").
 */
export function openCardModal(card, { prefill } = {}) {
  editingCard = card || null;
  const seed = card || prefill || {};
  modalTitle.textContent = card ? 'Edit question' : 'New question';
  questionEl.value = seed.question || '';
  answerEl.value = seed.answer || '';
  participantEl.value = seed.participant || '';
  questionEl.classList.remove('field-invalid');
  refreshParticipantDatalist();
  // "Save and add another" only makes sense while creating.
  if (saveAddBtn) saveAddBtn.hidden = Boolean(card);
  openModal(backdrop, questionEl);
}

// The "Answered by" field suggests the attendees entered in section 1.
function refreshParticipantDatalist() {
  const attendees = (ctx.state.details && ctx.state.details.attendees) || [];
  datalist.replaceChildren(
    ...attendees.map((name) => {
      const option = document.createElement('option');
      option.value = name;
      return option;
    })
  );
}

function onModalKeydown(e) {
  if (e.key === 'Escape') {
    e.preventDefault();
    close();
    return;
  }
  // Ctrl+Enter saves and keeps the dialog open for the next question — the
  // rhythm for a run of related Q&A. (Tab is trapped by modalKit.)
  if (matchChord(e, 'ctrl+enter')) {
    e.preventDefault();
    commit({ keepOpen: !editingCard });
    return;
  }
  if (e.key === 'Enter') {
    // A focused button activates natively (Save, Save and add another,
    // Cancel) — don't second-guess which one.
    if (e.target && e.target.tagName === 'BUTTON') return;
    // Shift+Enter inserts a newline, but only in the answer textarea.
    if (e.target === answerEl && e.shiftKey) return;
    e.preventDefault();
    commit({ keepOpen: false });
  }
}

function commit({ keepOpen }) {
  const question = questionEl.value.trim();
  const answer = answerEl.value.trim();
  const participant = participantEl.value.trim();

  if (!question) {
    // A card without a question is meaningless; keep the modal open.
    questionEl.classList.add('field-invalid');
    questionEl.focus();
    return;
  }

  if (editingCard) {
    // Edit mode: mutate in place so the card keeps its id and position.
    editingCard.question = question;
    editingCard.answer = answer;
    editingCard.participant = participant;
    ctx.persist();
    onCardsChanged();
  } else {
    addCard({ question, answer, participant });
  }

  if (keepOpen && !editingCard) {
    // Clear for the next one but keep the answerer — a run of questions is
    // usually answered by the same person.
    questionEl.value = '';
    answerEl.value = '';
    questionEl.classList.remove('field-invalid');
    questionEl.focus();
    return;
  }
  close();
}

function close() {
  editingCard = null;
  questionEl.classList.remove('field-invalid');
  // modalKit returns focus to whatever opened the dialog; when that was a bare
  // "Q" press there is nothing to return to, so the next "Q" opens a fresh
  // card without the operator having to click anywhere first.
  closeModal(backdrop);
}
