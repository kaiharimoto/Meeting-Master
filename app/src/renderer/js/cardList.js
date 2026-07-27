// Renders state.cards into #card-list. Click a card to edit it; the small ×
// deletes it immediately with an Undo toast — faster than a confirm when you
// meant it, forgiving when you didn't.
//
// The render is KEYED on card.id: an existing card's element is updated in
// place instead of rebuilt. That matters as soon as adds get fast (the inline
// quick-capture bar) — a full replaceChildren() on every keystroke-fast add
// flashes the whole list and drops focus — and it is what later phases need to
// edit, reorder and animate cards without fighting the renderer.

import { showToast } from './toast.js';
import { buildEmptyState } from './emptyState.js';

let ctx = null;
let onEditCard = null;
let container = null;
let toolbar = null;
let countEl = null;

export function initCardList(context, opts) {
  ctx = context;
  onEditCard = opts.onEditCard;
  container = document.getElementById('card-list');
  toolbar = document.getElementById('list-toolbar');
  countEl = document.getElementById('card-count');
}

// The list's own toolbar (count + density) only makes sense once there's a
// list — an empty state with a "Compact" button above it is noise.
function renderToolbar(count) {
  if (toolbar) toolbar.hidden = count === 0;
  if (countEl) countEl.textContent = `${count} question${count === 1 ? '' : 's'}`;
}

// Handlers resolve their card by id at event time. Card OBJECTS are replaced
// wholesale by History restore and Undo (same ids, fresh objects from JSON), so
// a closed-over reference can go stale while the id never does.
function liveCard(id) {
  return (ctx.state.cards || []).find((c) => c.id === id) || null;
}

export function renderCards() {
  const cards = ctx.state.cards || [];
  renderToolbar(cards.length);

  if (cards.length === 0) {
    container.replaceChildren(
      buildEmptyState({
        icon: 'question',
        title: 'No questions yet — press Q during the meeting to capture one.',
        hint: 'Each one becomes a card you can edit, and lands in the PDF.',
      })
    );
    return;
  }

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
}

function buildCardEl(card) {
  const el = document.createElement('article');
  el.className = 'qa-card';
  el.dataset.cardId = card.id;
  el.tabIndex = 0; // reachable + editable via keyboard

  const question = document.createElement('div');
  question.className = 'card-question';
  el.append(question);

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'card-delete';
  del.textContent = '×'; // ×
  del.title = 'Delete this card';
  del.addEventListener('click', (e) => {
    e.stopPropagation(); // don't fall through to the edit handler
    deleteCard(el.dataset.cardId);
  });
  el.append(del);

  el.addEventListener('click', () => {
    const live = liveCard(el.dataset.cardId);
    if (live) onEditCard(live);
  });
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target === el) {
      e.preventDefault();
      const live = liveCard(el.dataset.cardId);
      if (live) onEditCard(live);
    }
  });

  return updateCardEl(el, card);
}

// Writes card content into an existing element, creating or removing the
// optional answer/participant slots. Returns the element.
function updateCardEl(el, card) {
  const question = el.querySelector('.card-question');
  if (question.textContent !== card.question) question.textContent = card.question;

  const del = el.querySelector('.card-delete');
  const label = `Delete card: ${card.question}`;
  if (del.getAttribute('aria-label') !== label) del.setAttribute('aria-label', label);

  const answerAdded = syncSlot(el, 'card-answer', 'div', card.answer);
  const participantAdded = syncSlot(el, 'card-participant', 'span', card.participant);

  // Appending only when a slot was just created keeps the common path from
  // detaching and reattaching nodes (which would drop focus inside the card).
  if (answerAdded || participantAdded) {
    const parts = [question];
    for (const cls of ['card-answer', 'card-participant']) {
      const node = el.querySelector('.' + cls);
      if (node) parts.push(node);
    }
    parts.push(del);
    el.append(...parts);
  }
  return el;
}

// Creates, updates or removes one optional slot. True when it was created.
function syncSlot(el, className, tag, text) {
  let node = el.querySelector('.' + className);
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
  el.append(node);
  return true;
}

function deleteCard(id) {
  const index = (ctx.state.cards || []).findIndex((c) => c.id === id);
  if (index === -1) return;
  const [card] = ctx.state.cards.splice(index, 1);
  ctx.persist();
  renderCards();
  showToast({
    kind: 'info',
    title: 'Question deleted',
    message: card.question,
    action: {
      label: 'Undo',
      onClick: () => {
        // Restore at the original position so the list order is preserved.
        ctx.state.cards.splice(Math.min(index, ctx.state.cards.length), 0, card);
        ctx.persist();
        renderCards();
      },
    },
  });
}
