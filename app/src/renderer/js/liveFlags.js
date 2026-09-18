// Live suggestions — the peripheral rail beside the Meeting screen.
//
// Suggestions flagged mid-meeting by the home server (LIVE_EVENT
// {type:'flag-candidates'}) collect in a sticky side rail the operator can
// MONITOR while typing questions manually: it never reflows the main column,
// never grabs focus, never announces itself, and stays visible (and mouse-
// clickable) above the capture modal's backdrop. New arrivals just bump the
// counter and glide in.
//
// Approve turns a suggestion into an ordinary editable card.
//
// The rail used to offer a second kind, candidate key insights, kept into the
// summary's Key Insights. That was retired in v0.22.0 in favour of the meeting
// progress map (map.js), which shows where the meeting has got to rather than
// offering one-line lessons to approve. The summary's Key Insights section is
// unaffected — it comes from the post-meeting pass over the full transcript.
//
// Dismiss remembers the item (per meeting) so neither the live loop nor the
// post-meeting extraction re-surfaces it. Un-actioned questions are merged into
// the post-meeting review by captureExtracted() — nothing vanishes.
//
// The rail also carries the loop's status line ({type:'flag-status'}). It is
// deliberately understated — no toast, never focus — but it IS there: before it
// existed, a home server that was unreachable, switched off, or simply slow all
// looked exactly like a quiet meeting. It is announced to screen readers only
// when something is actually wrong, so a routine "asking…" every 45 seconds
// doesn't talk over the meeting.
//
// The rail lives on the Meeting screen, so while the operator is on Activity or
// the Dashboard a count rides on the sidebar's Meeting item instead — the same
// job the recording dot does for a running recording.

import { setStatus } from './status.js';
import { showToast } from './toast.js';
import { normQ, isDuplicate } from './extractReview.js';
import { addCard } from './capture.js';
import { updateButtons } from './generate.js';

// A 90-minute meeting nobody triages would otherwise grow an unbounded rail
// (and an unbounded localStorage record). Past these, the OLDEST pending
// suggestion is dropped: the newest are the ones still relevant to what is
// being said, and anything dropped is re-found by the post-meeting pass.
const MAX_PENDING_QUESTIONS = 12;

let ctx = null;
let els = null;

// The rail shows while a live session runs (even when empty, so the operator
// knows it is listening) and whenever suggestions are pending.
let liveSessionActive = false;
// Last {state, message} from the flagging loop, rendered as the status line.
let loopStatus = null;

/** ctx.state.liveFlags, with both arrays guaranteed to exist. */
function flagsState() {
  const state = ctx.state;
  if (!state.liveFlags || typeof state.liveFlags !== 'object') state.liveFlags = {};
  const lf = state.liveFlags;
  for (const key of ['pending', 'dismissed']) {
    if (!Array.isArray(lf[key])) lf[key] = [];
  }
  return lf;
}

export function initLiveFlags(context) {
  ctx = context;
  els = {
    rail: document.getElementById('live-rail'),
    list: document.getElementById('live-rail-list'),
    count: document.getElementById('live-rail-count'),
    empty: document.getElementById('live-rail-empty'),
    status: document.getElementById('live-rail-status'),
    screen: document.getElementById('screen-meeting'),
    navMeeting: document.getElementById('nav-meeting'),
  };
  if (!els.rail || !els.list) return;

  if (ctx.api && typeof ctx.api.onLiveEvent === 'function') {
    ctx.api.onLiveEvent((payload) => {
      if (!payload) return;
      if (payload.type === 'flag-candidates') {
        addCandidates(payload.questions);
      } else if (payload.type === 'flag-status') {
        loopStatus = { state: payload.state || '', message: payload.message || '' };
        renderLiveFlags();
      } else if (payload.type === 'stopped') {
        liveSessionActive = false;
        loopStatus = null;
        renderLiveFlags();
      }
    });
  }

  document.addEventListener('mm:live-start', () => {
    liveSessionActive = true;
    renderLiveFlags();
  });

  // captureExtracted() (post-meeting reconciliation) empties pending and
  // fires this so the rail clears without an import cycle.
  document.addEventListener('mm:liveflags', renderLiveFlags);

  // Leaving or returning to the Meeting screen moves the count between the rail
  // and the sidebar badge.
  document.addEventListener('mm:screen', renderLiveFlags);

  renderLiveFlags();
}

