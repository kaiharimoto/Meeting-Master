// Renders state.cards into #card-list. Click a card to edit it; the small ×
// deletes it (no confirm — a deleted card is quick to re-add and order of the
// remaining cards is preserved).

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
    const empty = document.createElement('div');
    empty.className = 'card-list-empty';
    empty.textContent = 'No questions yet — press Q during the meeting to capture one.';
    container.append(empty);
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
    ctx.state.cards = ctx.state.cards.filter((c) => c.id !== card.id);
    ctx.persist();
    renderCards();
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
