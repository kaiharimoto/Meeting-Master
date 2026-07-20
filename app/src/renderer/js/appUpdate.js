// Renderer side of laptop auto-updates: shows a "Restart to update" toast
// when a new version has been downloaded, and turns the sidebar version label
// into an update indicator. All api calls are guarded — e2e stubs and older
// preloads simply leave this feature dormant.

import { showToast } from './toast.js';

let ctx = null;
let toastShownFor = null;

function renderFooter(state) {
  const el = document.getElementById('app-version');
  if (!el || !el.dataset.baseVersion) return;
  const base = el.dataset.baseVersion;
  if (state && state.downloaded) {
    el.textContent = `v${base} → v${state.downloaded} ready`;
    el.classList.add('update-ready');
    el.title = 'An update has been downloaded — restart the app to apply it.';
  } else {
    el.textContent = `v${base}`;
    el.classList.remove('update-ready');
    el.title = '';
  }
}

function onState(state) {
  renderFooter(state);
  if (state && state.downloaded && toastShownFor !== state.downloaded) {
    toastShownFor = state.downloaded;
    showToast({
      kind: 'success',
      title: `Update ready — v${state.downloaded}`,
      message: 'Downloaded from your home server. It also installs automatically the next time you quit.',
      timeoutMs: 0, // stays until acted on/dismissed
      action: {
        label: 'Restart to update',
        onClick: () => {
          if (ctx.api && typeof ctx.api.installUpdate === 'function') {
            ctx.api.installUpdate().catch(() => {});
          }
        },
      },
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
