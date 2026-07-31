// Sidebar navigation. Meeting and Activity are true screens (sections toggled
// in place); History and Settings are sheet-styled modals owned by their own
// modules (their nav buttons keep the ids those modules bind). This module
// only switches screens, keeps the active state honest, and announces screen
// changes so screens can refresh on entry.

import { closeModal } from './modalKit.js';

const SCREENS = {
  meeting: 'screen-meeting',
  activity: 'screen-activity',
  dashboard: 'screen-dashboard', // server mode only (nav item hidden otherwise)
};

let current = 'meeting';

export function currentScreen() {
  return current;
}

export function showScreen(name) {
  if (!SCREENS[name]) name = 'meeting';
  current = name;

  for (const [key, id] of Object.entries(SCREENS)) {
    const el = document.getElementById(id);
    if (el) el.hidden = key !== name;
  }
  // Hash keeps the last screen across reloads (harmless under file://).
  try {
    if (location.hash !== `#${name}`) location.hash = `#${name}`;
  } catch {
    // Sandboxed contexts may reject hash writes — purely cosmetic.
  }
  updateActive();
  document.dispatchEvent(new CustomEvent('mm:screen', { detail: { screen: name } }));
}

function updateActive() {
  const sheetOpen = sheetOpenId();
  const states = {
    'nav-meeting': !sheetOpen && current === 'meeting',
    'nav-activity': !sheetOpen && current === 'activity',
    'nav-dashboard': !sheetOpen && current === 'dashboard',
    'history-btn': sheetOpen === 'history-modal',
    'settings-btn': sheetOpen === 'settings-modal',
  };
  for (const [id, active] of Object.entries(states)) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.classList.toggle('active', Boolean(active));
    // "active" was a class and nothing else — a screen reader had no way to
    // know which of five identical buttons was the one you were on.
    if (active) el.setAttribute('aria-current', 'page');
    else el.removeAttribute('aria-current');
  }
}

function sheetOpenId() {
  for (const id of ['history-modal', 'settings-modal']) {
    const el = document.getElementById(id);
    if (el && !el.hidden) return id;
  }
  return null;
}

export function initNav() {
  document.getElementById('nav-meeting').addEventListener('click', () => {
    closeSheets();
    showScreen('meeting');
  });
  document.getElementById('nav-activity').addEventListener('click', () => {
    closeSheets();
    showScreen('activity');
  });
  const dashBtn = document.getElementById('nav-dashboard');
  if (dashBtn) {
    dashBtn.addEventListener('click', () => {
      closeSheets();
      showScreen('dashboard');
    });
  }

  // History/Settings open+close entirely inside their own modules; watch the
  // hidden attribute so the sidebar's active state always reflects reality.
  const observer = new MutationObserver(updateActive);
  for (const id of ['history-modal', 'settings-modal']) {
    const el = document.getElementById(id);
    if (el) observer.observe(el, { attributes: true, attributeFilter: ['hidden'] });
  }

  const fromHash = (location.hash || '').replace('#', '');
  showScreen(SCREENS[fromHash] ? fromHash : 'meeting');
}

// Opening a screen should dismiss any open sheet so nav reads as one place.
export function closeSheets() {
  for (const id of ['history-modal', 'settings-modal']) {
    const el = document.getElementById(id);
    if (el && !el.hidden) closeModal(el);
  }
}
