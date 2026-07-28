// Ctrl+K command palette.
//
// Everything the app can do is behind a button somewhere, and the operator has
// to know where. The palette is the "I know the verb, not the location" path:
// one chord, type a few letters, Enter. It runs the SAME code paths as the
// buttons — most commands literally click the button — so it can never drift
// out of step with the UI.
//
// Commands whose button is hidden or disabled don't appear. A palette that
// offers "Send email" before a PDF exists is a palette you stop trusting.

import { matchChord, anyModalOpen } from './keys.js';
import { openModal, closeModal, isModalOpen } from './modalKit.js';
import { openCardModal } from './capture.js';
import { focusQuickCapture } from './quickCapture.js';
import { openSettings } from './settings.js';
import { openSummaryEdit } from './summaryEdit.js';
import { openNameFix } from './nameFix.js';
import { openHistory } from './history.js';
import { openExtractModal } from './extractReview.js';
import { showScreen } from './nav.js';
import { getThemePreference, setThemePreference, resolvedTheme } from './theme.js';

let backdrop = null;
let input = null;
let listHost = null;
let emptyEl = null;
let items = []; // currently rendered [{command, el}]
let activeIndex = 0;

// A command backed by a button: available only while that button is usable,
// and "running" it is a real click so the button's own handler stays the one
// implementation.
function button(id, title, keywords) {
  return {
    title,
    keywords,
    available() {
      const el = document.getElementById(id);
      // Disabled or hidden means "can't do this yet". A COLLAPSED panel does
      // not: stage.js hides panel bodies with a class, and being able to run
      // the action without expanding the panel first is half the point.
      return Boolean(el) && !el.disabled && !el.hidden && el.closest('[hidden]') === null;
    },
    run() {
      const el = document.getElementById(id);
      if (el) el.click();
    },
  };
}

function command(title, keywords, run, available) {
  return { title, keywords, run, available: available || (() => true) };
}

function commands() {
  return [
    command('Add a question', 'new card capture q quick', () => focusQuickCapture()),
    command('Add a question with all fields', 'new card answer answerer modal', () =>
      openCardModal(null)
    ),
    button('rec-start-btn', 'Start recording', 'record audio mic'),
    button('rec-stop-btn', 'Stop recording', 'record audio finish'),
    button('pick-audio-btn', 'Generate transcript', 'whisper upload transcribe'),
    button('start-ai-btn', 'Start AI', 'summary summarize questions'),
    command('Review AI-detected questions', 'extract candidates approve', () =>
      openExtractModal()
    , () => {
      const host = document.getElementById('extract-review');
      return Boolean(host) && !host.hidden;
    }),
    command('Edit summary', 'takeaways decisions action items figures topics', () =>
      openSummaryEdit()
    ),
    button('fill-answers-btn', 'Fill blank answers from the transcript',
      'draft ai missing empty gaps'),
    command('Fix names', 'spelling merge attendees', () => openNameFix()),
    button('preview-pdf-btn', 'Preview the PDF', 'print look check page proof'),
    button('generate-pdf-btn', 'Generate PDF', 'print render document'),
    button('open-pdf-btn', 'Open PDF', 'view document'),
    button('send-email-btn', 'Send email', 'mail send deliver'),
    button('email-text-btn', 'Copy the email text', 'manual mail subject body'),
    button('copy-transcript-btn', 'Copy transcript', 'clipboard text'),
    button('save-transcript-btn', 'Save transcript', 'file txt export'),
    button('copy-ai-prompt-btn', 'Copy AI prompt', 'claude chatgpt external paste'),
    button('pick-file-btn', 'Upload an audio file', 'wav mp3 disk'),
    button('new-meeting-btn', 'New meeting', 'reset start over clear'),
    command('Meeting history', 'saved past reopen snapshots', () => openHistory()),
    command('Go to Meeting', 'screen navigate', () => showScreen('meeting')),
    command('Go to Activity', 'screen navigate log pipeline', () => showScreen('activity')),
    command('Settings', 'configuration server token email zoom', () => openSettings()),
    command('Toggle dark mode', 'theme light appearance contrast', () => {
      // Follow-system flips to the opposite of what's currently on screen;
      // after that it's a straight toggle.
      const pref = getThemePreference();
      const now = pref === 'system' ? resolvedTheme() : pref;
      setThemePreference(now === 'dark' ? 'light' : 'dark');
    }),
    command('Keyboard shortcuts', 'help keys chords ?', () => {
      const el = document.getElementById('shortcuts-modal');
      if (el) openModal(el, document.getElementById('shortcuts-close-btn'));
    }),
  ];
}

