// Edit a card's question or answer in place.
//
// The modal is still there for the full record — question, answer, answerer —
// but fixing a typo shouldn't cost a dialog. Clicking the text swaps in a
// textarea sitting exactly where the text was; Enter or blur commits, Escape
// puts the original back.
//
// The editor is deliberately INDEPENDENT of the element it replaces: it holds
// the card id and the field name itself, so a re-render that removes the slot
// (an emptied answer, a History restore) can't strand a half-typed edit.

let onCommit = null;
let editor = null; // the open textarea, or null
let onCardsChanged = null;

export function initCardEdit(opts) {
  onCommit = opts.onCommit;
  onCardsChanged = opts.onCardsChanged || function () {};
}

/** True while an inline editor is open — callers use this to keep off. */
export function isEditing() {
  return editor !== null;
}

/** The card currently being edited in place, or null. */
export function editingCardId() {
  return editor ? editor.dataset.cardId : null;
}

/**
 * Swap `slot` (a .card-question / .card-answer element) for a textarea.
 * `field` is the card property being edited.
 */
export function startInlineEdit(card, slot, field) {
  if (editor) commit();

  const area = document.createElement('textarea');
  area.className = `card-editor card-editor--${field}`;
  area.value = card[field] || '';
  area.dataset.cardId = card.id;
  area.dataset.field = field;
  area.setAttribute('aria-label', field === 'question' ? 'Question' : 'Answer');
  area.rows = 1;

  slot.hidden = true;
  slot.after(area);
  editor = area;

  autoGrow(area);
  area.addEventListener('input', () => autoGrow(area));
  area.addEventListener('keydown', onEditorKeydown);
  area.addEventListener('blur', () => commit());

  area.focus();
  // Cursor at the end, not a select-all: the common case is appending or
  // fixing a word, not replacing the whole thing.
  area.setSelectionRange(area.value.length, area.value.length);
}

function autoGrow(area) {
  area.style.height = 'auto';
  area.style.height = `${area.scrollHeight}px`;
}

function onEditorKeydown(e) {
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation(); // don't let the panel/dialog layer see it
    cancel();
    return;
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    // Shift+Enter is a newline in both fields — answers routinely have them,
    // and a question that needs one is nobody's business but the operator's.
    e.preventDefault();
    commit();
  }
}

/** Write the edit back through the store, then tear the editor down. */
export function commit() {
  if (!editor) return;
  const { cardId, field } = editor.dataset;
  const value = editor.value.trim();
  teardown();
  // Commit BEFORE anything re-renders: onCommit persists and re-renders, and a
  // re-render with the editor still in the DOM would fight the keyed update.
  onCommit(cardId, { [field]: value });
}

/** Abandon the edit and restore what was there. */
export function cancel() {
  if (!editor) return;
  const card = editor.closest('.qa-card');
  teardown();
  onCardsChanged();
  if (card) card.focus();
}

function teardown() {
  // Clear the module's handle BEFORE touching the DOM. Removing the focused
  // textarea fires blur synchronously, and the blur handler calls commit() —
  // so a teardown that nulled `editor` last would re-enter itself, commit a
  // cancelled edit, and then throw removing an already-removed node.
  const area = editor;
  if (!area) return;
  editor = null;

  const slot = area.previousElementSibling;
  if (slot) slot.hidden = false;
  area.remove();
}
