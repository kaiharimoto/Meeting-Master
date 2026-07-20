// First-run mode chooser (mode.html). Picking a mode persists APP_MODE and
// the main process relaunches the app into it — this page only needs to give
// instant feedback and prevent double-clicks.

const api = window.api;

function choose(mode, label) {
  const status = document.getElementById('mode-status');
  for (const btn of document.querySelectorAll('.mode-card')) {
    btn.disabled = true;
    btn.classList.toggle('selected', btn.dataset.mode === mode);
  }
  status.textContent = `Restarting in ${label} mode…`;

  if (!api || typeof api.setMode !== 'function') return; // page opened outside Electron
  api.setMode(mode).catch((err) => {
    status.textContent = err.message || String(err);
    for (const btn of document.querySelectorAll('.mode-card')) btn.disabled = false;
  });
}

const operatorBtn = document.getElementById('choose-operator');
const serverBtn = document.getElementById('choose-server');
operatorBtn.dataset.mode = 'operator';
serverBtn.dataset.mode = 'server';
operatorBtn.addEventListener('click', () => choose('operator', 'operator'));
serverBtn.addEventListener('click', () => choose('server', 'home server'));
