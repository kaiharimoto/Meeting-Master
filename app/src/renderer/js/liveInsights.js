// Key insights suggested mid-meeting: where they live and where they end up.
//
// Shared by liveFlags.js (the rail that offers them) and generate.js (which
// replaces ctx.state.summary wholesale when the home server's post-meeting
// summary arrives, and must not throw away insights the operator already kept).
// A separate module rather than an export from either one — those two already
// have a dependency edge and this would close it into a cycle.
//
// State shape, all under ctx.state.liveFlags:
//   pending           [question objects]  awaiting approve/dismiss
//   dismissed         [normalized question keys]
//   pendingInsights   [insight strings]   awaiting keep/dismiss
//   dismissedInsights [normalized insight keys]
//   keptInsights      [insight strings]   kept by the operator, verbatim

/** Normalize an insight for duplicate/dismissal comparison. */
export function normI(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** ctx.state.liveFlags, with every array guaranteed to exist. */
export function liveFlagsState(state) {
  if (!state.liveFlags || typeof state.liveFlags !== 'object') state.liveFlags = {};
  const lf = state.liveFlags;
  for (const key of ['pending', 'dismissed', 'pendingInsights', 'dismissedInsights', 'keptInsights']) {
    if (!Array.isArray(lf[key])) lf[key] = [];
  }
  return lf;
}

/** The summary object, created (and de-legacied) if needed. */
function summaryObject(state) {
  const s = state.summary;
  if (s && typeof s === 'object' && !Array.isArray(s)) return s;
  // A legacy prose summary is preserved as takeaways rather than dropped —
  // same rule summaryEdit.js applies when it opens.
  const seeded =
    typeof s === 'string' && s.trim()
      ? { keyTakeaways: s.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean) }
      : {};
  state.summary = seeded;
  return seeded;
}

/** Case-insensitive union, preserving order and the first spelling seen. */
function union(...lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const item of Array.isArray(list) ? list : []) {
      const text = String(item || '').trim();
      const key = normI(text);
      if (!text || !key || seen.has(key)) continue;
      seen.add(key);
      out.push(text);
    }
  }
  return out;
}

/**
 * Keep one live insight: remembered as the operator's own, and written into
 * the summary immediately so it reaches the PDF even if the post-meeting AI
 * never runs. Caller persists.
 */
export function keepInsight(state, text) {
  const insight = String(text || '').trim();
  if (!insight) return;
  const lf = liveFlagsState(state);
  lf.keptInsights = union(lf.keptInsights, [insight]);
  applyKeptInsights(state);
}

/** `list` with the operator's kept insights merged in front (for the editor). */
export function withKeptInsights(state, list) {
  return union(liveFlagsState(state).keptInsights, list);
}

/**
 * Forget kept insights the operator has since deleted by hand.
 *
 * Without this, editing one out of the summary would only hold until the next
 * AI run re-asserted it — an edit that silently undoes itself is worse than no
 * memory at all. Call with the insight list the editor is saving.
 */
export function reconcileKept(state, insights) {
  const lf = liveFlagsState(state);
  if (lf.keptInsights.length === 0) return;
  const present = new Set((Array.isArray(insights) ? insights : []).map(normI));
  lf.keptInsights = lf.keptInsights.filter((i) => present.has(normI(i)));
}

/**
 * Re-assert the operator's kept insights on top of the current summary.
 *
 * Call after any wholesale replacement of ctx.state.summary (the home server's
 * summary, an imported external-AI reply). Kept insights lead — they were
 * chosen by hand during the meeting — and the AI's own keyInsights follow,
 * de-duplicated against them.
 */
export function applyKeptInsights(state) {
  const lf = liveFlagsState(state);
  if (lf.keptInsights.length === 0) return;
  const summary = summaryObject(state);
  summary.keyInsights = union(lf.keptInsights, summary.keyInsights);
}
