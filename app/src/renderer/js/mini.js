// Mini-mode strip renderer: a remote control for the recording running in
// the MAIN window (see miniManager.js for the relay topology).

const api = window.api || {};

const els = {
  dot: document.getElementById('dot'),
  timer: document.getElementById('timer'),
  title: document.getElementById('title'),
  meterFill: document.getElementById('meter-fill'),
  q: document.getElementById('q-btn'),
  pause: document.getElementById('pause-btn'),
  stop: document.getElementById('stop-btn'),
  expand: document.getElementById('expand-btn'),
};

let paused = false;

function cmd(name) {
  if (typeof api.miniCmd === 'function') api.miniCmd(name).catch(() => {});
}

els.q.addEventListener('click', () => cmd('q'));
els.stop.addEventListener('click', () => cmd('stop'));
els.expand.addEventListener('click', () => cmd('expand'));
els.pause.addEventListener('click', () => cmd(paused ? 'resume' : 'pause'));

function fmtDuration(ms) {
  const totalSec = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = String(Math.floor((totalSec % 3600) / 60)).padStart(2, '0');
  const s = String(totalSec % 60).padStart(2, '0');
  return h > 0 ? `${h}:${m}:${s}` : `${m}:${s}`;
}

if (typeof api.onMiniState === 'function') {
  api.onMiniState((state) => {
    if (!state) return;
    paused = state.status === 'paused';
    els.dot.classList.toggle('is-paused', paused);
    els.pause.textContent = paused ? 'Resume' : 'Pause';
    els.timer.textContent = fmtDuration(state.elapsedMs);
    els.title.textContent = state.title || '';
    const pct = Math.min(100, Math.round((Number(state.rms) || 0) * 300));
    els.meterFill.style.width = `${paused ? 0 : pct}%`;
  });
}
