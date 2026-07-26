// Pre-flight readiness strip in the Record audio panel.
//
// One glance before the meeting starts: microphone, disk space, home server,
// live model — failures caught while they're still fixable, instead of by an
// upload error after the meeting. Mic state is computed renderer-side
// (enumerateDevices); the rest comes from the PREFLIGHT_GET IPC probe.

let ctx = null;
let host = null;

const LOW_DISK_BYTES = 500 * 1024 * 1024;

export function initPreflight(context) {
  ctx = context;
  host = document.getElementById('rec-preflight');
  if (!host) return;

  // Re-check when the Meeting screen comes back into view — a fixed mic or a
  // rebooted server should clear its warning without an app restart.
  // nav.js dispatches `detail: {screen}` — comparing the detail object to a
  // string meant this never fired, so the chips only ever rendered once.
  document.addEventListener('mm:screen', (e) => {
    if (e.detail && e.detail.screen === 'meeting') refreshPreflight();
  });
  refreshPreflight();
}

export async function refreshPreflight() {
  if (!host || !ctx || !ctx.api) return;

  const chips = [];

  // Microphone: present + permission granted (granted → labels are visible).
  let micOk = false;
  let micLabel = 'No microphone';
  if (
    typeof navigator !== 'undefined' &&
    navigator.mediaDevices &&
    typeof navigator.mediaDevices.enumerateDevices === 'function'
  ) {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const mics = devices.filter((d) => d.kind === 'audioinput');
      micOk = mics.length > 0;
      micLabel = micOk ? 'Microphone' : 'No microphone found';
    } catch {
      micLabel = 'Microphone check failed';
    }
  }
  chips.push({ ok: micOk, label: micLabel });

  if (typeof ctx.api.getPreflight === 'function') {
    try {
      const p = await ctx.api.getPreflight();
      if (typeof p.freeBytes === 'number') {
        const low = p.freeBytes < LOW_DISK_BYTES;
        chips.push({
          ok: !low,
          label: low ? 'Disk almost full' : 'Disk space',
          title: `${Math.round(p.freeBytes / (1024 * 1024 * 1024))} GB free`,
        });
      }
      chips.push({
        ok: Boolean(p.server && p.server.ok),
        label: p.server && p.server.ok ? 'Home server' : 'Home server unreachable',
        title: (p.server && p.server.error) || '',
      });
      if (p.live && p.live.supported) {
        chips.push({
          ok: Boolean(p.live.modelReady),
          soft: !p.live.modelReady, // missing model is a choice, not a fault
          label: p.live.modelReady ? 'Live model' : 'Live model not downloaded',
        });
      }
    } catch {
      // Probe unavailable (old preload / e2e stubs) — show what we have.
    }
  }

  host.replaceChildren(
    ...chips.map((chip) => {
      const el = document.createElement('span');
      el.className = `pf-chip ${chip.ok ? 'is-ok' : chip.soft ? 'is-soft' : 'is-warn'}`;
      el.textContent = `${chip.ok ? '✓' : chip.soft ? '○' : '!'} ${chip.label}`;
      if (chip.title) el.title = chip.title;
      return el;
    })
  );
  host.hidden = chips.length === 0;
}
