// Live question candidates (mid-meeting), rendered INLINE in the Q&A panel.
//
// The home server's live extraction pushes candidates while the meeting runs
// (LIVE_EVENT {type:'flag-candidates'}); each renders as an approve/dismiss
// row the operator can act on without leaving the flow — unlike the
// post-meeting batch modal, this list updates continuously. Approve turns
// the candidate into an ordinary editable card; Dismiss remembers the
// question (per meeting) so neither the live loop nor the post-meeting
// extraction re-surfaces it. Un-actioned candidates are merged into the
// post-meeting review by captureExtracted() — nothing silently vanishes.

import { setStatus } from './status.js';
import { normQ, isDuplicate, makeId } from './extractReview.js';
import { updateButtons } from './generate.js';

let ctx = null;
let onCardsChanged = null;
let host = null;

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
  host = document.getElementById('live-flags');
  if (!host) return;

  if (ctx.api && typeof ctx.api.onLiveEvent === 'function') {
    ctx.api.onLiveEvent((payload) => {
      if (payload && payload.type === 'flag-candidates') {
        addCandidates(payload.questions);
      }
    });
  }

  // captureExtracted() (post-meeting reconciliation) empties pending and
  // fires this so the inline list clears without an import cycle.
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
    });
    pendingQs.push(nq);
    added += 1;
  }
  if (added > 0) {
    ctx.persist();
    renderLiveFlags();
  }
}

export function renderLiveFlags() {
  if (!host) return;
  const lf = flagsState();
  host.replaceChildren();
  if (lf.pending.length === 0) {
    host.hidden = true;
    return;
  }
  host.hidden = false;

  const heading = document.createElement('div');
  heading.className = 'live-flags-heading';
  heading.textContent =
    lf.pending.length === 1
      ? 'Live: 1 question detected in the conversation'
      : `Live: ${lf.pending.length} questions detected in the conversation`;
  host.append(heading);

  refreshDatalist();
  lf.pending.forEach((candidate, index) => host.append(buildRow(candidate, index)));
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
  row.className = 'extract-row live-flag-row';
  if (candidate.confidence === 'low') row.classList.add('is-unsure');

  const content = document.createElement('div');
  content.className = 'extract-content';

  const q = document.createElement('div');
  q.className = 'extract-q';
  q.textContent = candidate.question;
  content.append(q);

  if (candidate.answer) {
    const a = document.createElement('div');
    a.className = 'extract-a';
    a.textContent = candidate.answer;
    content.append(a);
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
  content.append(meta);

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
  row.append(content, actions);
  return row;
}