function addCandidates(questions) {
  const lf = flagsState();
  let added = 0;

  const list = Array.isArray(questions) ? questions : [];
  if (list.length > 0) {
    const cardQs = (ctx.state.cards || []).map((c) => normQ(c.question)).filter(Boolean);
    const pendingQs = lf.pending.map((p) => normQ(p.question));
    for (const q of list) {
      if (!q || !q.question) continue;
      const nq = normQ(q.question);
      if (!nq) continue;
      const dupe =
        cardQs.some((e) => isDuplicate(nq, e)) ||
        pendingQs.some((e) => isDuplicate(nq, e)) ||
        lf.dismissed.some((e) => isDuplicate(nq, e));
      if (dupe) continue;
      lf.pending.push({
        question: String(q.question || ''),
        answer: String(q.answer || ''),
        answerer: String(q.answerer || ''),
        directedTo: String(q.directedTo || ''),
        confidence: q.confidence === 'high' ? 'high' : 'low',
        isNew: true, // one-shot arrival animation
      });
      pendingQs.push(nq);
      added += 1;
    }
  }

  if (added > 0) {
    // Cap AFTER the additions, so the newest always get in.
    if (lf.pending.length > MAX_PENDING_QUESTIONS) {
      lf.pending.splice(0, lf.pending.length - MAX_PENDING_QUESTIONS);
    }
    ctx.persist();
    renderLiveFlags();
    // The arrival animation is one-shot: clear the marker after render so a
    // later re-render (approve/dismiss elsewhere) doesn't replay it.
    lf.pending.forEach((p) => {
      delete p.isNew;
    });
  }
}

export function renderLiveFlags() {
  if (!els || !els.rail) return;
  const lf = flagsState();
  const n = lf.pending.length;

  const show = liveSessionActive || n > 0;
  els.rail.hidden = !show;
  if (els.screen) els.screen.classList.toggle('has-rail', show);
  renderNavBadge(n);
  if (!show) {
    els.list.replaceChildren();
    if (els.status) els.status.hidden = true;
    return;
  }

  if (els.count) {
    els.count.hidden = n === 0;
    els.count.textContent = String(n);
    // A bare numeral next to a heading reads as "1". Say what it counts.
    els.count.setAttribute('aria-label', `${n} suggestion${n === 1 ? '' : 's'} waiting`);
  }
  renderStatus();
  // The "listening…" explainer only earns its space while nothing is pending
  // and nothing more urgent (an error, "switched off") is being said.
  const statusOwnsTheSpace = Boolean(
    loopStatus && (loopStatus.state === 'off' || loopStatus.state === 'error')
  );
  if (els.empty) els.empty.hidden = n !== 0 || statusOwnsTheSpace;

  refreshDatalist();
  els.list.replaceChildren();
  lf.pending.forEach((candidate, index) => els.list.append(buildRow(candidate, index)));
}

function renderStatus() {
  if (!els.status) return;
  if (!loopStatus || !loopStatus.message) {
    els.status.hidden = true;
    return;
  }
  const state = loopStatus.state || '';
  els.status.hidden = false;
  els.status.textContent = loopStatus.message;
  els.status.dataset.state = state;
  // Announce the states that mean something is wrong (or off); stay silent for
  // the routine ones, which repeat every interval for the whole meeting.
  const worthSaying = state === 'error' || state === 'off';
  els.status.setAttribute('aria-live', worthSaying ? 'polite' : 'off');
}

