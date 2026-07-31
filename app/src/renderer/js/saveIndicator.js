// "Saved" indicator in the Meeting screen head.
//
// Every edit already writes to localStorage synchronously (ctx.persist() has
// ~30 call sites, one per keystroke in places) — the work was never at risk.
// What was missing is any sign of it: the operator typing into a laptop app
// mid-meeting has no way to know their questions survive a crash. This says so.
//
// It reports what actually happened, so there is no "Saving…" state to fake:
// by the time the event fires, the write has returned.

let el = null;
let settleTimer = null;

export function initSaveIndicator() {
  el = document.getElementById('save-indicator');
  if (!el) return;
  document.addEventListener('mm:saved', onSaved);
}

function onSaved() {
  if (!el) return;
  el.hidden = false;
  el.textContent = 'Saved';
  el.classList.add('is-fresh');
  clearTimeout(settleTimer);
  // Settle to a timestamp so a glance later still answers "when?".
  settleTimer = setTimeout(() => {
    el.classList.remove('is-fresh');
    el.textContent = `Saved ${clock()}`;
  }, 1600);
}

function clock() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
