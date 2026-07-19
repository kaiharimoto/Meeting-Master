// Theme API + toggle wiring. themeBoot.js (a plain <head> script) already set
// data-theme before first paint; this module owns changing it at runtime and
// keeping the OS titlebar overlay (Windows) in sync via IPC.

const KEY = 'meetingmaster.theme.v1';

let ctx = null;
let media = null;

export function getThemePreference() {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' || v === 'system' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function resolvedTheme() {
  const pref = getThemePreference();
  if (pref === 'light' || pref === 'dark') return pref;
  return media && media.matches ? 'dark' : 'light';
}

function apply() {
  const theme = resolvedTheme();
  document.documentElement.dataset.theme = theme;
  // Keep the native Windows titlebar overlay matching the app surface. The
  // channel only exists on newer preloads — guard so e2e stubs stay valid.
  const api = ctx && ctx.api;
  if (api && typeof api.setWindowOverlay === 'function') {
    api.setWindowOverlay(theme).catch(() => {});
  }
  updateToggle();
}

export function setThemePreference(pref) {
  try {
    localStorage.setItem(KEY, pref);
  } catch {
    // Storage unavailable — the in-page theme still applies below.
  }
  apply();
}

function updateToggle() {
  const btn = document.getElementById('theme-toggle-btn');
  if (!btn) return;
  const theme = document.documentElement.dataset.theme;
  btn.setAttribute('aria-label', theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
  btn.title = theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
  btn.dataset.mode = theme;
}

export function initTheme(context) {
  ctx = context;
  try {
    media = window.matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', () => {
      if (getThemePreference() === 'system') apply();
    });
  } catch {
    media = null;
  }

  const btn = document.getElementById('theme-toggle-btn');
  if (btn) {
    btn.addEventListener('click', () => {
      // The toggle flips light<->dark explicitly (leaving 'system' once used —
      // predictable, and the OS default still applies on fresh installs).
      setThemePreference(resolvedTheme() === 'dark' ? 'light' : 'dark');
    });
  }
  apply();
}