// A count on the sidebar's Meeting item while the rail itself is off-screen.
// Without it, suggestions pile up unseen the moment the operator opens Activity
// to check the server — and the rail is the only place they exist.
function renderNavBadge(n) {
  const nav = els.navMeeting;
  if (!nav) return;
  const onMeetingScreen = !(els.screen && els.screen.hidden);
  const show = n > 0 && !onMeetingScreen;
  let badge = nav.querySelector('.nav-badge');
  if (!show) {
    if (badge) badge.remove();
    return;
  }
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'nav-badge';
    nav.append(badge);
  }
  badge.textContent = String(n);
  badge.title = `${n} live suggestion${n === 1 ? '' : 's'} waiting`;
  badge.setAttribute('aria-label', badge.title);
}

// The shared answerer datalist lives in the extract modal's markup; options
// come from this meeting's attendees (same pattern as extractReview.js).
function refreshDatalist() {
  const datalist = document.getElementById('extract-participant-options');
  if (!datalist) return;
  const attendees = (ctx.state.details && ctx.state.details.attendees) || [];
  datalist.replaceChildren(
    ...attendees.map((name) => {
      const option = document.createElement('option');
      option.value = name;
      return option;
    })
  );
}

function buildRow(candidate, index) {
  const row = document.createElement('div');
  row.className = 'live-flag-row';
  if (candidate.confidence === 'low') row.classList.add('is-unsure');
  if (candidate.isNew) row.classList.add('is-new');

  const q = document.createElement('div');
  q.className = 'live-flag-q';
  q.textContent = candidate.question;
  row.append(q);

  if (candidate.answer) {
    const a = document.createElement('div');
    a.className = 'live-flag-a';
    a.textContent = candidate.answer;
    row.append(a);
  }

  const meta = document.createElement('div');
  meta.className = 'extract-meta';
  const answererLabel = document.createElement('label');
  answererLabel.className = 'extract-answerer-label';
  answererLabel.append('Answered by ');
  const answerer = document.createElement('input');
  answerer.type = 'text';
  answerer.className = 'extract-answerer';
  answerer.autocomplete = 'off';
  answerer.setAttribute('list', 'extract-participant-options');
  answerer.value = candidate.answerer || '';
  answerer.placeholder = 'Who answered?';
  answererLabel.append(answerer);
  meta.append(answererLabel);

  if (candidate.confidence === 'low') {
    const flag = document.createElement('span');
    flag.className = 'extract-flag';
    flag.textContent = 'check answerer';
    flag.title = 'The AI was unsure who answered — please confirm.';
    meta.append(flag);
  }
  if (candidate.directedTo && candidate.directedTo !== candidate.answerer) {
    const directed = document.createElement('span');
    directed.className = 'extract-directed';
    directed.textContent = `directed to ${candidate.directedTo}`;
    meta.append(directed);
  }
  row.append(meta);

  const actions = document.createElement('div');
  actions.className = 'live-flag-actions';

  const approve = document.createElement('button');
  approve.type = 'button';
  approve.className = 'btn btn-primary btn-small';
  approve.textContent = 'Approve';
  approve.addEventListener('click', () => {
    const lf = flagsState();
    lf.pending.splice(index, 1);
    // addCard() is the single place a card comes into existence — it persists
    // (the pending splice above rides along) and re-renders the list.
    addCard({
      question: candidate.question,
      answer: candidate.answer,
      participant: answerer.value.trim(),
    });
    renderLiveFlags();
    updateButtons(ctx);
    setStatus('Question added to the Q&A list.');
  });

  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'btn btn-secondary btn-small';
  dismiss.textContent = 'Dismiss';
  dismiss.addEventListener('click', () => {
    const lf = flagsState();
    const nq = normQ(candidate.question);
    if (nq && !lf.dismissed.includes(nq)) lf.dismissed.push(nq);
    lf.pending.splice(index, 1);
    ctx.persist();
    renderLiveFlags();
    showToast({
      kind: 'info',
      title: 'Suggestion dismissed',
      message: candidate.question,
      action: {
        label: 'Undo',
        onClick: () => {
          const state = flagsState();
          state.dismissed = state.dismissed.filter((d) => d !== nq);
          state.pending.splice(Math.min(index, state.pending.length), 0, candidate);
          ctx.persist();
          renderLiveFlags();
        },
      },
    });
  });

  actions.append(approve, dismiss);
  row.append(actions);
  return row;
}
