// Meeting Master renderer bootstrap.
// Owns the single state object, persistence, and wires the feature modules.

import { initDetailsForm, renderDetailsForm } from './detailsForm.js';
import { initCapture, openCardModal } from './capture.js';
import { initQuickCapture } from './quickCapture.js';
import { initCardList, renderCards } from './cardList.js';
import { initGenerate, updateButtons, maybeResumePolling, startAi } from './generate.js';
import { initStatus, setStatus, showError } from './status.js';
import { initSettings, openSettings } from './settings.js';
import { initExtractReview, renderExtractPrompt } from './extractReview.js';
import { initSummaryEdit, openSummaryEdit } from './summaryEdit.js';
import { initEmailPreview, openEmailPreview } from './emailPreview.js';
import { initNameFix, openNameFix } from './nameFix.js';
import { initHistory, saveCurrentToHistory } from './history.js';
import { initRecorder, renderNote, updateWindowTitle, updateRecordGuard } from './recorder.js';
import { initLiveTranscript, hideLivePane } from './liveTranscript.js';
import { initLiveFlags, renderLiveFlags } from './liveFlags.js';
import { initStage, refreshStage } from './stage.js';
import { initPreflight, refreshPreflight } from './preflight.js';
import { initChecklist, refreshChecklist } from './checklist.js';
import { initProblems, clearAllProblems } from './problems.js';
import { showToast } from './toast.js';
import { initNav } from './nav.js';
import { initTheme } from './theme.js';
import { initServerStatus } from './serverStatus.js';
import { initActivity } from './activity.js';
import { initAppUpdate } from './appUpdate.js';
import { initCommandPalette } from './commandPalette.js';
import { initSaveIndicator } from './saveIndicator.js';
import { initShell } from './shell.js';
import { initAttendees, resetAttendeePrompts } from './attendees.js';
import { initAnswerFill } from './answerFill.js';
import { isTypingTarget, anyModalOpen } from './keys.js';
import { openModal, closeModal } from './modalKit.js';

const STORAGE_KEY = 'meetingmaster.meeting.v1';
// Coalesce a burst of persist() calls into one 'saved' announcement.
const SAVED_DEBOUNCE_MS = 400;
let savedTimer = null;

function newMeetingId() {
  return `m-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// Local (not UTC) yyyy-mm-dd — a new meeting is on the day it's created.
function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate()
  ).padStart(2, '0')}`;
}

