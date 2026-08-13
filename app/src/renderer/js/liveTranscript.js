// Live transcript pane (inside the Record audio panel).
//
// Renders segments pushed from main (LIVE_EVENT via api.onLiveEvent) into a
// scrolling .log-view. The text is DELIBERATELY in-memory only: the audio is
// already crash-proof on disk, and the authoritative transcript comes from
// the home server's full-quality pass after the meeting — persisting hours of
// draft text into the localStorage-backed state would bloat every persist()
// and risk a stale draft resurfacing beside the real transcript. The Copy
// button covers "I want this text right now".
//
// The pane keeps the segment list, not just the joined text, so the immersive
// reader can show each line with the offset it arrived at. The same
// memory-only rule covers it: this module owns the draft and never writes it
// into the persisted meeting state.

import { showToast } from './toast.js';
import { copyText } from './clipboard.js';

let els = null;
let fullText = '';

// { text, atMs, kind } — kind is 'segment' or 'note'. Notes (lag warnings,
// errors) are part of the reading experience: a gap in the draft is something
// the operator needs to see, not something to hide from the immersive view.
let segments = [];
const listeners = new Set();

export function initLiveTranscript(ctx) {
  els = {
    wrap: document.getElementById('live-wrap'),
    view: document.getElementById('live-view'),
    follow: document.getElementById('live-follow-check'),
    copy: document.getElementById('live-copy-btn'),
  };
  if (!els.wrap) return;

  if (els.copy) {
    els.copy.addEventListener('click', async () => {
      if (!fullText) return;
      if (await copyText(fullText)) {
        showToast({
          kind: 'success',
          title: 'Live transcript copied',
          message: 'Draft quality — the final transcript comes after the meeting.',
        });
      } else {
        showToast({
          kind: 'error',
          title: 'Could not copy',
          message: 'Select the text in the pane and copy it with Ctrl+C.',
        });
      }
    });
  }

  if (ctx.api && typeof ctx.api.onLiveEvent === 'function') {
    ctx.api.onLiveEvent(onLiveEvent);
  }

  // The recorder announces live-session starts so the pane can clear + show.
  document.addEventListener('mm:live-start', () => {
    resetLivePane();
    els.wrap.hidden = false;
  });
}

function onLiveEvent(payload) {
  if (!els || !els.wrap || !payload) return;
  if (payload.type === 'segment' && payload.text) {
    fullText += (fullText ? ' ' : '') + payload.text;
    record(payload.text, payload.atMs, 'segment');
    appendLine(payload.text, '');
  } else if (payload.type === 'lag') {
    const note = '[skipped ahead — live transcription fell behind]';
    record(note, payload.atMs, 'note');
    appendLine(note, 'live-note');
  } else if ((payload.type === 'error' || payload.type === 'notice') && payload.message) {
    // 'notice' is live transcription telling you it had to change how it
    // works (the GPU crashed, so it moved to the CPU) and kept going; 'error'
    // is it giving up. Both belong in the draft as notes — a reader looking
    // back at a thin stretch needs to know which of the two happened.
    record(payload.message, payload.atMs, 'note');
    appendLine(payload.message, 'live-note');
  }
  // 'stopped' keeps the pane visible so the draft stays copyable.
}

function record(text, atMs, kind) {
  segments.push({ text, atMs: Number.isFinite(Number(atMs)) ? Number(atMs) : null, kind });
  for (const fn of listeners) {
    try {
      fn(segments[segments.length - 1]);
    } catch {
      // A broken subscriber must not stop the pane from rendering.
    }
  }
}

function appendLine(text, extraClass) {
  const line = document.createElement('span');
  line.className = `log-line${extraClass ? ` ${extraClass}` : ''}`;
  line.textContent = text;
  els.view.append(line);
  if (!els.follow || els.follow.checked) {
    els.view.scrollTop = els.view.scrollHeight;
  }
}

/** The draft so far, as { text, atMs, kind } records. A copy: callers render
 *  from it and must not be able to mutate the pane's buffer. */
export function liveSegments() {
  return segments.slice();
}

/** Subscribe to new draft lines. Returns an unsubscribe fn, matching the
 *  shape of the api.on* push subscriptions. */
export function onLiveSegment(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Clear pane + buffer (new live session or New meeting). */
export function resetLivePane() {
  fullText = '';
  segments = [];
  if (els && els.view) els.view.replaceChildren();
  document.dispatchEvent(new CustomEvent('mm:live-reset'));
}

/** Hide the pane entirely (New meeting). */
export function hideLivePane() {
  resetLivePane();
  if (els && els.wrap) els.wrap.hidden = true;
}
