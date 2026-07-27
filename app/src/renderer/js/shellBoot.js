'use strict';

// Pre-paint shell resolver — a plain <head> script (CSP 'self'), like
// themeBoot.js. Sidebar width and rail width are LAYOUT: applying them from a
// module after DOMContentLoaded would paint the wide shell first and then snap,
// which is worse than not remembering at all. Both land on <html> before the
// first paint.
//
//   localStorage 'meetingmaster.sidebar.v1' = 'expanded' | 'collapsed'
//     -> <html data-sidebar="collapsed">        (absent means expanded)
//   localStorage 'meetingmaster.railw.v1'   = px number, clamped 240..460
//     -> <html style="--rail-w: 300px">
//
// The module-side API lives in shell.js; both share these keys and contracts.
(function () {
  var SIDEBAR_KEY = 'meetingmaster.sidebar.v1';
  var RAIL_KEY = 'meetingmaster.railw.v1';
  var RAIL_MIN = 240;
  var RAIL_MAX = 460;

  function read(key) {
    try {
      return localStorage.getItem(key);
    } catch (e) {
      return null;
    }
  }

  if (read(SIDEBAR_KEY) === 'collapsed') {
    document.documentElement.dataset.sidebar = 'collapsed';
  }

  var width = parseInt(read(RAIL_KEY), 10);
  if (!isNaN(width)) {
    width = Math.min(RAIL_MAX, Math.max(RAIL_MIN, width));
    document.documentElement.style.setProperty('--rail-w', width + 'px');
  }
})();
