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
import { initNav } from './nav.js';
import { initTheme } from './theme.js';
import { initServerStatus } from './serverStatus.js';
import { initActivity } from './activity.js';
import { initAppUpdate } from './appUpdate.js';

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
  initTheme(ctx);
  initServerStatus(ctx);
  initActivity(ctx);
  initNav(); // last: emits the initial mm:screen event to ready listeners
  initShortcutsOverlay();
  showAppVersion(ctx).then(() => initAppUpdate(ctx));

  document.getElementById('add-card-btn').addEventListener('click', () => openCardModal(null));
  document.getElementById('edit-summary-btn').addEventListener('click', () => openSummaryEdit());

  const switchModeBtn = document.getElementById('switch-mode-btn');
  if (switchModeBtn) {
    switchModeBtn.addEventListener('click', async () => {
      if (!ctx.api || typeof ctx.api.setMode !== 'function') {
        showError('Switching modes needs the desktop app.');
        return;
      }
      const sure = window.confirm(
        'Switch this machine to home server mode? The app restarts and runs ' +
          'the AI server + dashboard here instead of the meeting-capture UI.'
      );
      if (!sure) return;
      try {
        await ctx.api.setMode('server');
      } catch (err) {
        showError(err && err.message ? err.message : String(err));
      }
    });
  }

  const fontsBtn = document.getElementById('open-fonts-btn');
  if (fontsBtn) {
    fontsBtn.addEventListener('click', async () => {
      if (!ctx.api || typeof ctx.api.openFontsFolder !== 'function') {
        showError('Opening the fonts folder needs the desktop app.');
        return;
      }
      try {
        await ctx.api.openFontsFolder();
      } catch (err) {
        showError(err && err.message ? err.message : String(err));
      }
    });
  }

  document.getElementById('new-meeting-btn').addEventListener('click', () => {
    const ok = confirm('Start a new meeting? This clears the details, Q&A cards, and job state.');
    if (!ok) return;
    // Preserve the outgoing meeting in history before clearing it.
    saveCurrentToHistory();
    // Replace contents in place — modules hold a reference to `state`.
    Object.assign(state, defaultState());
    ctx.persist();
    ctx.renderAll();
    // Kill any interval still polling the previous meeting's job.
    maybeResumePolling();
    setStatus('New meeting started.');
  });

  ctx.renderAll();
  // Only the launch-time refresh auto-opens Settings when unconfigured.
  refreshConfig(ctx, { autoOpen: true });
}

// The "?" overlay listing the app's keyboard shortcuts.
function initShortcutsOverlay() {
  const backdrop = document.getElementById('shortcuts-modal');
  if (!backdrop) return;
  const close = () => {
    backdrop.hidden = true;
  };
  document.getElementById('shortcuts-close-btn').addEventListener('click', close);
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) close();
  });
  backdrop.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== '?' || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    const typing =
      t && t.tagName && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    if (typing) return;
    // Don't stack on top of another open dialog.
    if (document.querySelector('.modal-backdrop:not([hidden])')) return;
    e.preventDefault();
    backdrop.hidden = false;
    document.getElementById('shortcuts-close-btn').focus();
  });
}

// Sidebar footer version label (the channel only exists on newer preloads —
// guarded so the e2e window.api stubs stay valid). Stores the base version on
// the element so appUpdate.js can render "v1 → v2 ready" without re-fetching.
async function showAppVersion(ctx) {
  const el = document.getElementById('app-version');
  if (!el || !ctx.api || typeof ctx.api.getAppInfo !== 'function') return;
  try {
    const info = await ctx.api.getAppInfo();
    if (info && info.version) {
      el.dataset.baseVersion = info.version;
      el.textContent = `v${info.version}`;
    }
  } catch {
    // Version display is a nicety — never an error path.
  }
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
