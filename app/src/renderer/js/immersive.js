// Immersive transcript reader — the full-screen, large-type view of a
// transcript, live or finished.
//
// Two problems it solves, both reported after weeks of real use:
//
//   * The live pane shares .log-view with the server log: 180px tall, 12px
//     monospace, muted grey. That is the right styling for a debug log and the
//     wrong styling for text a person reads while chairing a meeting — it is
//     hard to read and hard to keep your place in.
//   * The finished transcript had no viewer AT ALL. The damaged-transcript
//     card's "Read the transcript" button used to just press Copy, which tells
//     you how much of a gap this was.
//
// So one reader serves both, in the font the notes will be printed in:
// Neue Haas Grotesk Medium, sized to be read at arm's length rather than
// leaned into, with timestamps and search so a keyword gets you back to the
// moment in the recording.
//
// It does NOT move #live-wrap into the overlay. stage.js rewrites the panel
// DOM at init (headings become toggles, bodies get wrapped) and collapses
// panels per stage; relocating a panel's contents would fight it. The reader
// renders from liveTranscript.js's segment buffer instead, and from
// ctx.state.transcript.segments for the finished pass — read-only in both
// cases. It is deliberately not a writer of state.transcript (see
// test/unit/transcriptSource.test.js).

import { openModal, closeModal, isModalOpen } from './modalKit.js';
import { isTypingTarget, matchChord, openModalEl } from './keys.js';
import { formatTimecode, formatTimecodeMs } from './timecode.js';
import { liveSegments, onLiveSegment } from './liveTranscript.js';
import { ensureBrandFont } from './brandFont.js';

const SIZE_KEY = 'meetingmaster.readersize.v1';
// Steps, not free scaling: each one has to stay readable against the type
// scale in app.css, and a slider invites sizes that look broken.
const SIZES = [1, 1.25, 1.5, 1.9];
const DEFAULT_SIZE_INDEX = 1;

let ctx = null;
let els = null;
let mode = 'live'; // 'live' | 'final'
let unsubscribe = null;
let sizeIndex = DEFAULT_SIZE_INDEX;
let matches = [];
let matchCursor = -1;

export function initImmersive(context) {
  ctx = context;
  els = {
    backdrop: document.getElementById('immersive-modal'),
    title: document.getElementById('immersive-title'),
    note: document.getElementById('immersive-note'),
    body: document.getElementById('immersive-body'),
    search: document.getElementById('immersive-search'),
    count: document.getElementById('immersive-count'),
    prev: document.getElementById('immersive-prev-btn'),
    next: document.getElementById('immersive-next-btn'),
    follow: document.getElementById('immersive-follow-check'),
    smaller: document.getElementById('immersive-smaller-btn'),
    bigger: document.getElementById('immersive-bigger-btn'),
    close: document.getElementById('immersive-close-btn'),
  };
  if (!els.backdrop) return;

  sizeIndex = readSizeIndex();
  applySize();

  els.close.addEventListener('click', close);
  els.smaller.addEventListener('click', () => stepSize(-1));
  els.bigger.addEventListener('click', () => stepSize(1));
  els.search.addEventListener('input', runSearch);
  els.prev.addEventListener('click', () => jumpMatch(-1));
  els.next.addEventListener('click', () => jumpMatch(1));

  els.backdrop.addEventListener('keydown', onKeydown);
  els.backdrop.addEventListener('mousedown', (e) => {
    // Click-out closes, matching every other dialog. Only on the backdrop
    // itself — a drag that starts on text and ends outside must not close.
    if (e.target === els.backdrop) close();
  });

  const readBtn = document.getElementById('read-transcript-btn');
  if (readBtn) readBtn.addEventListener('click', () => open('final'));
  const liveBtn = document.getElementById('live-read-btn');
  if (liveBtn) liveBtn.addEventListener('click', () => open('live'));

  document.addEventListener('keydown', onGlobalKeydown);
  // A new meeting clears the draft; drop any stale text we are showing.
  document.addEventListener('mm:live-reset', () => {
    if (isOpen() && mode === 'live') render();
  });
}

