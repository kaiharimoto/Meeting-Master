// Shared keyboard predicates.
//
// Every global shortcut in the app needs the same two guards: "is the operator
// typing right now?" and "is a dialog already open?". Before this module each
// caller reimplemented them, and they had drifted — app.js's copy omitted
// SELECT, and generate.js's dev shortcut had neither guard. One definition
// here, imported everywhere.

/** True when the event target is a text field (so a bare letter is just text). */
export function isTypingTarget(target) {
  if (!target || !target.tagName) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

/**
 * The topmost open modal backdrop, or null.
 * Pass a backdrop to ignore (usually "the one I'm about to open") — that's the
 * "is some OTHER dialog in the way?" question the shortcuts actually ask.
 */
export function openModalEl(except) {
  for (const el of document.querySelectorAll('.modal-backdrop:not([hidden])')) {
    if (el !== except) return el;
  }
  return null;
}

/** Convenience boolean over openModalEl(). */
export function anyModalOpen(except) {
  return openModalEl(except) !== null;
}

/**
 * Match a keyboard chord like 'ctrl+k', 'ctrl+shift+m', 'ctrl+enter' or '?'.
 * Letter keys are compared case-insensitively so Shift-modified chords match
 * regardless of the character the layout produced. Modifiers must match
 * exactly, so 'ctrl+k' never fires for Ctrl+Shift+K.
 */
export function matchChord(e, chord) {
  const parts = chord.toLowerCase().split('+');
  const key = parts.pop();
  const want = {
    ctrl: parts.includes('ctrl') || parts.includes('mod'),
    shift: parts.includes('shift'),
    alt: parts.includes('alt'),
  };
  // Ctrl and Cmd are interchangeable — the app ships on Windows but the
  // renderer also runs under Playwright on Linux and macOS.
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl !== want.ctrl) return false;
  if (e.shiftKey !== want.shift) return false;
  if (e.altKey !== want.alt) return false;
  return String(e.key).toLowerCase() === key;
}
