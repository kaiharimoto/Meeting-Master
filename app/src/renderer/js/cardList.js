// Renders state.cards into #card-list. Click a card to edit it; the small ×
// deletes it immediately with an Undo toast — faster than a confirm when you
// meant it, forgiving when you didn't.

import { showToast } from './toast.js';
import { buildEmptyState } from './emptyState.js';

let ctx = null;
let onEditCard = null;
let container = null;

export function initCardList(context, opts) {
  ctx = context;
  onEditCard = opts.onEditCard;
  container = document.getElementById('card-list');
}

export function renderCards() {
  container.replaceChildren();

  const cards = ctx.state.cards || [];
  if (cards.length === 0) {
    container.append(
      buildEmptyState({
        icon: 'question',
        title: 'No questions yet — press Q during the meeting to capture one.',
        hint: 'Each one becomes a card you can edit, and lands in the PDF.',
      })
    );
    return;
  }

  for (const card of cards) {
    container.append(buildCardEl(card));
  }
}

function buildCardEl(card) {
  const el = document.createElement('article');
  el.className = 'qa-card';
  el.tabIndex = 0; // reachable + editable via keyboard

  const question = document.createElement('div');
  question.className = 'card-question';
  question.textContent = card.question;
  el.append(question);

  if (card.answer) {
    const answer = document.createElement('div');
    answer.className = 'card-answer';
    answer.textContent = card.answer;
    el.append(answer);
  }

  if (card.participant) {
    const chip = document.createElement('span');
    chip.className = 'card-participant';
    chip.textContent = card.participant;
    el.append(chip);
  }

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'card-delete';
  del.textContent = '×'; // ×
  del.title = 'Delete this card';
  del.setAttribute('aria-label', `Delete card: ${card.question}`);
  del.addEventListener('click', (e) => {
    e.stopPropagation(); // don't fall through to the edit handler
    const index = ctx.state.cards.findIndex((c) => c.id === card.id);
    if (index === -1) return;
    ctx.state.cards.splice(index, 1);
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
  });
  el.append(del);

  el.addEventListener('click', () => onEditCard(card));
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target === el) {
      e.preventDefault();
      onEditCard(card);
    }
  });

  return el;
}
