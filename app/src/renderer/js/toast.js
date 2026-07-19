// Non-blocking toast notifications (bottom-right, max 3 stacked). Toasts are
// a *supplement* to the status line — milestones and failures get a toast so
// they're noticeable from any screen, while #status-line remains the always-on
// a11y/status surface the tests and screen readers rely on.

const MAX_TOASTS = 3;
const DEFAULT_TIMEOUT_MS = 5200;

const ICONS = {
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
  success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
  error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
};

/**
 * Show a toast. kind: 'info' | 'success' | 'error'.
 * Returns a dismiss function.
 */
export function showToast({ kind = 'info', title = '', message = '', timeoutMs } = {}) {
  const region = document.getElementById('toast-region');
  if (!region || !title) return () => {};

  // Cap the stack — drop the oldest.
  while (region.children.length >= MAX_TOASTS) {
    region.firstElementChild.remove();
  }

  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.dataset.kind = kind;

  const icon = document.createElement('span');
  icon.className = 'toast-icon';
  // Static, trusted SVG strings only — never interpolate user content here.
  icon.innerHTML = ICONS[kind] || ICONS.info;
  toast.append(icon);

  const body = document.createElement('div');
  body.className = 'toast-body';
  const titleEl = document.createElement('div');
  titleEl.className = 'toast-title';
  titleEl.textContent = title;
  body.append(titleEl);
  if (message) {
    const msgEl = document.createElement('div');
    msgEl.className = 'toast-msg';
    msgEl.textContent = message;
    body.append(msgEl);
  }
  toast.append(body);

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'toast-close';
  close.textContent = '×';
  close.setAttribute('aria-label', 'Dismiss notification');
  toast.append(close);

  let timer = null;
  const dismiss = () => {
    if (timer) clearTimeout(timer);
    if (!toast.isConnected) return;
    toast.classList.add('leaving');
    // Remove after the exit animation; fall back in case animations are off.
    toast.addEventListener('animationend', () => toast.remove(), { once: true });
    setTimeout(() => toast.remove(), 400);
  };
  close.addEventListener('click', dismiss);

  region.append(toast);
  // Errors stay until dismissed; everything else auto-fades.
  const ttl = timeoutMs !== undefined ? timeoutMs : kind === 'error' ? 0 : DEFAULT_TIMEOUT_MS;
  if (ttl > 0) timer = setTimeout(dismiss, ttl);
  return dismiss;
}
