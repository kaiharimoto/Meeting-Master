'use strict';

// Live mid-meeting transcription on the LAPTOP (main-process side).
//
// The renderer taps the recording bus with an AudioWorklet and streams 16 kHz
// mono Int16 PCM here (LIVE_PCM, ~0.5 s batches with an RMS level). This
// module cuts the stream into windows at natural pauses, writes each window
// as a temp WAV, and shells out to the bundled whisper-cli — exactly the
// server's transcription approach (pipeline/transcribe.py) scaled down to
// a small model and short windows. Text segments are pushed back over
// LIVE_EVENT.
//
// Design notes:
// - No-overlap sequential windows, cut on >=600 ms of silence after >=8 s
//   (a pause means no mid-word split), hard cut at 15 s to bound latency.
//   Continuity across windows comes from --prompt: attendee names first
//   (whisper name biasing), then the tail of the text so far.
// - Serialization: one whisper-cli at a time. Backlogged windows are merged
//   (amortizes process start); if the machine can't keep up, the oldest
//   audio is dropped with a single 'lag' notice — live text is advisory,
//   the post-meeting transcript is the quality path.
// - A GPU that CRASHES whisper-cli demotes the session to the CPU instead of
//   ending live transcription. Same story as the server's pipeline, same
//   cause: whisper.cpp v1.8.0 turned flash attention on by default and the
//   Vulkan path for it kills the process on an AMD RX 7900 XTX. See
//   server/app/pipeline/transcribe.py for the long version.
// - Everything is generation-guarded (serverManager.js idiom) so a stop
//   invalidates all in-flight async work.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const locator = require('./whisperLocator');
const { SILENCE_RMS, encodeWav, createWindowCutter } = require('./liveAudio');

const FLUSH_GAP_MS = 2000; // no PCM for this long (pause/stop) → finalize tail
const MERGE_CAP_MS = 30000; // max audio handed to one whisper-cli run
const BACKLOG_DROP_MS = 60000; // beyond this, drop oldest audio + warn once
const MAX_CONSECUTIVE_FAILURES = 3;
const WHISPER_TIMEOUT_MS = 120000;
const PROMPT_TAIL_CHARS = 400; // whisper's initial-prompt window is ~224 tokens

// Live windows are too short for reliable per-window language detection
// (-l auto), so pin English — the meetings this app targets are English and
// the post-meeting pipeline still honors the server's WHISPER_LANGUAGE.
const LANGUAGE = 'en';

// Windows reports an unhandled exception as its NTSTATUS code, always
// 0xC0000000 or above (0xC000001D is the illegal instruction the AMD Vulkan
// flash-attention path produced). A whisper-cli error exit is a small number,
// so the two ranges never overlap. POSIX has no equivalent — a crash arrives
// as a signal name instead.
const WINDOWS_EXCEPTION_MIN = 0xc0000000;

let emit = () => {};

/** ipc.js hands us its LIVE_EVENT push function. */
function setEmitter(fn) {
  emit = typeof fn === 'function' ? fn : () => {};
}

// ---- Session ---------------------------------------------------------------

let generation = 0;
let session = null;
// session = { gen, cliPath, modelPath, attendees, tmpDir, cutter, queue,
//             queuedMs, running, child, winCount, transcriptText,
//             consecutiveFailures, flushTimer, atMs }

function isActive() {
  return Boolean(session);
}

function start({ attendees = [], model = 'small' } = {}) {
  if (session) throw new Error('Live transcription is already running.');

  const cliPath = locator.cliPath();
  if (!cliPath) {
    throw new Error('Live transcription is unavailable — whisper-cli was not found.');
  }
  if (!locator.modelDownloaded(model)) {
    throw new Error(
      "The live transcription model isn't downloaded yet — " +
        'Settings → Live transcription → Download model.'
    );
  }

  const gen = ++generation;
  const tmpDir = fs.mkdtempSync(path.join(app.getPath('temp'), 'mm-live-'));
  session = {
    gen,
    cliPath,
    modelPath: locator.modelPath(model),
    attendees: attendees.filter((a) => typeof a === 'string' && a.trim()).slice(0, 50),
    tmpDir,
    cutter: createWindowCutter(),
    queue: [],
    queuedMs: 0,
    running: false,
    child: null,
    winCount: 0,
    transcriptText: '',
    consecutiveFailures: 0,
    flushTimer: null,
    atMs: 0,
    // Started here, awaited by the first window: reading --help takes tens of
    // milliseconds and the first window is seconds away, so nothing waits.
    flags: locator.supportedFlags(cliPath),
    gpuDisabled: false,
  };
  return { ok: true };
}

