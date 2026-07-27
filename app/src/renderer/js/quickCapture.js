// Inline quick-capture bar at the top of the Q&A panel.
//
// The modal is the deliberate path — question, answer, answerer, all three
// fields. Mid-meeting the common case is much smaller than that: you hear a
// question and want it written down before the next sentence. This bar is that
// case: type, Enter, keep typing. Focus never leaves the input, so a run of
// questions is one continuous action.
//
// "More fields…" hands the half-typed question to the modal, so choosing the
// fast path first never costs anything.

import { addCard, openCardModal } from './capture.js';

let input = null;
let host = null;

export function initQuickCapture() {
  host = document.getElementById('quick-capture');
  input = document.getElementById('quick-question');
  const addBtn = document.getElementById('quick-add-btn');
  const moreBtn = document.getElementById('quick-more-btn');
  if (!host || !input) return;

  input.addEventListener('input', () => input.classList.remove('field-invalid'));
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    submit();
  });
  if (addBtn) addBtn.addEventListener('click', submit);
  if (moreBtn) {
    moreBtn.addEventListener('click', () => {
      const question = input.value.trim();
      input.value = '';
      openCardModal(null, { prefill: { question } });
    });
  }
}

/** Put the cursor in the bar (the palette's "Add a question" command). */
export function focusQuickCapture() {
  if (input) input.focus();
}

function submit() {
  const question = input.value.trim();
  if (!question) {
    input.classList.add('field-invalid');
    input.focus();
    return;
  }
  addCard({ question });
  input.value = '';
  input.classList.remove('field-invalid');
  // The whole point: the next question can start immediately.
  input.focus();
}
