// Renderer side of app updates: a persistent, clickable "update ready"
// badge in the sidebar footer plus a toast when one first arrives. All api
// calls are guarded — e2e stubs and older preloads leave this dormant.
//
// The badge matters: a toast can be missed or dismissed, and before v0.10.2
// it was the ONLY way to install from inside the app, so an operator who
// dismissed it had no way back (the footer label looked like a status but
// did nothing). It works in both modes — the server-mode window renders the
// same sidebar.
//
// installUpdate() RESOLVES with {ok:false, error} when the install can't
// proceed (a job still running, a foreign server instance holding files).
// Those must be shown: swallowing them is what made the button look dead.

import { showToast } from './toast.js';

let ctx = null;
let toastShownFor = null;
let installing = false;

async function triggerInstall() {
  if (installing) return;
  if (!ctx.api || typeof ctx.api.installUpdate !== 'function') return;
  installing = true;
  try {
    const result = await ctx.api.installUpdate();
    // On success the app quits and relaunches, so anything after this only
    // runs when the install was refused.
    if (result && result.ok === false) {
      showToast({
        kind: 'error',
        title: 'Could not install the update yet',
        message: result.error || 'The update could not be installed right now.',
      });
    }
  } catch (err) {
    showToast({
      kind: 'error',
      title: 'Could not install the update',
      message: err && err.message ? err.message : String(err),
    });
  } finally {
    installing = false;
  }
}

function renderFooter(state) {
  const el = document.getElementById('app-version');
  if (!el || !el.dataset.baseVersion) return;
  const base = el.dataset.baseVersion;
  const ready = Boolean(state && state.downloaded);

  el.textContent = ready ? `v${base} → v${state.downloaded} — restart` : `v${base}`;
  el.classList.toggle('update-ready', ready);
  el.title = ready
    ? `Version ${state.downloaded} is downloaded — click to restart and install it.`
    : '';

  // Make the badge a real control while an update is pending, and an inert
  // label again once it isn't.
  if (ready) {
    el.setAttribute('role', 'button');
    el.setAttribute('tabindex', '0');
    if (!el.dataset.installWired) {
      el.dataset.installWired = '1';
      el.addEventListener('click', () => {
        if (el.classList.contains('update-ready')) triggerInstall();
      });
      el.addEventListener('keydown', (e) => {
        if ((e.key === 'Enter' || e.key === ' ') && el.classList.contains('update-ready')) {
          e.preventDefault();
          triggerInstall();
        }
      });
    }
  } else {
    el.removeAttribute('role');
    el.removeAttribute('tabindex');
  }
}

function onState(state) {
  renderFooter(state);
  if (state && state.downloaded && toastShownFor !== state.downloaded) {
    toastShownFor = state.downloaded;
    showToast({
      kind: 'success',
      title: `Update ready — v${state.downloaded}`,
      message:
        'Downloaded from your home server. Restart now, click the version in the ' +
        'sidebar any time, or just quit the app — it installs on the way out.',
      timeoutMs: 0, // stays until acted on/dismissed
      action: { label: 'Restart to update', onClick: triggerInstall },
    });
  }
}

export function initAppUpdate(context) {
  ctx = context;
  const api = ctx.api;
  if (!api) return;

  if (typeof api.onAppUpdate === 'function') {
    api.onAppUpdate((payload) => {
      if (payload && payload.type === 'state') onState(payload.state);
    });
  }
  if (typeof api.getUpdateState === 'function') {
    api.getUpdateState().then(onState).catch(() => {});
  }
}
