// Server-mode boot page (serverBoot.html). Shows the sidecar's lifecycle
// while it starts; the MAIN process swaps this page for the dashboard once
// the server is healthy (and swaps back if it dies). This page only renders
// state and offers Retry / log / mode-switch actions.

const api = window.api;

const title = document.getElementById('boot-title');
const message = document.getElementById('boot-message');
const spinner = document.getElementById('boot-spinner');
const retryBtn = document.getElementById('boot-retry');
const logBtn = document.getElementById('boot-log');
const switchBtn = document.getElementById('boot-switch');

function render(state) {
  const s = (state && state.state) || 'starting';
  const busy = s === 'starting' || s === 'running' || s === 'external';
  spinner.hidden = !busy;
  retryBtn.hidden = busy;
  logBtn.hidden = busy;
  switchBtn.hidden = busy;

  if (s === 'running' || s === 'external') {
    title.textContent = 'Server is running';
    message.textContent = 'Opening the dashboard…';
  } else if (s === 'starting') {
    title.textContent = 'Starting the home server…';
    message.textContent =
      (state && state.message) || 'The AI server is warming up — the dashboard opens automatically.';
  } else if (s === 'conflict') {
    title.textContent = 'Another server is already running';
    message.textContent = (state && state.message) || '';
  } else {
    title.textContent = 'The home server could not start';
    message.textContent = (state && state.message) || 'Unknown error.';
  }
}

if (api && typeof api.getSidecarState === 'function') {
  api.getSidecarState().then(render).catch(() => {});
}
if (api && typeof api.onSidecarState === 'function') {
  api.onSidecarState(render);
}

retryBtn.addEventListener('click', () => {
  if (!api || typeof api.retrySidecar !== 'function') return;
  render({ state: 'starting' });
  api.retrySidecar().then(render).catch((err) => {
    render({ state: 'failed', message: err.message || String(err) });
  });
});

logBtn.addEventListener('click', () => {
  if (api && typeof api.openServerLog === 'function') {
    api.openServerLog().catch(() => {});
  }
});

switchBtn.addEventListener('click', () => {
  if (!api || typeof api.setMode !== 'function') return;
  const sure = window.confirm(
    'Switch this machine to operator mode? The home server will stop; the app restarts into the meeting-capture UI.'
  );
  if (sure) {
    api.setMode('operator').catch(() => {});
  }
});
