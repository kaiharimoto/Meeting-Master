// Pre-flight readiness strip in the Record audio panel.
//
// One glance before the meeting starts: microphone, disk space, home server,
// live model — failures caught while they're still fixable, instead of by an
// upload error after the meeting. Mic state is computed renderer-side
// (enumerateDevices); the rest comes from the PREFLIGHT_GET IPC probe.
//
// The strip is a polite live region, so a chip that flips while you're
// elsewhere on the screen announces itself. Each chip's STATE is carried in
// text, not only in its glyph and colour — "✓" and green are invisible to a
// screen reader and to anyone who can't separate the greens from the reds.

let ctx = null;
let host = null;
// The last rendered strip, as a string. Re-rendering identical chips would
// re-announce them on every screen entry; nothing changed, so nothing is said.
let lastSignature = null;

const LOW_DISK_BYTES = 500 * 1024 * 1024;

// Spoken before the chip's label. "Optional" is the missing live model: a
// choice not yet made, not a fault.
const STATE_WORD = { ok: 'Ready', soft: 'Optional', warn: 'Problem' };
const STATE_GLYPH = { ok: '✓', soft: '○', warn: '!' };

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

  const signature = chips.map((c) => `${state(c)}:${c.label}:${c.title || ''}`).join('|');
  if (signature === lastSignature) return;
  lastSignature = signature;

  host.replaceChildren(...chips.map(buildChip));
  host.hidden = chips.length === 0;
}

function state(chip) {
  return chip.ok ? 'ok' : chip.soft ? 'soft' : 'warn';
}

function buildChip(chip) {
  const key = state(chip);
  const el = document.createElement('span');
  el.className = `pf-chip is-${key === 'ok' ? 'ok' : key === 'soft' ? 'soft' : 'warn'}`;

  const glyph = document.createElement('span');
  glyph.className = 'pf-glyph';
  glyph.setAttribute('aria-hidden', 'true'); // decorative: the word carries it
  glyph.textContent = STATE_GLYPH[key];

  const spoken = document.createElement('span');
  spoken.className = 'sr-only';
  spoken.textContent = `${STATE_WORD[key]} — `;

  el.append(glyph, spoken, chip.label);
  if (chip.title) el.title = chip.title;
  return el;
}
