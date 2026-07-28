// The Q&A list: rendering, keyboard navigation, and every mutation that can
// happen to a card once it exists (edit, delete, reorder).
//
// The render is KEYED on card.id — an existing card's element is updated in
// place, never rebuilt. Everything else here depends on that: an inline editor
// survives a re-render, focus isn't dropped mid-interaction, and FLIP has
// stable elements to animate between positions.
//
// Focus follows the composite-widget pattern: the LIST is one tab stop, and
// arrows move between cards inside it (roving tabindex). Before this every
// card set tabindex="0", so tabbing through a 20-question meeting meant 20
// stops before reaching the next control.

import { showToast } from './toast.js';
import { buildEmptyState } from './emptyState.js';
import { flip, animateOut } from './flip.js';
import { initCardEdit, startInlineEdit, isEditing } from './cardEdit.js';
import { initCardDrag, bindDragHandle } from './cardDrag.js';
import { offerAttendees } from './attendees.js';

let ctx = null;
let onEditCard = null;
let container = null;
let toolbar = null;
let countEl = null;
// The card that owns the list's tab stop. Null until the list is first used.
let activeId = null;

export function initCardList(context, opts) {
  ctx = context;
  onEditCard = opts.onEditCard;
  container = document.getElementById('card-list');
  toolbar = document.getElementById('list-toolbar');
  countEl = document.getElementById('card-count');

  initCardEdit({
    onCommit: (id, patch) => updateCard(id, patch),
    onCardsChanged: () => renderCards(),
  });
  initCardDrag({
    container,
    onReorder: (id, toIndex) => moveCard(id, toIndex, { undoable: true }),
  });

  container.addEventListener('keydown', onListKeydown);
  container.addEventListener('focusin', (e) => {
    const card = e.target.closest && e.target.closest('.qa-card');
    if (card && card.dataset.cardId !== activeId) {
      activeId = card.dataset.cardId;
      applyRovingTabindex();
    }
  });
}

// ---- Mutations -------------------------------------------------------------

// Handlers resolve their card by id at event time. Card OBJECTS are replaced
// wholesale by History restore and Undo (same ids, fresh objects from JSON), so
// a closed-over reference can go stale while the id never does.
function liveCard(id) {
  return (ctx.state.cards || []).find((c) => c.id === id) || null;
}

/** Apply a partial change to one card. The single write path for edits. */
export function updateCard(id, patch) {
  const card = liveCard(id);
  if (!card) return;
  let changed = false;
  for (const [key, value] of Object.entries(patch)) {
    if (card[key] === value) continue;
    card[key] = value;
    changed = true;
  }
  if (!changed) {
    renderCards(); // the editor still has to be reconciled away
    return;
  }
  ctx.persist();
  renderCards();
  if (patch.participant) offerAttendees([patch.participant]);
}

/** Move a card to `toIndex`, with an Undo toast that restores the old order. */
export function moveCard(id, toIndex, { undoable = false } = {}) {
  const cards = ctx.state.cards || [];
  const from = cards.findIndex((c) => c.id === id);
  if (from === -1) return;
  const to = Math.max(0, Math.min(toIndex, cards.length - 1));
  if (from === to) return;

  const previousOrder = cards.map((c) => c.id);
  const [card] = cards.splice(from, 1);
  cards.splice(to, 0, card);
  ctx.persist();
  flip(container, () => renderCards());
  focusCard(id);

  if (!undoable) return;
  showToast({
    kind: 'info',
    title: 'Question moved',
    message: `Now #${to + 1} of ${cards.length}.`,
    action: { label: 'Undo', onClick: () => restoreOrder(previousOrder) },
  });
}

function restoreOrder(order) {
  const cards = ctx.state.cards || [];
  const byId = new Map(cards.map((c) => [c.id, c]));
  const restored = order.map((id) => byId.get(id)).filter(Boolean);
  // Anything added since the snapshot keeps its place at the end rather than
  // being silently dropped.
  for (const card of cards) if (!order.includes(card.id)) restored.push(card);
  cards.length = 0;
  cards.push(...restored);
  ctx.persist();
  flip(container, () => renderCards());
}

function deleteCard(id) {
  const cards = ctx.state.cards || [];
  const index = cards.findIndex((c) => c.id === id);
  if (index === -1) return;
  const el = container.querySelector(`[data-card-id="${CSS.escape(id)}"]`);
  if (el && el.dataset.removing) return; // already on its way out
  if (el) el.dataset.removing = '1';

  // Remember the NEIGHBOUR, not just the index: between the delete and the
  // undo the operator can reorder the list, and an index would then restore
  // the card to a slot that means something else entirely.
  const afterId = index > 0 ? cards[index - 1].id : null;

  const remove = () => {
    const [card] = cards.splice(index, 1);
    ctx.persist();
    flip(container, () => renderCards());
    showToast({
      kind: 'info',
      title: 'Question deleted',
      message: card.question,
      action: { label: 'Undo', onClick: () => restoreCard(card, afterId, index) },
    });
  };

  if (el) animateOut(el, remove);
  else remove();
}

