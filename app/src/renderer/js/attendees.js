// Keeping the attendee list honest, without interrupting anyone.
//
// The attendee list is typed before the meeting from the invite. Real meetings
// don't match the invite: people join late, someone brings a colleague, a name
// gets spelled differently. The operator finds out by typing that person's name
// as an answerer — at which point the app knows something the attendee list
// doesn't, and says nothing.
//
// So: when a name is attributed as an answerer and isn't in the list, offer to
// add it. An OFFER, not an addition — "Dana" might be a client on the phone, a
// typo, or a person who really was in the room, and only the operator knows
// which. It costs one click to accept and nothing to ignore.

import { showToast } from './toast.js';

let ctx = null;
let onChanged = null;
// Names the operator has already been asked about this meeting. Asking twice
// about the same person is worse than not asking at all.
const asked = new Set();

export function initAttendees(context, opts = {}) {
  ctx = context;
  onChanged = opts.onChanged || function () {};
}

/** Forget who we've asked about — a new meeting starts the conversation over. */
export function resetAttendeePrompts() {
  asked.clear();
}

function normalize(name) {
  return String(name || '').trim().toLowerCase();
}

function known(name) {
  const key = normalize(name);
  if (!key) return true;
  const list = (ctx.state.details && ctx.state.details.attendees) || [];
  return list.some((a) => normalize(a) === key);
}

/**
 * Offer to add any of `names` that aren't already attendees.
 * Safe to call on every card commit — it stays quiet unless there's news.
 */
export function offerAttendees(names) {
  if (!ctx || !ctx.state) return;
  const fresh = [];
  for (const raw of Array.isArray(names) ? names : [names]) {
    const name = String(raw || '').trim();
    if (!name || known(name) || asked.has(normalize(name))) continue;
    asked.add(normalize(name));
    if (!fresh.includes(name)) fresh.push(name);
  }
  if (fresh.length === 0) return;

  const label = fresh.length === 1 ? fresh[0] : `${fresh.length} people`;
  showToast({
    kind: 'info',
    title: fresh.length === 1 ? 'Not in the attendee list' : 'Not in the attendee list',
    message:
      fresh.length === 1
        ? `${fresh[0]} answered a question but isn't listed as an attendee.`
        : `${fresh.join(', ')} answered questions but aren't listed as attendees.`,
    action: {
      label: `Add ${label}`,
      onClick: () => addAttendees(fresh),
    },
  });
}

function addAttendees(names) {
  if (!ctx.state.details) ctx.state.details = {};
  const list = Array.isArray(ctx.state.details.attendees)
    ? ctx.state.details.attendees
    : [];
  for (const name of names) if (!known(name)) list.push(name);
  ctx.state.details.attendees = list;
  ctx.persist();
  onChanged();
}
