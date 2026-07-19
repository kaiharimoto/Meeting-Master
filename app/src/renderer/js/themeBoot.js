'use strict';

// Pre-paint theme resolver — loaded as a plain <head> script (CSP 'self') so
// the correct theme lands on <html> BEFORE first paint (no light-flash when the
// user prefers dark). The module-side API lives in theme.js; both share the
// same storage key and the data-theme attribute contract:
//   localStorage 'meetingmaster.theme.v1' = 'light' | 'dark' | 'system'
//   <html data-theme="light|dark">  (resolved value, never 'system')
(function () {
  var KEY = 'meetingmaster.theme.v1';

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

  // Follow live OS changes while in 'system' mode.
  if (media && typeof media.addEventListener === 'function') {
    media.addEventListener('change', function () {
      if (stored() === 'system') apply();
    });
  }
})();
