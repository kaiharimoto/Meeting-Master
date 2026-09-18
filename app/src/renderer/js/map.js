// The meeting map window.
//
// A pure subscriber, like mini.js: the map itself lives in the main process
// (liveMap.js), and this page only ever draws what it is handed. It has no
// ctx, no meeting state and no localStorage of its own beyond one remembered
// preference — there is nothing here worth persisting that the main process
// does not already own.
//
// Two channels, and both are needed: MAP_STATE pushes every change, and
// getMap() pulls once on load. The window is opened MID-MEETING, after ticks
// have already landed, so without the pull it would sit blank for up to ninety
// seconds looking broken.

import { layout } from './mapLayout.js';
import { draw, toStandaloneSvg } from './mapDraw.js';

const api = window.api || {};

const els = {
  scroll: document.getElementById('map-scroll'),
  svg: document.getElementById('map-svg'),
  empty: document.getElementById('map-empty'),
  status: document.getElementById('map-status'),
  rev: document.getElementById('map-rev'),
  jump: document.getElementById('map-jump'),
  pin: document.getElementById('map-pin'),
  save: document.getElementById('map-save'),
  saveMenu: document.getElementById('map-save-menu'),
  close: document.getElementById('map-close'),
};

let current = { map: { topics: [], links: [], rev: 0 }, status: null, live: false };
// Stick to the bottom — where the newest topic is — unless the operator has
// scrolled up to read something. Then leave them where they are and offer a way
// back, rather than yanking the view every ninety seconds.
let pinnedToBottom = true;
// The map.css text, fetched once, for the standalone export.
let mapCssText = '';

const PIN_KEY = 'meetingmaster.map.pinned.v1';

function atBottom() {
  const gap = els.scroll.scrollHeight - els.scroll.scrollTop - els.scroll.clientHeight;
  return gap < 40;
}

function render() {
  const map = current.map || { topics: [], links: [] };
  const has = (map.topics || []).length > 0;
  els.empty.hidden = has;
  // setAttribute, not `.hidden`: `hidden` is an HTMLElement property and an
  // <svg> is an SVGElement, so assigning it there sets a JS expando and leaves
  // the attribute — and the hidden map — exactly as it was.
  if (has) els.svg.removeAttribute('hidden');
  else els.svg.setAttribute('hidden', '');

  if (has) {
    // clientWidth, not window.innerWidth: the scrollbar is real estate the
    // layout does not have.
    draw(els.svg, layout(map, els.scroll.clientWidth - 2));
  }
  if (els.rev) els.rev.textContent = has ? `${map.topics.length} topics` : '';

  renderStatus();

  if (pinnedToBottom) {
    els.scroll.scrollTop = els.scroll.scrollHeight;
    els.jump.hidden = true;
  } else {
    els.jump.hidden = atBottom();
  }
}

function renderStatus() {
  const status = current.status;
  if (!status || !status.message) {
    els.status.hidden = true;
    return;
  }
  // Quiet by default: this sits beside a live meeting. Only the states that
  // mean "this is not working" get announced.
  const loud = status.state === 'error' || status.state === 'off';
  els.status.hidden = false;
  els.status.textContent = status.message;
  els.status.dataset.state = status.state || '';
  els.status.setAttribute('aria-live', loud ? 'polite' : 'off');
}

function applyState(payload) {
  if (!payload) return;
  current = payload;
  render();
}

// ---- Export -----------------------------------------------------------------