function defaultState() {
  return {
    // Stable id so a saved meeting updates its own history entry (not a dup).
    meetingId: newMeetingId(),
    // Date defaults to today, time to the usual 11 AM slot — both editable.
    details: { title: '', date: todayIso(), time: '11:00', attendees: [] },
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
    // Which job's transcript-ready checkpoint already auto-opened Fix names.
    namesPromptedJobId: null,
    pdfPath: null,
    // Finished in-app recording attached to this meeting (see recorder.js):
    // {recId, filePath, durationMs, bytes, finishedAt, source} or null.
    recording: null,
    // Mid-meeting live question candidates (liveFlags.js): pending rows and
    // dismissed question keys (normQ strings) — both per meeting.
    liveFlags: { pending: [], dismissed: [] },
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
      // The write above is synchronous and already done; this only tells the
      // UI about it. Debounced because persist() fires per keystroke and the
      // indicator would otherwise thrash.
      clearTimeout(savedTimer);
      savedTimer = setTimeout(
        () => document.dispatchEvent(new CustomEvent('mm:saved')),
        SAVED_DEBOUNCE_MS
      );
    },
    renderAll() {
      renderDetailsForm(ctx);
      renderCards(ctx);
      renderExtractPrompt();
      updateButtons(ctx);
      renderNote(); // the "Recording attached" line (no-op before initRecorder)
      renderLiveFlags(); // live candidates rail (no-op before initLiveFlags)
      updateWindowTitle(); // taskbar title mirrors meeting + recording state
      updateRecordGuard(); // "not recording" hint
      refreshStage(); // stage-aware panel emphasis (no-op before initStage)
      refreshChecklist(); // first-run checklist (no-op before initChecklist)
    },
  };

  initStatus(ctx);
  initDetailsForm(ctx);
  initCardList(ctx, { onEditCard: (card) => openCardModal(card) });
  initAttendees(ctx, { onChanged: () => renderDetailsForm(ctx) });
  initCapture(ctx, { onCardsChanged: () => renderCards(ctx) });
  initQuickCapture();
  initExtractReview(ctx, { onCardsAdded: () => renderCards(ctx) });
  initAnswerFill(ctx, { onCardsChanged: () => updateButtons(ctx) });
  initGenerate(ctx);
  initRecorder(ctx); // after initGenerate — it drives the upload buttons' state
  initLiveTranscript(ctx);
  initLiveFlags(ctx); // approvals commit through capture.js's addCard()
  initStage(ctx);
  initPreflight(ctx);
  initChecklist(ctx);
  initProblems();
  initSummaryEdit(ctx, { onSaved: () => setStatus('Summary updated — it will appear in the next PDF.') });
  initEmailPreview(ctx);
  initNameFix(ctx, {
    onApplied: (count) => {
      ctx.renderAll();
      setStatus(`Names updated (${count} correction${count === 1 ? '' : 's'}) across the whole meeting.`);
    },
    onStartAi: () => startAi(),
  });
  const emailTextBtn = document.getElementById('email-text-btn');
  if (emailTextBtn) emailTextBtn.addEventListener('click', () => openEmailPreview());
  const fixNamesBtn = document.getElementById('fix-names-btn');
  if (fixNamesBtn) fixNamesBtn.addEventListener('click', () => openNameFix());
  initHistory(ctx, {
    onStartFrom: (seed) => startNewMeeting(seed),
    onOpened: () => {
      ctx.renderAll();
      // A restored snapshot might still be mid-pipeline — pick polling back up.
      maybeResumePolling();
      setStatus('Opened a saved meeting.');
    },
  });
  // After a successful save, refresh the header connection info (but don't
  // re-trigger the launch-time auto-open of the Settings modal). Readiness
  // surfaces re-check too — a fixed setting should clear its warning at once.
  initSettings(ctx, {
    onSaved: () => {
      refreshConfig(ctx);
      refreshPreflight();
      refreshChecklist();
    },
  });
  initTheme(ctx);
  initServerStatus(ctx);
  initActivity(ctx);
  initSaveIndicator();
  initShell();
  initNav(); // last: emits the initial mm:screen event to ready listeners
  initShortcutsOverlay();
  initCommandPalette();
  showAppVersion(ctx).then(() => initAppUpdate(ctx));

  document.getElementById('add-card-btn').addEventListener('click', () => openCardModal(null));
  document.getElementById('edit-summary-btn').addEventListener('click', () => openSummaryEdit());

  const switchModeBtn = document.getElementById('switch-mode-btn');
  // In the server-mode notes studio this UI IS on the home server — hide the
  // "switch to server mode" field to avoid a confusing self-switch.
  if (switchModeBtn && ctx.api && typeof ctx.api.getMode === 'function') {
    ctx.api
      .getMode()
      .then((res) => {
        if (res && res.mode === 'server') {
          const field = switchModeBtn.closest('.field');
          if (field) field.hidden = true;
          // Server mode: reveal the Dashboard tab (the loopback dashboard
          // embedded in this same window — no second window, no browser).
          const navDash = document.getElementById('nav-dashboard');
          if (navDash) navDash.hidden = false;
          const frame = document.getElementById('dashboard-frame');
          if (frame && typeof ctx.api.getSidecarState === 'function') {
            ctx.api
              .getSidecarState()
              .then((st) => {
                if (st && st.url) frame.src = st.url;
              })
              .catch(() => {});
          }
        }
      })
      .catch(() => {});
  }
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

  // One reset, two entry points: the New meeting button, and History's "Start
  // like this" (which hands over a seed of details/recipients/options to keep,
  // and nothing else).
  function startNewMeeting(seed) {
    if (typeof ctx.recActive === 'function' && ctx.recActive()) {
      showError('A recording is in progress — stop or discard it before starting a new meeting.');
      return;
    }
    // Undo instead of a confirm popup: the outgoing meeting is snapshotted to
    // History anyway, so the action is safe to take immediately and cheap to
    // reverse — faster when you meant it, forgiving when you didn't.
    const hadContent = Boolean(
      ((state.details && state.details.title) || '').trim() ||
        (state.cards && state.cards.length)
    );
    const previous = hadContent ? JSON.parse(JSON.stringify(state)) : null;
    saveCurrentToHistory();
    // Replace contents in place — modules hold a reference to `state`.
    Object.assign(state, defaultState());
    if (seed) {
      if (seed.details) Object.assign(state.details, seed.details);
      if (Array.isArray(seed.recipients)) state.recipients = seed.recipients;
      if (seed.options) Object.assign(state.options, seed.options);
    }
    ctx.persist();
    hideLivePane(); // a new meeting starts with a clean live-transcript pane
    resetAttendeePrompts(); // a new roster, so ask about names again
    clearAllProblems(); // stale failure cards belong to the previous meeting
    ctx.renderAll();
    // Kill any interval still polling the previous meeting's job.
    maybeResumePolling();
    setStatus(
      seed
        ? 'New meeting started from a saved one — details and recipients carried over.'
        : 'New meeting started.'
    );
    if (previous) {
      showToast({
        kind: 'info',
        title: 'New meeting started',
        message: 'The previous meeting was saved to History.',
        action: {
          label: 'Undo',
          onClick: () => {
            Object.assign(state, previous);
            ctx.persist();
            ctx.renderAll();
            maybeResumePolling();
            setStatus('Restored the previous meeting.');
          },
        },
      });
    }
  }

  document.getElementById('new-meeting-btn').addEventListener('click', () => startNewMeeting(null));

  ctx.renderAll();
  // Only the launch-time refresh auto-opens Settings when unconfigured.
  refreshConfig(ctx, { autoOpen: true });
}

// The "?" overlay listing the app's keyboard shortcuts.
function initShortcutsOverlay() {
  const backdrop = document.getElementById('shortcuts-modal');
  if (!backdrop) return;
  const close = () => closeModal(backdrop);
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
    if (isTypingTarget(e.target)) return;
    // Don't stack on top of another open dialog.
    if (anyModalOpen(backdrop)) return;
    e.preventDefault();
    openModal(backdrop, document.getElementById('shortcuts-close-btn'));
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
    refreshChecklist(); // config-dependent items (server connected) just resolved
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