export function isOpen() {
  return Boolean(els) && isModalOpen(els.backdrop);
}

// #read-transcript-btn's enabled state is owned by generate.js's
// updateButtons(), alongside every other transcript-dependent button.

function hasSegments(transcript) {
  return Array.isArray(transcript.segments) && transcript.segments.length > 0;
}

// ---- Open / close ------------------------------------------------------------

function open(which) {
  if (!els || !els.backdrop) return;
  mode = which === 'final' ? 'final' : 'live';

  // Fetch the font on first open rather than at boot: it is a few hundred KB
  // of data: URI that only this view needs, and the app must start fine
  // without it.
  ensureBrandFont(ctx && ctx.api);

  els.title.textContent = mode === 'final' ? 'Meeting transcript' : 'Live transcript';
  els.note.textContent =
    mode === 'final'
      ? 'Timestamps are offsets into the recording.'
      : 'Live draft — rough, a few seconds behind, and timestamps are approximate.';
  els.search.value = '';
  clearMatches();
  render();

  if (mode === 'live') {
    unsubscribe = onLiveSegment((seg) => appendSegment(seg));
  }

  openModal(els.backdrop, els.search);
  scrollToEnd();
}

function close() {
  if (!els) return;
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  closeModal(els.backdrop);
}

function onGlobalKeydown(e) {
  if (!matchChord(e, 'ctrl+shift+l')) return;
  // Closing comes first, and deliberately ignores the typing guard: the
  // reader focuses its own search box on open, so requiring "not typing"
  // would make the chord a one-way door.
  if (isOpen()) {
    e.preventDefault();
    close();
    return;
  }
  if (isTypingTarget(e.target)) return;
  // Never stack on top of another dialog — same rule as Q and ?.
  if (openModalEl(els && els.backdrop)) return;
  e.preventDefault();
  // Reading the finished transcript is the more common need; fall back to the
  // live draft when there is no finished one yet.
  const transcript = ctx && ctx.state && ctx.state.transcript;
  open(transcript && (transcript.text || hasSegments(transcript)) ? 'final' : 'live');
}

function onKeydown(e) {
  if (e.key === 'Escape') {
    e.preventDefault();
    close();
    return;
  }
  // Enter in the search box walks matches — the reflex from every find bar.
  if (e.key === 'Enter' && e.target === els.search) {
    e.preventDefault();
    jumpMatch(e.shiftKey ? -1 : 1);
  }
}

// ---- Rendering ---------------------------------------------------------------

function currentSegments() {
  if (mode === 'live') return liveSegments();

  const transcript = (ctx && ctx.state && ctx.state.transcript) || null;
  if (!transcript) return [];
  if (hasSegments(transcript)) {
    return transcript.segments.map((seg) => ({
      text: typeof seg.text === 'string' ? seg.text.trim() : '',
      seconds: seg.start,
      kind: 'segment',
    }));
  }
  // An older meeting from history may only have the flat text. Still readable,
  // just without timestamps to jump between.
  return transcript.text ? [{ text: transcript.text, seconds: null, kind: 'segment' }] : [];
}

function render() {
  els.body.replaceChildren();
  const segs = currentSegments();
  if (segs.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'immersive-empty';
    empty.textContent =
      mode === 'live'
        ? 'Nothing yet — draft text appears here once the meeting is under way.'
        : 'No transcript yet. It appears once the recording has been transcribed.';
    els.body.append(empty);
    return;
  }
  for (const seg of segs) appendSegment(seg, { silent: true });
  updateCount();
}

