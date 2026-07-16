// Keyboard-first Q&A capture: a global "Q" opens the modal, Tab flows
// question -> answer -> participant, Enter commits, Escape cancels.

let ctx = null;
let onCardsChanged = null;
let editingCard = null; // null => creating a new card; otherwise edited in place

let backdrop, modalTitle, questionEl, answerEl, participantEl, datalist, saveBtn, cancelBtn;

function isTypingTarget(target) {
  if (!target || !target.tagName) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

function makeId() {
  // crypto.randomUUID exists in every Chromium the app runs in; the fallback
  // covers non-secure test contexts just in case.
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return window.crypto.randomUUID();
  }
  return `card-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
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
  cancelBtn = document.getElementById('card-cancel-btn');

  document.addEventListener('keydown', onGlobalKeydown);
  backdrop.addEventListener('keydown', onModalKeydown);
  saveBtn.addEventListener('click', commit);
  cancelBtn.addEventListener('click', closeModal);

  // Clicking the dimmed area (not the dialog itself) cancels, like Escape.
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) closeModal();
  });

  questionEl.addEventListener('input', () => questionEl.classList.remove('field-invalid'));
}

function onGlobalKeydown(e) {
  if (e.key !== 'q' && e.key !== 'Q') return;
  if (e.ctrlKey || e.metaKey || e.altKey) return; // leave shortcuts alone
  if (isTypingTarget(e.target)) return; // typing "q" into a field is just text
  if (!backdrop.hidden) return; // already open
  e.preventDefault();
  openCardModal(null);
}

/** Open the modal — pass a card from state.cards to edit it in place. */
export function openCardModal(card) {
  editingCard = card || null;
  modalTitle.textContent = card ? 'Edit question' : 'New question';
  questionEl.value = card ? card.question : '';
  answerEl.value = card ? card.answer : '';
  participantEl.value = card ? card.participant : '';
  questionEl.classList.remove('field-invalid');
  refreshParticipantDatalist();
  backdrop.hidden = false;
  questionEl.focus();
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
    closeModal();
    return;
  }
  if (e.key === 'Enter') {
    // Shift+Enter inserts a newline — but only in the answer textarea.
    if (e.target === answerEl && e.shiftKey) return;
    e.preventDefault();
    commit();
  }
}

function commit() {
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
  } else {
    ctx.state.cards.push({ id: makeId(), question, answer, participant });
  }

  ctx.persist();
  closeModal();
  onCardsChanged();
}

function closeModal() {
  backdrop.hidden = true;
  editingCard = null;
  questionEl.classList.remove('field-invalid');
  // Refocus the body so the very next "Q" press opens a fresh card without
  // the operator having to click anywhere first.
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  document.body.focus();
}