function restoreCard(card, afterId, fallbackIndex) {
  const cards = ctx.state.cards || [];
  const after = afterId === null ? -1 : cards.findIndex((c) => c.id === afterId);
  const at =
    afterId === null ? 0 : after !== -1 ? after + 1 : Math.min(fallbackIndex, cards.length);
  cards.splice(at, 0, card);
  ctx.persist();
  flip(container, () => renderCards());
  focusCard(card.id);
}

// ---- Rendering -------------------------------------------------------------

// The list's own toolbar (count + density) only makes sense once there's a
// list — an empty state with a "Compact" button above it is noise.
function renderToolbar(count) {
  if (toolbar) toolbar.hidden = count === 0;
  if (countEl) countEl.textContent = `${count} question${count === 1 ? '' : 's'}`;
}

export function renderCards() {
  const cards = ctx.state.cards || [];
  renderToolbar(cards.length);

  if (cards.length === 0) {
    activeId = null;
    container.removeAttribute('role');
    container.replaceChildren(
      buildEmptyState({
        icon: 'question',
        title: 'No questions yet — press Q during the meeting to capture one.',
        hint: 'Each one becomes a card you can edit, and lands in the PDF.',
      })
    );
    return;
  }

  container.setAttribute('role', 'list');

  // Keep the elements of cards that still exist; drop everything else
  // (removed cards, and the empty state if it was showing).
  const live = new Set(cards.map((c) => c.id));
  const existing = new Map();
  for (const el of Array.from(container.children)) {
    const id = el.dataset ? el.dataset.cardId : null;
    if (id && live.has(id) && !existing.has(id)) existing.set(id, el);
    else el.remove();
  }

  cards.forEach((card, i) => {
    const found = existing.get(card.id);
    const el = found ? updateCardEl(found, card) : buildCardEl(card);
    // Only touch the DOM when this card isn't already in the right slot.
    if (container.children[i] !== el) {
      container.insertBefore(el, container.children[i] || null);
    }
  });

  applyRovingTabindex();
}

// Exactly one card carries the tab stop; arrows move it. If the active card is
// gone (deleted, or a whole new meeting), the first card inherits it.
function applyRovingTabindex() {
  const cards = Array.from(container.children).filter((el) => el.dataset.cardId);
  if (cards.length === 0) return;
  if (!cards.some((el) => el.dataset.cardId === activeId)) {
    activeId = cards[0].dataset.cardId;
  }
  for (const el of cards) {
    const active = el.dataset.cardId === activeId;
    el.tabIndex = active ? 0 : -1;
    el.classList.toggle('is-active', active);
  }
}

function iconButton(className, label, svg) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = className;
  // Not a tab stop: the list is ONE stop and these are reachable from the card
  // by key (e / Delete / Alt+arrows). Tab-reachable buttons that are invisible
  // until hover would be worse than either.
  btn.tabIndex = -1;
  btn.title = label;
  btn.setAttribute('aria-label', label);
  if (svg) btn.innerHTML = svg; // literal markup from this file — never card content
  return btn;
}

const ICON_GRIP =
  '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
  '<circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/>' +
  '<circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/>' +
  '<circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>';
const ICON_PENCIL =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>';

function buildCardEl(card) {
  const el = document.createElement('article');
  el.className = 'qa-card';
  el.dataset.cardId = card.id;
  el.setAttribute('role', 'listitem');
  el.tabIndex = -1;

  const body = document.createElement('div');
  body.className = 'card-body';
  const question = document.createElement('div');
  question.className = 'card-question';
  body.append(question);
  el.append(body);

  const actions = document.createElement('div');
  actions.className = 'card-actions';

  const grip = iconButton('card-grip', 'Drag to reorder this question', ICON_GRIP);
  bindDragHandle(grip, el);

  const edit = iconButton('card-edit', 'Edit this question in a dialog', ICON_PENCIL);
  edit.addEventListener('click', (e) => {
    e.stopPropagation();
    const live = liveCard(el.dataset.cardId);
    if (live) onEditCard(live);
  });

  const del = iconButton('card-delete', 'Delete this question', null);
  del.textContent = '×';
  del.addEventListener('click', (e) => {
    e.stopPropagation();
    deleteCard(el.dataset.cardId);
  });

  actions.append(grip, edit, del);
  el.append(actions);

  // Clicking the text edits THAT text in place. Clicking elsewhere on the card
  // just focuses it — the whole-card click used to open the modal, which is
  // now the pencil, so that a click on a word can mean "edit this word".
  body.addEventListener('click', (e) => {
    const slot = e.target.closest('.card-question, .card-answer');
    const live = liveCard(el.dataset.cardId);
    if (!slot || !live || slot.hidden) return;
    startInlineEdit(live, slot, slot.classList.contains('card-question') ? 'question' : 'answer');
  });

  return updateCardEl(el, card);
}