function appendSegment(seg, opts = {}) {
  if (!seg || !seg.text) return;
  // The first real line replaces the empty-state placeholder.
  const placeholder = els.body.querySelector('.immersive-empty');
  if (placeholder) placeholder.remove();

  const row = document.createElement('p');
  row.className = `immersive-line${seg.kind === 'note' ? ' is-note' : ''}`;

  const stamp = stampFor(seg);
  if (stamp !== null) {
    const time = document.createElement('span');
    time.className = 'immersive-time';
    time.textContent = stamp;
    row.append(time);
  }

  const text = document.createElement('span');
  text.className = 'immersive-text';
  text.textContent = seg.text;
  row.append(text);

  els.body.append(row);

  if (!opts.silent) {
    // A new line arriving while a search is active has to be searchable too.
    if (els.search.value.trim()) runSearch();
    if (!els.follow || els.follow.checked) scrollToEnd();
  }
}

function stampFor(seg) {
  if (typeof seg.seconds === 'number' && Number.isFinite(seg.seconds)) {
    return formatTimecode(seg.seconds);
  }
  if (typeof seg.atMs === 'number' && Number.isFinite(seg.atMs)) {
    return formatTimecodeMs(seg.atMs);
  }
  return null;
}

function scrollToEnd() {
  els.body.scrollTop = els.body.scrollHeight;
}

// ---- Search ------------------------------------------------------------------

function runSearch() {
  const needle = els.search.value.trim().toLowerCase();
  clearMatches();
  if (!needle) {
    updateCount();
    return;
  }
  for (const row of els.body.querySelectorAll('.immersive-line')) {
    const text = row.querySelector('.immersive-text');
    if (!text) continue;
    if (text.textContent.toLowerCase().includes(needle)) {
      row.classList.add('is-match');
      matches.push(row);
    }
  }
  updateCount();
  if (matches.length > 0) {
    matchCursor = 0;
    focusMatch();
  }
}

function clearMatches() {
  for (const row of els.body.querySelectorAll('.immersive-line.is-match, .immersive-line.is-current')) {
    row.classList.remove('is-match', 'is-current');
  }
  matches = [];
  matchCursor = -1;
}

function jumpMatch(delta) {
  if (matches.length === 0) return;
  matchCursor = (matchCursor + delta + matches.length) % matches.length;
  focusMatch();
}

function focusMatch() {
  for (const row of matches) row.classList.remove('is-current');
  const row = matches[matchCursor];
  if (!row) return;
  row.classList.add('is-current');
  row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  // Stepping to a match means the operator is reading back, not following the
  // live edge — auto-scroll would yank them away again.
  if (els.follow) els.follow.checked = false;
  updateCount();
}

function updateCount() {
  if (!els.count) return;
  if (matches.length === 0) {
    els.count.textContent = els.search.value.trim() ? 'No matches' : '';
  } else {
    els.count.textContent = `${matchCursor + 1} of ${matches.length}`;
  }
  els.prev.disabled = matches.length === 0;
  els.next.disabled = matches.length === 0;
}

// ---- Text size ---------------------------------------------------------------

function readSizeIndex() {
  try {
    const raw = Number(localStorage.getItem(SIZE_KEY));
    return Number.isInteger(raw) && raw >= 0 && raw < SIZES.length ? raw : DEFAULT_SIZE_INDEX;
  } catch {
    return DEFAULT_SIZE_INDEX;
  }
}

function stepSize(delta) {
  sizeIndex = Math.max(0, Math.min(SIZES.length - 1, sizeIndex + delta));
  applySize();
  try {
    localStorage.setItem(SIZE_KEY, String(sizeIndex));
  } catch {
    // Private mode / quota — the size just won't persist.
  }
}

function applySize() {
  if (!els || !els.backdrop) return;
  // Multiplies the --fs-reader token rather than setting px, so this composes
  // with the Text size setting and Ctrl +/- display zoom instead of fighting
  // them. (app.css must contain no literal font-size — see textscale.spec.js.)
  els.backdrop.style.setProperty('--reader-scale', String(SIZES[sizeIndex]));
  if (els.smaller) els.smaller.disabled = sizeIndex === 0;
  if (els.bigger) els.bigger.disabled = sizeIndex === SIZES.length - 1;
}
