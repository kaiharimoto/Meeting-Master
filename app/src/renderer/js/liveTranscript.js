// Live transcript pane (inside the Record audio panel).
//
// Renders segments pushed from main (LIVE_EVENT via api.onLiveEvent) into a
// scrolling .log-view. The text is DELIBERATELY in-memory only: the audio is
// already crash-proof on disk, and the authoritative transcript comes from
// the home server's full-quality pass after the meeting — persisting hours of
// draft text into the localStorage-backed state would bloat every persist()
// and risk a stale draft resurfacing beside the real transcript. The Copy
// button covers "I want this text right now".

import { showToast } from './toast.js';

let els = null;
let fullText = '';

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
      try {
        await navigator.clipboard.writeText(fullText);
        showToast({ kind: 'success', title: 'Live transcript copied', message: 'Draft quality — the final transcript comes after the meeting.' });
      } catch {
        // Clipboard denied — nothing actionable.
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
    appendLine(payload.text, '');
  } else if (payload.type === 'lag') {
    appendLine('[skipped ahead — live transcription fell behind]', 'live-note');
  } else if (payload.type === 'error' && payload.message) {
    appendLine(payload.message, 'live-note');
  }
  // 'stopped' keeps the pane visible so the draft stays copyable.
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

/** Clear pane + buffer (new live session or New meeting). */
export function resetLivePane() {
  fullText = '';
  if (els && els.view) els.view.replaceChildren();
}

/** Hide the pane entirely (New meeting). */
export function hideLivePane() {
  resetLivePane();
  if (els && els.wrap) els.wrap.hidden = true;
}