/** LIVE_PCM: one ~0.5 s batch of Int16 PCM plus its RMS level. */
function feed(pcmArrayBuffer, rms) {
  if (!session) return { ok: false }; // stopped meanwhile — drop silently
  const buf = Buffer.from(pcmArrayBuffer);
  if (buf.length === 0) return { ok: true };
  for (const win of session.cutter.feed(buf, rms)) enqueue(win);
  armFlushTimer();
  return { ok: true };
}

function armFlushTimer() {
  if (!session) return;
  if (session.flushTimer) clearTimeout(session.flushTimer);
  session.flushTimer = setTimeout(() => {
    if (!session) return;
    const win = session.cutter.flush();
    if (win) enqueue(win);
  }, FLUSH_GAP_MS);
}

function enqueue(win) {
  if (!session) return;
  // VAD-lite: an all-silence window costs GPU time and transcribes to
  // nothing (or hallucinated filler) — skip it entirely.
  if (win.peakRms < SILENCE_RMS) return;
  session.queue.push(win);
  session.queuedMs += win.ms;

  // Machine slower than realtime (e.g. iGPU fallback): drop the OLDEST
  // audio so the pane stays near-live, and say so once per event.
  let droppedMs = 0;
  while (session.queuedMs > BACKLOG_DROP_MS && session.queue.length > 1) {
    const dropped = session.queue.shift();
    session.queuedMs -= dropped.ms;
    droppedMs += dropped.ms;
  }
  if (droppedMs > 0) {
    emit({ type: 'lag', droppedMs: Math.round(droppedMs) });
  }
  pump();
}

function pump() {
  if (!session || session.running || session.queue.length === 0) return;
  session.running = true;

  // Merge queued windows (up to the cap) into one whisper run.
  const merged = [];
  let mergedMs = 0;
  while (session.queue.length > 0 && mergedMs < MERGE_CAP_MS) {
    const win = session.queue.shift();
    merged.push(win.buf);
    mergedMs += win.ms;
    session.queuedMs -= win.ms;
  }
  const atMs = session.atMs;
  session.atMs += mergedMs;

  transcribeWindow(Buffer.concat(merged), atMs)
    .catch(() => {})
    .finally(() => {
      if (!session) return;
      session.running = false;
      pump();
    });
}

async function transcribeWindow(pcm, atMs) {
  const s = session;
  if (!s) return;
  const gen = s.gen;
  const base = path.join(s.tmpDir, `win-${s.winCount++}`);
  const wavPath = `${base}.wav`;
  const jsonPath = `${base}.json`;

  try {
    fs.writeFileSync(wavPath, encodeWav(pcm));
    const flags = await s.flags;
    if (!isCurrent(gen)) return;
    const prompt = buildPrompt(s);
    const args = [
      '-m', s.modelPath,
      '-f', wavPath,
      '-oj',
      '-of', base,
      '-l', LANGUAGE,
      '-np',
      // whisper.cpp v1.8.0+ turns flash attention on unless told otherwise,
      // and that is the path that crashes on AMD Vulkan. Older builds have
      // it off already and would choke on the flag, hence the check.
      ...(flags.has('--no-flash-attn') ? ['--no-flash-attn'] : []),
      ...(s.gpuDisabled && flags.has('--no-gpu') ? ['--no-gpu'] : []),
      ...(prompt ? ['--prompt', prompt] : []),
    ];
    const result = await runWhisper(s, args);
    if (!isCurrent(gen)) return;
    if (!result.ok) {
      // A CRASH is the GPU's fault, not this window's: demote the session to
      // the CPU and let the next window prove it. Spending the three-strikes
      // budget on a driver bug would end live transcription for a meeting the
      // machine can still transcribe, just more slowly.
      if (result.crashed && !s.gpuDisabled && flags.has('--no-gpu')) {
        session.gpuDisabled = true;
        emit({
          type: 'notice',
          atMs,
          message:
            '[the GPU crashed — live transcription continued on the CPU, which is slower]',
        });
        return;
      }
      onFailure(gen, 'whisper-cli exited with an error');
      return;
    }
    const text = parseTranscriptJson(jsonPath);
    session.consecutiveFailures = 0;
    if (text) {
      session.transcriptText += (session.transcriptText ? ' ' : '') + text;
      emit({ type: 'segment', text, atMs });
    }
  } catch (err) {
    if (isCurrent(gen)) onFailure(gen, err.message);
  } finally {
    // Temp hygiene regardless of outcome; the dir itself goes at stop().
    for (const p of [wavPath, jsonPath]) {
      try {
        fs.rmSync(p, { force: true });
      } catch {
        // Leftovers are removed with tmpDir at stop().
      }
    }
  }
}