// Writes card content into an existing element, creating or removing the
// optional answer/participant slots. Returns the element.
function updateCardEl(el, card) {
  const body = el.querySelector('.card-body');
  const question = body.querySelector('.card-question');
  if (question.textContent !== card.question) question.textContent = card.question;

  const label = `Delete this question: ${card.question}`;
  const del = el.querySelector('.card-delete');
  if (del.getAttribute('aria-label') !== label) del.setAttribute('aria-label', label);

  // The answer slot ALWAYS exists, even when empty. Removing it when there was
  // no answer meant the one thing an operator does most — write down the
  // question now, add the answer when it arrives — was the one thing inline
  // editing couldn't do, because there was nothing on the card to click.
  const answerAdded = syncAnswer(body, card.answer);
  const participantAdded = syncSlot(body, 'card-participant', 'span', card.participant);
  syncStamp(body, card);

  // Appending only when a slot was just created keeps the common path from
  // detaching and reattaching nodes (which would drop focus, or an open
  // inline editor, out of the card).
  if (answerAdded || participantAdded) {
    const parts = [question];
    for (const cls of ['card-answer', 'card-participant', 'card-stamp']) {
      const node = body.querySelector('.' + cls);
      if (node) parts.push(node);
    }
    body.append(...parts);
  }
  return el;
}

// The answer, or an invitation to write one. `.is-blank` is what the operator
// scans for: which questions still need an answer.
const ANSWER_PLACEHOLDER = 'Add an answer';

function syncAnswer(host, text) {
  let node = host.querySelector('.card-answer');
  const created = !node;
  if (!node) {
    node = document.createElement('div');
    node.className = 'card-answer';
    host.append(node);
  }
  const blank = !text;
  const wanted = blank ? ANSWER_PLACEHOLDER : text;
  if (node.textContent !== wanted) node.textContent = wanted;
  node.classList.toggle('is-blank', blank);
  return created;
}

// When the question was captured, as minutes into the recording. Only shown
// for cards that carry the stamp — cards typed outside a recording, and every
// card from before this existed, simply don't have one.
function syncStamp(host, card) {
  const at = typeof card.atMs === 'number' ? card.atMs : null;
  let node = host.querySelector('.card-stamp');
  if (at === null) {
    if (node) node.remove();
    return;
  }
  if (!node) {
    node = document.createElement('span');
    node.className = 'card-stamp';
    host.append(node);
  }
  const text = fmtStamp(at);
  if (node.textContent !== text) {
    node.textContent = text;
    node.title = `Captured ${text} into the recording`;
  }
}

function fmtStamp(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// Creates, updates or removes one optional slot. True when it was created.
function syncSlot(host, className, tag, text) {
  let node = host.querySelector('.' + className);
  if (!text) {
    if (node) node.remove();
    return false;
  }
  if (node) {
    if (node.textContent !== text) node.textContent = text;
    return false;
  }
  node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  host.append(node);
  return true;
}

// ---- Keyboard --------------------------------------------------------------

function cardElements() {
  return Array.from(container.children).filter((el) => el.dataset.cardId);
}

function focusCard(id) {
  const el = container.querySelector(`[data-card-id="${CSS.escape(id)}"]`);
  if (!el) return;
  activeId = id;
  applyRovingTabindex();
  el.focus();
}

function onListKeydown(e) {
  const card = e.target.closest && e.target.closest('.qa-card');
  // Keys typed INSIDE an open editor belong to the editor.
  if (!card || isEditing()) return;
  if (e.target !== card) return; // a button inside the card handles its own keys

  const cards = cardElements();
  const index = cards.indexOf(card);
  const id = card.dataset.cardId;

  // Alt+arrows reorder — the keyboard equivalent of the grip, shipped with it
  // rather than after it.
  if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    e.preventDefault();
    moveCard(id, index + (e.key === 'ArrowDown' ? 1 : -1), { undoable: true });
    return;
  }
  if (e.altKey) return;

  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault();
      if (index < cards.length - 1) focusCard(cards[index + 1].dataset.cardId);
      break;
    case 'ArrowUp':
      e.preventDefault();
      if (index > 0) focusCard(cards[index - 1].dataset.cardId);
      break;
    case 'Home':
      e.preventDefault();
      focusCard(cards[0].dataset.cardId);
      break;
    case 'End':
      e.preventDefault();
      focusCard(cards[cards.length - 1].dataset.cardId);
      break;
    case 'Delete':
      // Undoable, like every other delete here — but NOT bound to Backspace,
      // which is too easy to hit by accident on a focused card.
      e.preventDefault();
      deleteCard(id);
      break;
    case 'e': {
      // Edit the question where it sits — the fast fix.
      e.preventDefault();
      const live = liveCard(id);
      const slot = card.querySelector('.card-question');
      if (live && slot) startInlineEdit(live, slot, 'question');
      break;
    }
    case 'a': {
      // Jump straight into the ANSWER. The answer arrives a minute after the
      // question in every real meeting, so this is the key that gets used.
      e.preventDefault();
      const live = liveCard(id);
      const slot = card.querySelector('.card-answer');
      if (live && slot) startInlineEdit(live, slot, 'answer');
      break;
    }
    case 'Enter': {
      // The full record, in the dialog — unchanged from before this release.
      e.preventDefault();
      const live = liveCard(id);
      if (live) onEditCard(live);
      break;
    }
    default:
      break;
  }
}
