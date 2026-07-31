// First-run checklist: a visible path to "fully set up" that replaces
// doc-reading. Shown at the top of the Meeting screen until every item is
// done (then it retires permanently) or the operator dismisses it.

import { openSettings } from './settings.js';

const CHECKLIST_KEY = 'meetingmaster.checklist.v1';
export const FIRST_TRANSCRIPT_KEY = 'meetingmaster.firstTranscript.v1';

let ctx = null;
let host = null;

function stored() {
  try {
    return JSON.parse(localStorage.getItem(CHECKLIST_KEY) || '{}') || {};
  } catch {
    return {};
  }
}

function store(patch) {
  try {
    localStorage.setItem(CHECKLIST_KEY, JSON.stringify({ ...stored(), ...patch }));
  } catch {
    // Storage unavailable — the checklist just re-appears next launch.
  }
}

export function initChecklist(context) {
  ctx = context;
  host = document.getElementById('setup-checklist');
  if (!host) return;
  refreshChecklist();
}

export async function refreshChecklist() {
  if (!host || !ctx) return;
  const flags = stored();
  if (flags.done || flags.dismissed || !ctx.api) {
    host.hidden = true;
    return;
  }

  const items = [];

  const cfg = ctx.config || {};
  items.push({
    label: 'Connect the home server',
    done: Boolean(cfg.serverUrl && cfg.hasToken),
    onClick: () => openSettings(),
  });

  let micDone = false;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    micDone = devices.some((d) => d.kind === 'audioinput');
  } catch {
    micDone = false;
  }
  items.push({ label: 'Microphone available', done: micDone, onClick: () => openSettings() });

  if (typeof ctx.api.liveSupportGet === 'function') {
    try {
      const support = await ctx.api.liveSupportGet();
      if (support && support.supported) {
        const model = support.models && support.models[cfg.liveModel || 'small'];
        items.push({
          label: 'Download the live transcription model',
          done: Boolean(model && model.downloaded),
          onClick: () => openSettings(),
        });
      }
    } catch {
      // No live support info — skip the item rather than nag.
    }
  }

  items.push({
    label: 'Record and transcribe your first meeting',
    done: localStorage.getItem(FIRST_TRANSCRIPT_KEY) === '1',
  });

  if (items.every((i) => i.done)) {
    store({ done: true }); // never comes back
    host.hidden = true;
    return;
  }

  host.hidden = false;
  host.replaceChildren();

  const head = document.createElement('div');
  head.className = 'checklist-head';
  const title = document.createElement('strong');
  const doneCount = items.filter((i) => i.done).length;
  title.textContent = `Getting set up — ${doneCount} of ${items.length}`;
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'toast-close';
  dismiss.textContent = '×';
  // "Hide", not "Dismiss": several flows have real Dismiss buttons and this
  // one must not collide with their accessible-name queries.
  dismiss.setAttribute('aria-label', 'Hide the setup checklist');
  dismiss.addEventListener('click', () => {
    store({ dismissed: true });
    host.hidden = true;
  });
  head.append(title, dismiss);
  host.append(head);

  for (const item of items) {
    const row = document.createElement(item.onClick && !item.done ? 'button' : 'div');
    row.className = `checklist-row${item.done ? ' is-done' : ''}`;
    if (row.tagName === 'BUTTON') {
      row.type = 'button';
      row.addEventListener('click', item.onClick);
    }
    row.textContent = `${item.done ? '✓' : '○'} ${item.label}`;
    host.append(row);
  }
}
