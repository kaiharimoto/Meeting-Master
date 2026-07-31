// Persistent problem cards with the remedy attached.
//
// Toasts fade and the status line moves on — but a failed pipeline stage is
// not transient, and its fix shouldn't require remembering which of eleven
// buttons applies. Each problem renders as a card in the Generate & send
// panel with its remedies as inline buttons, and stays until the problem is
// resolved (clearProblem) or the meeting changes.

let host = null;

export function initProblems() {
  host = document.getElementById('problem-host');
}

/**
 * Show (or replace) a problem card. `id` keys the card so a repeat of the
 * same failure updates in place. actions: [{label, primary, onClick}].
 */
export function showProblem({ id, title, detail, actions = [] }) {
  if (!host) return;
  clearProblem(id);
  const card = document.createElement('div');
  card.className = 'problem-card';
  card.dataset.problemId = id;

  const titleEl = document.createElement('div');
  titleEl.className = 'problem-title';
  titleEl.textContent = title;
  card.append(titleEl);

  if (detail) {
    const detailEl = document.createElement('div');
    detailEl.className = 'problem-detail';
    detailEl.textContent = detail;
    card.append(detailEl);
  }

  if (actions.length > 0) {
    const row = document.createElement('div');
    row.className = 'button-row';
    for (const action of actions) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `btn ${action.primary ? 'btn-primary' : 'btn-secondary'} btn-small`;
      btn.textContent = action.label;
      btn.addEventListener('click', action.onClick);
      row.append(btn);
    }
    card.append(row);
  }

  host.append(card);
  host.hidden = false;
}

export function clearProblem(id) {
  if (!host) return;
  for (const card of host.querySelectorAll('.problem-card')) {
    if (card.dataset.problemId === id) card.remove();
  }
  host.hidden = host.children.length === 0;
}

export function clearAllProblems() {
  if (!host) return;
  host.replaceChildren();
  host.hidden = true;
}
