'use strict';

// Pre-paint appearance resolver — a plain <head> script (CSP 'self') so the
// right theme lands on <html> BEFORE first paint (no light-flash when the user
// prefers dark). The module-side API lives in theme.js; both share these keys
// and attribute contracts:
//   'meetingmaster.theme.v1'    = 'light' | 'dark' | 'system'
//     -> <html data-theme="light|dark">     (resolved, never 'system')
//   'meetingmaster.contrast.v1' = 'normal' | 'high'
//     -> <html data-contrast="high">        (absent means normal)
//   'meetingmaster.textscale.v1' = 0.9 | 1 | 1.12 | 1.25
//     -> <html style="--fs-scale: N">       (absent means 1)
//
// Contrast is ORTHOGONAL to theme: it overrides border/ink/accent tokens on top
// of whichever theme is active, rather than being a third theme nobody
// maintains. Text scale is renderer-only and type-only — deliberately NOT the
// same thing as zoom.js's whole-window display zoom (see settings.js).
(function () {
  var KEY = 'meetingmaster.theme.v1';
  var CONTRAST_KEY = 'meetingmaster.contrast.v1';
  var SCALE_KEY = 'meetingmaster.textscale.v1';
  var SCALES = [0.9, 1, 1.12, 1.25];

  function stored() {
    try {
      var v = localStorage.getItem(KEY);
      return v === 'light' || v === 'dark' || v === 'system' ? v : 'system';
    } catch (e) {
      return 'system';
    }
  }

  var media = null;
  try {
    media = window.matchMedia('(prefers-color-scheme: dark)');
  } catch (e) {
    // matchMedia always exists in Chromium; belt and braces.
  }

  function resolve(pref) {
    if (pref === 'light' || pref === 'dark') return pref;
    return media && media.matches ? 'dark' : 'light';
  }

  function apply() {
    document.documentElement.dataset.theme = resolve(stored());
  }

  apply();

  // ---- Contrast + text size (no OS signal to follow; set once, pre-paint) ---
  try {
    if (localStorage.getItem(CONTRAST_KEY) === 'high') {
      document.documentElement.dataset.contrast = 'high';
    }
    var scale = parseFloat(localStorage.getItem(SCALE_KEY));
    // Clamp to the offered steps: a hand-edited 4 would break every layout.
    if (SCALES.indexOf(scale) !== -1 && scale !== 1) {
      document.documentElement.style.setProperty('--fs-scale', String(scale));
    }
  } catch (e) {
    // Unavailable storage: defaults are already correct.
  }

  // Follow live OS changes while in 'system' mode.
  if (media && typeof media.addEventListener === 'function') {
    media.addEventListener('change', function () {
      if (stored() === 'system') apply();
    });
  }
})();