export function initCommandPalette() {
  backdrop = document.getElementById('palette-modal');
  input = document.getElementById('palette-input');
  listHost = document.getElementById('palette-list');
  emptyEl = document.getElementById('palette-empty');
  if (!backdrop || !input || !listHost) return;

  document.addEventListener('keydown', (e) => {
    if (!matchChord(e, 'ctrl+k')) return;
    e.preventDefault();
    if (isModalOpen(backdrop)) {
      closePalette();
      return;
    }
    // Don't stack on another dialog — the palette would cover it and Escape
    // would become ambiguous.
    if (anyModalOpen(backdrop)) return;
    openPalette();
  });

  input.addEventListener('input', () => render(input.value));
  input.addEventListener('keydown', onInputKeydown);
  backdrop.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closePalette();
    }
  });
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) closePalette();
  });
}

export function openPalette() {
  input.value = '';
  render('');
  openModal(backdrop, input);
}

function closePalette() {
  closeModal(backdrop);
  listHost.replaceChildren();
  items = [];
}

function onInputKeydown(e) {
  if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) {
    e.preventDefault();
    move(1);
  } else if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) {
    e.preventDefault();
    move(-1);
  } else if (e.key === 'Home') {
    e.preventDefault();
    setActive(0);
  } else if (e.key === 'End') {
    e.preventDefault();
    setActive(items.length - 1);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    runActive();
  }
}

function move(delta) {
  if (items.length === 0) return;
  setActive((activeIndex + delta + items.length) % items.length);
}

function setActive(index) {
  activeIndex = Math.max(0, Math.min(index, items.length - 1));
  items.forEach(({ el }, i) => {
    const on = i === activeIndex;
    el.classList.toggle('is-active', on);
    el.setAttribute('aria-selected', String(on));
    if (on) {
      input.setAttribute('aria-activedescendant', el.id);
      el.scrollIntoView({ block: 'nearest' });
    }
  });
  if (items.length === 0) input.removeAttribute('aria-activedescendant');
}

function runActive() {
  const item = items[activeIndex];
  if (!item) return;
  // Close FIRST: modalKit restores focus to the palette's opener on close, so
  // a command that focuses something (or opens its own dialog) has to run
  // after that restoration or it would be undone.
  closePalette();
  item.command.run();
}

// Rank: a match at the start of the title beats one in the middle, which beats
// a keyword-only match. Everything else keeps the declared order.
function score(command, query) {
  if (!query) return 0;
  const title = command.title.toLowerCase();
  const at = title.indexOf(query);
  if (at === 0) return -1000;
  if (at > 0) return -500 + at;
  if (command.keywords.toLowerCase().includes(query)) return 0;
  return null; // no match
}

function render(query) {
  const q = String(query || '').trim().toLowerCase();
  const matched = commands()
    .filter((c) => c.available())
    .map((c, i) => ({ c, i, s: score(c, q) }))
    .filter((r) => r.s !== null)
    .sort((a, b) => a.s - b.s || a.i - b.i);

  listHost.replaceChildren();
  items = matched.map(({ c }, i) => {
    const el = document.createElement('li');
    el.id = `palette-item-${i}`;
    el.className = 'palette-item';
    el.setAttribute('role', 'option');
    el.setAttribute('aria-selected', 'false');
    el.textContent = c.title;
    el.addEventListener('mousemove', () => setActive(i));
    // mousedown, not click: the input must not lose focus before we run.
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      setActive(i);
      runActive();
    });
    listHost.append(el);
    return { command: c, el };
  });

  if (emptyEl) emptyEl.hidden = items.length > 0;
  activeIndex = 0;
  setActive(0);
}
