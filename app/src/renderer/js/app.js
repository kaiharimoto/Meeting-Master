// Meeting Master renderer bootstrap.
// Owns the single state object, persistence, and wires the feature modules.

import { initDetailsForm, renderDetailsForm } from './detailsForm.js';
import { initCapture, openCardModal } from './capture.js';
import { initCardList, renderCards } from './cardList.js';
import { initGenerate, updateButtons, maybeResumePolling } from './generate.js';
import { initStatus, setStatus, showError } from './status.js';
import { initSettings, openSettings } from './settings.js';
import { initExtractReview, renderExtractPrompt } from './extractReview.js';
import { initSummaryEdit, openSummaryEdit } from './summaryEdit.js';
import { initHistory, saveCurrentToHistory } from './history.js';

const STORAGE_KEY = 'meetingmaster.meeting.v1';

function newMeetingId() {
  return `m-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function defaultState() {
  return {
    // Stable id so a saved meeting updates its own history entry (not a dup).
    meetingId: newMeetingId(),
    details: { title: '', date: '', time: '', attendees: [] },
    cards: [],
    recipients: [],
    options: { whisperModel: 'large-v3-turbo', emailMode: 'home' },
    job: { id: null, state: null },
    transcript: null,
    summary: null,
    // AI-detected Q&A pairs awaiting operator approval, and whether they've
    // been reviewed (so the prompt doesn't nag after culling/dismissal).
    extractedQuestions: [],
    questionsReviewed: false,
    pdfPath: null,
  };
}

function loadState() {
  const state = defaultState();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      // Shallow-merge known top-level keys so a schema tweak never crashes boot.
      for (const key of Object.keys(state)) {
        if (saved && saved[key] !== undefined) state[key] = saved[key];
      }
    }
  } catch {
    // Corrupt storage: start fresh rather than failing to boot.
  }
  return state;
}

function boot() {
  const state = loadState();

  // Shared context handed to every module. `api` may be missing when the
  // page runs outside Electron (the Playwright e2e tests stub window.api).
  const ctx = {
    state,
    api: window.api || null,
    config: null, // filled by refreshConfig()
    persist() {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      } catch {
        // Quota/unavailable storage should never break the app.
      }
    },
    renderAll() {
      renderDetailsForm(ctx);
      renderCards(ctx);
      renderExtractPrompt();
      updateButtons(ctx);
    },
  };

  initStatus(ctx);
  initDetailsForm(ctx);
  initCardList(ctx, { onEditCard: (card) => openCardModal(card) });
  initCapture(ctx, { onCardsChanged: () => renderCards(ctx) });
  initExtractReview(ctx, { onCardsAdded: () => renderCards(ctx) });
  initGenerate(ctx);
  initSummaryEdit(ctx, { onSaved: () => setStatus('Summary updated — it will appear in the next PDF.') });
  initHistory(ctx, {
    onOpened: () => {
      ctx.renderAll();
      // A restored snapshot might still be mid-pipeline — pick polling back up.
      maybeResumePolling();
      setStatus('Opened a saved meeting.');
    },
  });
  // After a successful save, refresh the header connection info (but don't
  // re-trigger the launch-time auto-open of the Settings modal).
  initSettings(ctx, { onSaved: () => refreshConfig(ctx) });

  document.getElementById('add-card-btn').addEventListener('click', () => openCardModal(null));
  document.getElementById('edit-summary-btn').addEventListener('click', () => openSummaryEdit());

  document.getElementById('new-meeting-btn').addEventListener('click', () => {
    const ok = confirm('Start a new meeting? This clears the details, Q&A cards, and job state.');
    if (!ok) return;
    // Preserve the outgoing meeting in history before clearing it.
    saveCurrentToHistory();
    // Replace contents in place — modules hold a reference to `state`.
    Object.assign(state, defaultState());
    ctx.persist();
    ctx.renderAll();
    setStatus('New meeting started.');
  });

  ctx.renderAll();
  // Only the launch-time refresh auto-opens Settings when unconfigured.
  refreshConfig(ctx, { autoOpen: true });
}

async function refreshConfig(ctx, { autoOpen = false } = {}) {
  const infoEl = document.getElementById('connection-info');
  const noteEl = document.getElementById('config-note');

  if (!ctx.api) {
    infoEl.textContent = 'Running outside Electron — desktop features disabled';
    return;
  }

  try {
    const cfg = await ctx.api.getConfig();
    ctx.config = cfg;
    if (cfg.serverUrl && cfg.hasToken) {
      infoEl.textContent = `Server: ${cfg.serverUrl} · Email: ${cfg.emailMode} · ${cfg.pageSize}`;
      noteEl.hidden = true;
    } else {
      infoEl.textContent = 'Home server not configured';
      noteEl.textContent =
        'Not configured yet — open Settings and paste your connection code from the ' +
        'home server setup page.';
      noteEl.hidden = false;
      // Welcome the operator into the Settings screen on first launch.
      if (autoOpen) openSettings({ welcome: true });
    }
  } catch (err) {
    showError(`Could not read the configuration: ${err.message}`);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
