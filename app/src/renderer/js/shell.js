// Shell chrome the operator controls: sidebar width, rail width, card density.
//
// All three are preferences, not state — they persist in localStorage and are
// applied to <html> (sidebar, rail) or the list (density). The sidebar and rail
// values are ALSO read pre-paint by shellBoot.js; this module owns the runtime
// side and must keep the same keys and clamps.

const SIDEBAR_KEY = 'meetingmaster.sidebar.v1';
const RAIL_KEY = 'meetingmaster.railw.v1';
const DENSITY_KEY = 'meetingmaster.density.v1';

const RAIL_MIN = 240;
const RAIL_MAX = 460;
const RAIL_DEFAULT = 300;
const RAIL_STEP = 16;

function read(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Quota/unavailable storage should never break the app.
  }
}

// ---- Sidebar ---------------------------------------------------------------

function sidebarCollapsed() {
  return document.documentElement.dataset.sidebar === 'collapsed';
}

function applySidebar(collapsed, toggle) {
  if (collapsed) document.documentElement.dataset.sidebar = 'collapsed';
  else delete document.documentElement.dataset.sidebar;
  write(SIDEBAR_KEY, collapsed ? 'collapsed' : 'expanded');
  if (!toggle) return;
  // The button's own label has to say what it DOES, not what it is.
  const label = collapsed ? 'Expand the sidebar' : 'Collapse the sidebar';
  toggle.setAttribute('aria-expanded', String(!collapsed));
  toggle.setAttribute('aria-label', label);
  toggle.title = label;
}

function initSidebar() {
  const toggle = document.getElementById('sidebar-toggle');
  if (!toggle) return;
  applySidebar(sidebarCollapsed(), toggle); // sync the label with shellBoot's work
  toggle.addEventListener('click', () => applySidebar(!sidebarCollapsed(), toggle));
}

// ---- Rail width ------------------------------------------------------------

function railWidth() {
  const raw = parseInt(
    getComputedStyle(document.documentElement).getPropertyValue('--rail-w'),
    10
  );
  return isNaN(raw) ? RAIL_DEFAULT : raw;
}

function setRailWidth(px, handle, { persist = true } = {}) {
  const width = Math.min(RAIL_MAX, Math.max(RAIL_MIN, Math.round(px)));
  document.documentElement.style.setProperty('--rail-w', `${width}px`);
  if (handle) handle.setAttribute('aria-valuenow', String(width));
  if (persist) write(RAIL_KEY, String(width));
  return width;
}

function initRailResizer() {
  const handle = document.getElementById('rail-resizer');
  if (!handle) return;
  setRailWidth(railWidth(), handle, { persist: false });

  let startX = 0;
  let startWidth = 0;

  handle.addEventListener('pointerdown', (e) => {
    startX = e.clientX;
    startWidth = railWidth();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('is-dragging');
    e.preventDefault(); // don't start a text selection across the page
  });

  handle.addEventListener('pointermove', (e) => {
    if (!handle.hasPointerCapture(e.pointerId)) return;
    // The rail is to the RIGHT of the handle, so dragging left widens it.
    setRailWidth(startWidth + (startX - e.clientX), handle, { persist: false });
  });

  const end = (e) => {
    if (!handle.hasPointerCapture(e.pointerId)) return;
    handle.releasePointerCapture(e.pointerId);
    handle.classList.remove('is-dragging');
    write(RAIL_KEY, String(railWidth())); // persist once, at rest
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);

  handle.addEventListener('keydown', (e) => {
    const width = railWidth();
    if (e.key === 'ArrowLeft') setRailWidth(width + RAIL_STEP, handle);
    else if (e.key === 'ArrowRight') setRailWidth(width - RAIL_STEP, handle);
    else if (e.key === 'Home') setRailWidth(RAIL_MAX, handle);
    else if (e.key === 'End') setRailWidth(RAIL_MIN, handle);
    else return;
    e.preventDefault();
  });
}

// ---- Card density ----------------------------------------------------------

function initDensity() {
  const toggle = document.getElementById('density-toggle');
  const list = document.getElementById('card-list');
  if (!toggle || !list) return;

  const apply = (compact, persist) => {
    list.dataset.density = compact ? 'compact' : 'comfortable';
    toggle.setAttribute('aria-pressed', String(compact));
    toggle.title = compact ? 'Show the full answers again' : 'Show more cards at once';
    if (persist) write(DENSITY_KEY, compact ? 'compact' : 'comfortable');
  };

  apply(read(DENSITY_KEY) === 'compact', false);
  toggle.addEventListener('click', () =>
    apply(list.dataset.density !== 'compact', true)
  );
}

export function initShell() {
  initSidebar();
  initRailResizer();
  initDensity();
}
