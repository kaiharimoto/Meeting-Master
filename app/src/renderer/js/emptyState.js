// One empty state for the whole app.
//
// There used to be five treatments: a dashed box with a CSS-mask icon (the
// only mask in the codebase), two plain dashed boxes, an inline pulsing-dot
// line, and a raw unstyled log line. They appear at the exact moments a user
// has nothing to look at, so they're worth getting right — icon, what's
// missing, and what to do about it.

const ICONS = {
  question:
    '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  activity: '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
  server:
    '<rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/>',
  terminal: '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>',
};

/**
 * Build an empty-state block. `hint` is optional; `action` renders a button.
 * Text is set with textContent — only the icon markup is trusted.
 */
export function buildEmptyState({ icon = 'question', title, hint, action } = {}) {
  const host = document.createElement('div');
  host.className = 'empty-state';

  const glyph = document.createElement('span');
  glyph.className = 'empty-state-icon';
  glyph.setAttribute('aria-hidden', 'true');
  glyph.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    `stroke-linecap="round" stroke-linejoin="round">${ICONS[icon] || ICONS.question}</svg>`;
  host.append(glyph);

  const titleEl = document.createElement('div');
  titleEl.className = 'empty-state-title';
  titleEl.textContent = title || '';
  host.append(titleEl);

  if (hint) {
    const hintEl = document.createElement('div');
    hintEl.className = 'empty-state-hint';
    hintEl.textContent = hint;
    host.append(hintEl);
  }

  if (action && action.label && typeof action.onClick === 'function') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-secondary btn-small';
    btn.textContent = action.label;
    btn.addEventListener('click', action.onClick);
    host.append(btn);
  }

  return host;
}
