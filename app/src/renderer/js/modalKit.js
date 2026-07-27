// Shared modal open/close behaviour.
//
// The app has eight dialogs. Before this module two of them trapped focus (in
// two divergent implementations, one of which missed <textarea> and <select>),
// and NONE restored focus on close — closing a dialog dropped the operator at
// the top of the document. This module owns three things and nothing else:
//
//   * the Tab trap, so focus cannot escape to the page behind the backdrop
//   * remembering the element that was focused when the dialog opened, and
//     putting focus back there when it closes
//   * the hidden attribute, so "open" has one definition
//
// Escape handling and per-dialog state stay in the owning module — each one
// has its own idea of what cancelling means.

// backdrop -> the element focus should return to when it closes.
const returnFocus = new WeakMap();
// Backdrops whose Tab trap is already installed.
const trapped = new WeakSet();

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

/** Visible, enabled focusable controls inside the dialog, in DOM order. */
export function focusables(backdrop) {
  return Array.from(backdrop.querySelectorAll(FOCUSABLE)).filter(
    (el) => !el.disabled && !el.hidden && el.offsetParent !== null
  );
}

function onTrapKeydown(e) {
  if (e.key !== 'Tab') return;
  const backdrop = e.currentTarget;
  const items = focusables(backdrop);
  if (items.length === 0) return;
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  const outside = !backdrop.contains(active);
  if (e.shiftKey && (active === first || outside)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (active === last || outside)) {
    e.preventDefault();
    first.focus();
  }
}

/**
 * Open a dialog: remember where focus came from, unhide, trap Tab, and focus
 * `first` (or the first focusable control).
 */
export function openModal(backdrop, first) {
  if (!backdrop) return;
  const active = document.activeElement;
  // Ignore <body>/null so a dialog opened from a bare keypress restores to
  // nothing rather than pinning focus somewhere arbitrary.
  returnFocus.set(backdrop, active && active !== document.body ? active : null);

  if (!trapped.has(backdrop)) {
    backdrop.addEventListener('keydown', onTrapKeydown);
    trapped.add(backdrop);
  }

  backdrop.hidden = false;
  const target = first || focusables(backdrop)[0];
  if (target && typeof target.focus === 'function') target.focus();
}

/** Close a dialog and put focus back where it was before it opened. */
export function closeModal(backdrop) {
  if (!backdrop || backdrop.hidden) {
    if (backdrop) backdrop.hidden = true;
    return;
  }
  backdrop.hidden = true;

  const prev = returnFocus.get(backdrop);
  returnFocus.delete(backdrop);
  // The opener may be gone (a card deleted, a list re-rendered) — fall back to
  // clearing focus so the next bare-letter shortcut still reaches the document.
  if (prev && prev.isConnected && typeof prev.focus === 'function' && prev.offsetParent !== null) {
    prev.focus();
    return;
  }
  const active = document.activeElement;
  if (active && typeof active.blur === 'function') active.blur();
}

/** True while the dialog is showing. */
export function isModalOpen(backdrop) {
  return Boolean(backdrop) && !backdrop.hidden;
}
