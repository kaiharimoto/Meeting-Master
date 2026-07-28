// Appearance API + toggle wiring. themeBoot.js (a plain <head> script) already
// applied theme, contrast and text scale before first paint; this module owns
// changing them at runtime and keeping the OS titlebar overlay (Windows) in
// sync via IPC.
//
// Three INDEPENDENT preferences, deliberately:
//   theme     light | dark | system      — which palette
//   contrast  normal | high              — composes with either palette
//   textScale 0.9 | 1 | 1.12 | 1.25      — type only, NOT display zoom
// Keep the keys and clamps identical to themeBoot.js.

const KEY = 'meetingmaster.theme.v1';
const CONTRAST_KEY = 'meetingmaster.contrast.v1';
const SCALE_KEY = 'meetingmaster.textscale.v1';
export const TEXT_SCALES = [0.9, 1, 1.12, 1.25];

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

// ---- Contrast --------------------------------------------------------------

export function getContrast() {
  try {
    return localStorage.getItem(CONTRAST_KEY) === 'high' ? 'high' : 'normal';
  } catch {
    return 'normal';
  }
}

export function setContrast(value) {
  const high = value === 'high';
  if (high) document.documentElement.dataset.contrast = 'high';
  else delete document.documentElement.dataset.contrast;
  try {
    localStorage.setItem(CONTRAST_KEY, high ? 'high' : 'normal');
  } catch {
    // Storage unavailable — the in-page attribute above still applies.
  }
}

// ---- Text size -------------------------------------------------------------

export function getTextScale() {
  try {
    const n = parseFloat(localStorage.getItem(SCALE_KEY));
    return TEXT_SCALES.includes(n) ? n : 1;
  } catch {
    return 1;
  }
}

export function setTextScale(value) {
  // Clamped to the offered steps in BOTH places that apply it — a hand-edited
  // storage value must not be able to break every layout in the app.
  //
  // Scope note: this sets --fs-scale on THIS document. The server-mode
  // Dashboard tab is an iframe with its own document and its own stylesheet,
  // so it keeps its own type size; display zoom (main process, per window)
  // does reach it.
  const scale = TEXT_SCALES.includes(Number(value)) ? Number(value) : 1;
  if (scale === 1) document.documentElement.style.removeProperty('--fs-scale');
  else document.documentElement.style.setProperty('--fs-scale', String(scale));
  try {
    localStorage.setItem(SCALE_KEY, String(scale));
  } catch {
    // As above.
  }
}