function buildPrompt(s) {
  // Attendee names FIRST so they survive whisper's ~224-token prompt window
  // even when the context tail is long — this is the name-biasing carrier.
  const names = s.attendees.length ? `Attendees: ${s.attendees.join(', ')}. ` : '';
  const tail = s.transcriptText.slice(-PROMPT_TAIL_CHARS);
  return (names + tail).trim();
}

/** Run one window. Resolves { ok, crashed } — `crashed` means whisper-cli
 *  DIED (GPU/driver) rather than exiting with an error it understood, which
 *  is the only failure worth changing the session's settings over. Our own
 *  timeout kill is deliberately not counted as a crash. */
function runWhisper(s, args) {
  return new Promise((resolve) => {
    const child = spawn(s.cliPath, args, {
      cwd: path.dirname(s.cliPath), // sibling DLLs must resolve on Windows
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    s.child = child;
    let settled = false;
    let killedByUs = false;
    const finish = (ok, crashed = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (s.child === child) s.child = null;
      resolve({ ok, crashed });
    };
    const timer = setTimeout(() => {
      killedByUs = true;
      killTree(child);
      finish(false);
    }, WHISPER_TIMEOUT_MS);
    child.stderr.on('data', () => {}); // drain so the process never blocks
    child.on('error', () => finish(false));
    child.on('close', (code, signal) => {
      const crashed =
        !killedByUs &&
        (Boolean(signal) || (typeof code === 'number' && code >= WINDOWS_EXCEPTION_MIN));
      finish(code === 0, crashed);
    });
  });
}

function parseTranscriptJson(jsonPath) {
  const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const segments = Array.isArray(data && data.transcription) ? data.transcription : [];
  const text = segments
    .map((seg) => String(seg.text || '').trim())
    .filter((t) => t && !/^\[(BLANK_AUDIO|SILENCE|MUSIC)\]$/i.test(t))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text;
}

function isCurrent(gen) {
  return Boolean(session) && session.gen === gen;
}

function onFailure(gen, message) {
  if (!isCurrent(gen)) return;
  session.consecutiveFailures += 1;
  if (session.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    emit({
      type: 'error',
      message: `Live transcription stopped (${message}). The recording itself is unaffected.`,
    });
    stop();
  }
}

/** Most recent live text — the flagging loop's window source. */
function getRecentText(chars = 8000) {
  return session ? session.transcriptText.slice(-chars) : '';
}

function getAttendees() {
  return session ? [...session.attendees] : [];
}

function stop() {
  if (!session) return { ok: true };
  const s = session;
  generation += 1;
  session = null; // in-flight completions see isCurrent() === false
  if (s.flushTimer) clearTimeout(s.flushTimer);
  if (s.child) killTree(s.child);
  try {
    fs.rmSync(s.tmpDir, { recursive: true, force: true });
  } catch {
    // Temp dirs are OS-cleaned eventually; never fail a stop over this.
  }
  emit({ type: 'stopped' });
  return { ok: true };
}

/** Kill the process and any children (mirrors serverManager's Windows story:
 *  an orphaned whisper-cli would hold file locks during an NSIS upgrade). */
function killTree(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    } catch {
      child.kill('SIGKILL');
    }
  } else {
    try {
      child.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

module.exports = {
  setEmitter,
  start,
  feed,
  stop,
  isActive,
  getRecentText,
  getAttendees,
};
