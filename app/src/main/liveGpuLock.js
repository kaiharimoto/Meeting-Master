'use strict';

// One ask at a time across the two live loops.
//
// liveFlagger.js (questions) and liveMap.js (the meeting map) tick on separate
// cadences against the same home server, which has one GPU. The server already
// refuses a live ask while a PIPELINE job holds that GPU (409 from
// _require_gpu_free) — this is the same rule applied to the two live loops
// themselves, which the server cannot enforce because from its side they are
// just two clients.
//
// A TRY-lock, not a queue, and that is the whole design:
//
//   * Queueing would make one loop wait out the other's timeout — up to 110
//     seconds — and then ask with a window that had gone stale while it sat
//     there. The tick it was queued for has come and gone by then.
//   * Skipping costs nothing. Each loop keeps its own high-water mark, so the
//     speech it did not ask about is still unread and goes into the next ask
//     whole. A skipped tick is a delay, never a gap.
//
// Deliberately not a promise chain, a semaphore or an event emitter: the whole
// contract is "is the other loop mid-ask", and anything that can await is
// something that can hold a lock past the session that took it.

let holder = null;

/**
 * Take the lock for `name`, or report that someone else has it.
 * @returns {boolean} true if the caller now holds it and must release().
 */
function tryAcquire(name) {
  if (holder) return false;
  holder = name || 'unknown';
  return true;
}

/** Release the lock. Safe to call when not held, and when held by someone else
 *  (stop() does exactly that, to clear a lock an abandoned ask still owns). */
function release() {
  holder = null;
}

/** Who holds it, or null. For status lines — never for control flow. */
function heldBy() {
  return holder;
}

module.exports = { tryAcquire, release, heldBy };