function suggestedName(ext) {
  const now = new Date();
  const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate()
  ).padStart(2, '0')}`;
  return `meeting-map-${stamp}.${ext}`;
}

/** The whole map, not the visible part — the reason this rebuilds the SVG at
 *  full height rather than capturing the window. */
function exportSvgText() {
  const full = layout(current.map, Math.max(els.scroll.clientWidth - 2, 560));
  const staging = els.svg.cloneNode(false);
  draw(staging, full);
  return { text: toStandaloneSvg(staging, mapCssText), laid: full };
}

async function saveSvg() {
  const { text } = exportSvgText();
  const picked = await api.pickSavePath(suggestedName('svg'));
  if (!picked || !picked.filePath) return;
  await api.saveTextFile(picked.filePath, text);
}

async function savePng() {
  const { text, laid } = exportSvgText();
  // 2x so the file is usable in a slide deck rather than only on screen.
  const scale = 2;
  const canvas = document.createElement('canvas');
  canvas.width = laid.width * scale;
  canvas.height = laid.height * scale;

  const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`;
  const image = new Image();
  await new Promise((resolve, reject) => {
    image.onload = resolve;
    image.onerror = () => reject(new Error('The map could not be rendered to an image.'));
    image.src = dataUrl;
  });
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  ctx.drawImage(image, 0, 0);

  const base64 = canvas.toDataURL('image/png').split(',')[1];
  const picked = await api.pickSavePath(suggestedName('png'));
  if (!picked || !picked.filePath) return;
  await api.saveBinaryFile(picked.filePath, base64);
}

function closeMenu() {
  els.saveMenu.hidden = true;
  els.save.setAttribute('aria-expanded', 'false');
}

// ---- Wiring -----------------------------------------------------------------

function initPin() {
  let pinned = true;
  try {
    pinned = localStorage.getItem(PIN_KEY) !== '0';
  } catch {
    // Private window / blocked storage: the default (pinned) is the useful one.
  }
  setPin(pinned, { persist: false });
  els.pin.addEventListener('click', () => {
    setPin(els.pin.getAttribute('aria-pressed') !== 'true');
  });
}

function setPin(pinned, { persist = true } = {}) {
  els.pin.setAttribute('aria-pressed', pinned ? 'true' : 'false');
  els.pin.classList.toggle('is-on', pinned);
  els.pin.title = pinned
    ? 'Keep this window above other windows (on)'
    : 'Keep this window above other windows (off)';
  if (api.mapPin) api.mapPin(pinned);
  if (!persist) return;
  try {
    localStorage.setItem(PIN_KEY, pinned ? '1' : '0');
  } catch {
    // Not worth failing a click over.
  }
}

function init() {
  if (!els.svg || !els.scroll) return;

  els.scroll.addEventListener('scroll', () => {
    pinnedToBottom = atBottom();
    els.jump.hidden = pinnedToBottom;
  });
  els.jump.addEventListener('click', () => {
    pinnedToBottom = true;
    els.scroll.scrollTop = els.scroll.scrollHeight;
    els.jump.hidden = true;
  });

  // A narrower window means narrower bands and different wrapping, so the
  // layout is recomputed rather than scaled.
  window.addEventListener('resize', render);

  initPin();

  els.save.addEventListener('click', () => {
    const open = els.saveMenu.hidden;
    els.saveMenu.hidden = !open;
    els.save.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  els.saveMenu.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-format]');
    if (!button) return;
    closeMenu();
    try {
      if (button.dataset.format === 'png') await savePng();
      else await saveSvg();
    } catch (err) {
      current = {
        ...current,
        status: { state: 'error', message: `Could not save the map: ${err.message}` },
      };
      renderStatus();
    }
  });
  document.addEventListener('click', (event) => {
    if (!els.saveMenu.hidden && !event.target.closest('.map-bar-actions, .map-menu')) {
      closeMenu();
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !els.saveMenu.hidden) closeMenu();
  });

  els.close.addEventListener('click', () => {
    if (api.mapClose) api.mapClose();
  });

  if (api.onMapState) api.onMapState(applyState);

  // The pull. Without it a window opened mid-meeting shows nothing until the
  // next tick lands.
  if (api.getMap) {
    api
      .getMap()
      .then(applyState)
      .catch(() => {
        /* the push will fill it in soon enough */
      });
  }

  // The export needs map.css as text; fetching it once beats maintaining a
  // second copy of the same rules inside a template literal.
  fetch('styles/map.css')
    .then((res) => res.text())
    .then((text) => {
      mapCssText = text;
    })
    .catch(() => {
      mapCssText = '';
    });

  render();
}

init();
