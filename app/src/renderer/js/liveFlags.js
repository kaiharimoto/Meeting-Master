// Live question suggestions — the peripheral rail beside the Meeting screen.
//
// Candidates flagged mid-meeting by the home server (LIVE_EVENT
// {type:'flag-candidates'}) collect in a sticky side rail the operator can
// MONITOR while typing questions manually: it never reflows the main column,
// never grabs focus, never announces itself, and stays visible (and mouse-
// clickable) above the capture modal's backdrop. New arrivals just bump the
// counter and glide in.
//
// Approve turns a suggestion into an ordinary editable card; Dismiss
// remembers the question (per meeting) so neither the live loop nor the
// post-meeting extraction re-surfaces it. Un-actioned suggestions are merged
// into the post-meeting review by captureExtracted() — nothing vanishes.

import { setStatus } from './status.js';
import { normQ, isDuplicate, makeId } from './extractReview.js';
import { updateButtons } from './generate.js';

let ctx = null;
let onCardsChanged = null;
let els = null;

// The rail shows while a live session runs (even when empty, so the operator
// knows it is listening) and whenever suggestions are pending.
let liveSessionActive = false;

function flagsState() {
  if (!ctx.state.liveFlags || typeof ctx.state.liveFlags !== 'object') {
    ctx.state.liveFlags = { pending: [], dismissed: [] };
  }
  const lf = ctx.state.liveFlags;
  if (!Array.isArray(lf.pending)) lf.pending = [];
  if (!Array.isArray(lf.dismissed)) lf.dismissed = [];
  return lf;
}

export function initLiveFlags(context, opts = {}) {
  ctx = context;
  onCardsChanged = opts.onCardsChanged || function () {};
  els = {
    rail: document.getElementById('live-rail'),
    list: document.getElementById('live-rail-list'),
    count: document.getElementById('live-rail-count'),
    empty: document.getElementById('live-rail-empty'),
    screen: document.getElementById('screen-meeting'),
  };
  if (!els.rail || !els.list) return;

  if (ctx.api && typeof ctx.api.onLiveEvent === 'function') {
    ctx.api.onLiveEvent((payload) => {
      if (!payload) return;
      if (payload.type === 'flag-candidates') addCandidates(payload.questions);
      else if (payload.type === 'stopped') {
        liveSessionActive = false;
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

  renderLiveFlags();
}

function addCandidates(questions) {
  const list = Array.isArray(questions) ? questions : [];
  if (list.length === 0) return;
  const lf = flagsState();
  const cardQs = (ctx.state.cards || []).map((c) => normQ(c.question)).filter(Boolean);
  const pendingQs = lf.pending.map((p) => normQ(p.question));

  let added = 0;
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
  if (added > 0) {
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
  if (!show) {
    els.list.replaceChildren();
    return;
  }

  if (els.count) {
    els.count.hidden = n === 0;
    els.count.textContent = String(n);
  }
  if (els.empty) els.empty.hidden = n !== 0;

  refreshDatalist();
  els.list.replaceChildren();
  lf.pending.forEach((candidate, index) => els.list.append(buildRow(candidate, index)));
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
    ctx.state.cards.push({
      id: makeId(),
      question: candidate.question,
      answer: candidate.answer,
      participant: answerer.value.trim(),
    });
    lf.pending.splice(index, 1);
    ctx.persist();
    renderLiveFlags();
    onCardsChanged();
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
  });

  actions.append(approve, dismiss);
  row.append(actions);
  return row;
}
