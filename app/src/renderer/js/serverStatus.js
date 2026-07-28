// Sidebar server-status pill: a live reachability indicator fed by the main
// process (SSE connection state + /health probes), with a click-to-open
// popover showing the details. Degrades to a quiet "unknown" pill when the
// preload doesn't expose the newer channels (e2e stubs, older builds).

let ctx = null;
let status = null;
let popoverEl = null;

const LABELS = {
  ok: 'Server online',
  unreachable: 'Server unreachable',
  unconfigured: 'Not connected',
  unknown: 'Server status',
};

function pillState(s) {
  if (!s) return { key: 'unknown', label: LABELS.unknown };
  if (s.reachability === 'ok') return { key: 'ok', label: LABELS.ok };
  if (s.reachability === 'unreachable') return { key: 'down', label: LABELS.unreachable };
  if (s.reachability === 'unconfigured') return { key: 'warn', label: LABELS.unconfigured };
  return { key: 'unknown', label: LABELS.unknown };
}

function render() {
  const pill = document.getElementById('server-pill');
  const label = document.getElementById('server-pill-label');
  if (!pill || !label) return;
  const { key, label: text } = pillState(status);
  pill.dataset.status = key;
  label.textContent = text;
  // The markup's aria-label was the static string "Home server status", so the
  // button announced the same thing whether the server was up or down — while
  // the coloured dot beside it carried the whole message.
  pill.setAttribute('aria-label', `Home server: ${text}. Show details.`);
  if (popoverEl) renderPopover(); // keep an open popover live
}

function ago(ts) {
  if (!ts) return '—';
  const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (sec < 5) return 'just now';
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  return min < 60 ? `${min}m ago` : `${Math.round(min / 60)}h ago`;
}

function popRow(key, value) {
  const row = document.createElement('div');
  row.className = 'pop-row';
  const k = document.createElement('span');
  k.className = 'pop-key';
  k.textContent = key;
  const v = document.createElement('span');
  v.className = 'pop-val';
  v.textContent = value;
  v.title = value;
  row.append(k, v);
  return row;
}

function renderPopover() {
  popoverEl.replaceChildren();
  const s = status || {};
  popoverEl.append(
    popRow('Status', pillState(s).label),
    popRow('Server', s.serverUrl || 'not configured'),
    popRow('Live events', s.sse === 'connected' ? 'connected' : s.sse === 'connecting' ? 'reconnecting…' : 'off'),
    popRow('Last event', ago(s.lastEventAt)),
    popRow('Server version', s.serverVersion || '—')
  );
  const openSettings = document.createElement('button');
  openSettings.type = 'button';
  openSettings.className = 'btn btn-secondary btn-small';
  openSettings.style.marginTop = '6px';
  openSettings.textContent = 'Open Settings';
  openSettings.addEventListener('click', () => {
    closePopover();
    const btn = document.getElementById('settings-btn');
    if (btn) btn.click();
  });
  popoverEl.append(openSettings);
}

function openPopover() {
  if (popoverEl) return closePopover();
  const pill = document.getElementById('server-pill');
  popoverEl = document.createElement('div');
  popoverEl.className = 'server-popover';
  renderPopover();
  document.body.append(popoverEl);

  // Anchor above the pill.
  const rect = pill.getBoundingClientRect();
  const height = popoverEl.offsetHeight;
  popoverEl.style.left = `${Math.max(8, rect.left)}px`;
  popoverEl.style.top = `${Math.max(8, rect.top - height - 8)}px`;

  setTimeout(() => {
    document.addEventListener('mousedown', onOutside);
    document.addEventListener('keydown', onEscape);
  }, 0);
}

function onOutside(e) {
  // Clicks on the pill itself are the toggle path — let the pill's click
  // handler close the popover, or mousedown-close + click-reopen would make
  // the pill unable to dismiss its own popover.
  const pill = document.getElementById('server-pill');
  if (pill && pill.contains(e.target)) return;
  if (popoverEl && !popoverEl.contains(e.target)) closePopover();
}

function onEscape(e) {
  if (e.key === 'Escape') closePopover();
}

function closePopover() {
  if (!popoverEl) return;
  popoverEl.remove();
  popoverEl = null;
  document.removeEventListener('mousedown', onOutside);
  document.removeEventListener('keydown', onEscape);
}

export function initServerStatus(context) {
  ctx = context;
  const pill = document.getElementById('server-pill');
  if (!pill) return;
  pill.addEventListener('click', openPopover);

  const api = ctx.api;
  if (!api) return;

  // Live updates pushed from main; guarded — e2e stubs may omit the channel.
  if (typeof api.onServerEvent === 'function') {
    api.onServerEvent((payload) => {
      if (payload && payload.type === 'status') {
        status = payload.status;
        render();
      } else if (payload && payload.type === 'sse') {
        // Any live event proves reachability.
        if (status) {
          status.lastEventAt = Date.now();
          if (status.reachability !== 'ok') {
            status.reachability = 'ok';
          }
        }
        render();
      }
    });
  }
  if (typeof api.getServerStatus === 'function') {
    api.getServerStatus().then((s) => {
      status = s;
      render();
    }).catch(() => {});
  }
  render();
}
