// In-app microphone recording (the "Record audio" panel).
//
// The renderer owns the capture pipeline; main owns durability (recorder.js
// in src/main appends + fsyncs every chunk). The mic is NOT recorded
// directly: it feeds a WebAudio bus (source → gain → destination) and the
// MediaRecorder records the destination stream. The destination never ends
// when a device dies, so unplugging/swapping a mic mid-meeting just swaps the
// source node — the recorder keeps running and the file never splits. The
// same bus is where a system-audio (loopback) source joins as a second input.
//
// State machine: idle → acquiring → recording ⇄ paused → stopping → idle
// (with the finished file attached to the meeting as ctx.state.recording).

import { setStatus, showError } from './status.js';
import { showToast } from './toast.js';
import { updateButtons } from './generate.js';
import { openCardModal } from './capture.js';

const TIMESLICE_MS = 5000;
const AUDIO_BITS_PER_SECOND = 32000; // Opus mono speech: ~14 MB/hour
const LOW_DISK_WARN_BYTES = 200 * 1024 * 1024;
const LOW_DISK_STOP_BYTES = 50 * 1024 * 1024;

let ctx = null;
let els = null;

let status = 'idle'; // idle | acquiring | recording | paused | stopping
let recId = null;
let recFilePath = null;
let seq = 0;
let bytesOnDisk = 0;
// The timer counts RECORDED time only: accumulated closed segments plus the
// currently-running one. Pauses don't count.
let activeMs = 0;
let segmentStartedAt = 0;
let interrupted = false;
let warnedLowDisk = false;
let fatalAppendError = false;

let mediaRecorder = null;
let audioCtx = null;
let gainNode = null;
let analyser = null;
let destNode = null;
let sourceNode = null;
let micStream = null;
let loopbackStream = null;
let loopbackSource = null;

// Live-transcription tap (optional; see maybeStartLive). The tap reads the
// RECORDED mix (destNode.stream) so mic swaps and loopback are invisible to
// it, and its failures must never disturb the recording itself.
let tapSource = null;
let tapNode = null;
let muteGain = null;
let liveActive = false;
let pcmBatch = [];
let pcmBatchRms = 0;

// Chunk FIFO: ondataavailable pushes, a single drain loop appends over IPC so
// chunks always land on disk in order and failures surface in one place.
let queue = [];
let drainPromise = null;

let timerInterval = null;
let meterRaf = 0;
let lastRms = 0;

export function initRecorder(context) {
  ctx = context;
  els = {
    panel: document.getElementById('record-heading')?.closest('.panel') || null,
    device: document.getElementById('rec-device-select'),
    loopback: document.getElementById('rec-loopback-check'),
    loopbackField: document.getElementById('rec-loopback-field'),
    liveField: document.getElementById('rec-live-field'),
    liveCheck: document.getElementById('rec-live-check'),
    liveHint: document.getElementById('rec-live-hint'),
    start: document.getElementById('rec-start-btn'),
    pause: document.getElementById('rec-pause-btn'),
    resume: document.getElementById('rec-resume-btn'),
    stop: document.getElementById('rec-stop-btn'),
    discard: document.getElementById('rec-discard-btn'),
    timer: document.getElementById('rec-timer'),
    meter: document.getElementById('rec-meter'),
    meterFill: document.getElementById('rec-meter-fill'),
    note: document.getElementById('rec-note'),
    guard: document.getElementById('rec-guard'),
    mini: document.getElementById('rec-mini-btn'),
  };
  if (!els.start) return;

  // Other modules (generate.js button states, the New-meeting guard) read
  // this instead of importing us — keeps the module graph acyclic.
  ctx.recActive = () => status === 'recording' || status === 'paused' || status === 'stopping';

  const supported =
    ctx.api &&
    typeof ctx.api.recStart === 'function' &&
    typeof navigator !== 'undefined' &&
    navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === 'function' &&
    typeof window.MediaRecorder === 'function';
  if (!supported) {
    // Older preload or a plain browser: keep the picker-based flow only.
    if (els.panel) els.panel.hidden = true;
    return;
  }

  els.start.addEventListener('click', () => guarded(startRecording));
  els.pause.addEventListener('click', () => guarded(pauseRecording));
  els.resume.addEventListener('click', () => guarded(resumeRecording));
  els.stop.addEventListener('click', () => guarded(() => stopRecording(false)));
  els.discard.addEventListener('click', () => guarded(discardRecording));
  els.device.addEventListener('change', () => guarded(onDeviceChosen));
  if (els.mini) {
    els.mini.addEventListener('click', () => {
      if (typeof ctx.api.miniOpen === 'function') ctx.api.miniOpen().catch(() => {});
    });
  }

  // Mini-mode remote control: the compact always-on-top window sends its
  // button presses here (the MediaRecorder lives in THIS renderer).
  if (typeof ctx.api.onMiniCmd === 'function') {
    ctx.api.onMiniCmd((payload) => {
      const cmd = payload && payload.cmd;
      if (cmd === 'pause') guarded(pauseRecording);
      else if (cmd === 'resume') guarded(resumeRecording);
      else if (cmd === 'stop') guarded(() => stopRecording(false));
      else if (cmd === 'q') openCardModal(null);
    });
  }

  // The taskbar title should be live even when the guard/title change without
  // a full renderAll (typing in the title field).
  const titleInput = document.getElementById('meeting-title-input');
  if (titleInput) {
    titleInput.addEventListener('input', () => {
      updateWindowTitle();
      updateRecordGuard();
    });
  }

  // Loopback ("also record computer audio") is Windows-only.
  if (els.loopbackField && ctx.api && typeof ctx.api.getAppInfo === 'function') {
    ctx.api
      .getAppInfo()
      .then((info) => {
        if (info && info.platform === 'win32') els.loopbackField.hidden = false;
      })
      .catch(() => {});
  }

  populateDevices();
  initLiveSupport();
  if (navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', () => {
      populateDevices();
      // A vanished mic mid-recording is handled by track.onended below; this
      // listener only keeps the picker list fresh.
    });
  }

  // Window close guard chose "Stop recording and close": finalize + attach,
  // then main closes the window (see main.js onRecordingStopped).
  if (typeof ctx.api.onRecEvent === 'function') {
    ctx.api.onRecEvent((payload) => {
      if (payload && payload.type === 'force-stop' && ctx.recActive()) {
        guarded(() => stopRecording(true));
      }
    });
  }

  // Dev Ctrl+R protection — real window close is intercepted in main.
  window.addEventListener('beforeunload', (e) => {
    if (ctx.recActive()) e.preventDefault();
  });

  renderNote();
  updateRecUi();
  maybeOfferOrphan();
}

async function guarded(fn) {
  try {
    await fn();
  } catch (err) {
    showError(err && err.message ? err.message : String(err));
  }
}

// ---- Device picker ----------------------------------------------------------

async function populateDevices() {
  if (!els.device) return;
  let devices = [];
  try {
    devices = await navigator.mediaDevices.enumerateDevices();
  } catch {
    devices = [];
  }
  const mics = devices.filter((d) => d.kind === 'audioinput');
  const previous = els.device.value;
  els.device.innerHTML = '';
  const def = document.createElement('option');
  def.value = '';
  def.textContent = 'System default microphone';
  els.device.append(def);
  for (const mic of mics) {
    if (mic.deviceId === 'default' || mic.deviceId === '') continue;
    const opt = document.createElement('option');
    opt.value = mic.deviceId;
    opt.textContent = mic.label || 'Microphone';
    els.device.append(opt);
  }
  // Keep the operator's in-session choice; otherwise fall back to the saved
  // default from Settings (by id, then by label — ids change across OS
  // reinstalls, labels usually survive).
  if (previous && [...els.device.options].some((o) => o.value === previous)) {
    els.device.value = previous;
    return;
  }
  const saved = await savedMicPreference();
  if (saved.id && [...els.device.options].some((o) => o.value === saved.id)) {
    els.device.value = saved.id;
  } else if (saved.label) {
    const byLabel = [...els.device.options].find((o) => o.textContent === saved.label);
    if (byLabel) els.device.value = byLabel.value;
  }
}

async function savedMicPreference() {
  try {
    const cfg = ctx.config || (ctx.api && (await ctx.api.getConfig())) || {};
    return { id: cfg.micDeviceId || '', label: cfg.micDeviceLabel || '' };
  } catch {
    return { id: '', label: '' };
  }
}

/** Selecting a device while live swaps the source node — no interruption. */
async function onDeviceChosen() {
  if (status !== 'recording' && status !== 'paused') return;
  await attachMicSource(els.device.value || null);
  showToast({
    kind: 'info',
    title: 'Microphone switched',
    message: currentMicLabel() || 'Now using the selected microphone.',
  });
}

function currentMicLabel() {
  const track = micStream && micStream.getAudioTracks()[0];
  return (track && track.label) || '';
}

// ---- Live transcription tap -------------------------------------------------

/** Reveal + prime the "Live transcript" checkbox when this install can. */
async function initLiveSupport() {
  if (!els.liveField || !els.liveCheck || typeof ctx.api.liveSupportGet !== 'function') return;
  try {
    const support = await ctx.api.liveSupportGet();
    if (!support || !support.supported) return; // no whisper binary: stay hidden
    els.liveField.hidden = false;
    const cfg = ctx.config || (typeof ctx.api.getConfig === 'function' ? await ctx.api.getConfig() : null) || {};
    const modelName = cfg.liveModel || 'small';
    const model = support.models && support.models[modelName];
    const ready = Boolean(model && model.downloaded);
    els.liveCheck.disabled = !ready;
    els.liveCheck.checked = ready && Boolean(cfg.liveTranscriptEnabled);
    if (els.liveHint) els.liveHint.hidden = ready;
  } catch {
    // Support probe failed — leave the feature hidden.
  }
}

/** Start the live session + audio tap. NEVER throws: live is advisory and a
 *  failure here must not touch the recording that is already running. */
async function maybeStartLive() {
  if (!els.liveCheck || els.liveField.hidden || !els.liveCheck.checked) return;
  if (typeof ctx.api.liveStart !== 'function') return;
  try {
    const attendees = (ctx.state.details && ctx.state.details.attendees) || [];
    await ctx.api.liveStart({ attendees });
    await audioCtx.audioWorklet.addModule('js/pcmTap.worklet.js');
    tapSource = audioCtx.createMediaStreamSource(destNode.stream);
    tapNode = new AudioWorkletNode(audioCtx, 'pcm-tap');
    tapSource.connect(tapNode);
    // A worklet with no downstream connection may not be pulled — route it to
    // the destination through a muted gain so processing is guaranteed.
    muteGain = audioCtx.createGain();
    muteGain.gain.value = 0;
    tapNode.connect(muteGain);
    muteGain.connect(audioCtx.destination);
    tapNode.port.onmessage = (e) => queueLivePcm(e.data);
    liveActive = true;
    document.dispatchEvent(new CustomEvent('mm:live-start'));
  } catch (err) {
    showToast({
      kind: 'error',
      title: 'Live transcript unavailable',
      message: `${err.message} Recording continues normally.`,
    });
    await stopLive();
  }
}

/** Batch worklet blocks (~0.5 s) before crossing IPC. Lossy-tolerant: a
 *  failed send is dropped — the durable recording path is separate. */
function queueLivePcm(data) {
  if (!liveActive || !data || !data.buf) return;
  pcmBatch.push(new Uint8Array(data.buf));
  pcmBatchRms = Math.max(pcmBatchRms, Number(data.rms) || 0);
  if (pcmBatch.length < 4) return;
  const total = pcmBatch.reduce((n, b) => n + b.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const b of pcmBatch) {
    merged.set(b, offset);
    offset += b.length;
  }
  const rms = pcmBatchRms;
  pcmBatch = [];
  pcmBatchRms = 0;
  ctx.api.livePcm(merged.buffer, rms).catch(() => {});
}

async function stopLive() {
  if (tapNode) tapNode.port.onmessage = null;
  for (const node of [tapSource, tapNode, muteGain]) {
    if (node) {
      try {
        node.disconnect();
      } catch {
        // Already disconnected.
      }
    }
  }
  tapSource = null;
  tapNode = null;
  muteGain = null;
  pcmBatch = [];
  pcmBatchRms = 0;
  if (!liveActive) return;
  liveActive = false;
  try {
    await ctx.api.liveStop();
  } catch {
    // The main-side session dies with the app either way.
  }
}

// ---- Capture pipeline -------------------------------------------------------

function micConstraints(deviceId) {
  return {
    audio: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  };
}

/** (Re)connect the microphone into the bus. Throws with remedies on failure. */
async function attachMicSource(deviceId) {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia(micConstraints(deviceId));
  } catch (err) {
    if (deviceId && (err.name === 'NotFoundError' || err.name === 'OverconstrainedError')) {
      // The chosen device is gone — fall back to the system default.
      stream = await navigator.mediaDevices.getUserMedia(micConstraints(null));
      showToast({
        kind: 'info',
        title: 'Chosen microphone unavailable',
        message: 'Recording with the system default microphone instead.',
      });
    } else if (err.name === 'NotAllowedError') {
      throw new Error(
        'Microphone access is blocked. On Windows: Settings → Privacy & security → ' +
          'Microphone → allow desktop apps.'
      );
    } else if (err.name === 'NotReadableError') {
      throw new Error(
        'The microphone is in use by another application — close it and try again.'
      );
    } else {
      throw err;
    }
  }

  // Swap: disconnect the old source, plug in the new one. The destination
  // stream (what MediaRecorder records) is untouched.
  if (sourceNode) {
    try {
      sourceNode.disconnect();
    } catch {
      // Already disconnected.
    }
  }
  if (micStream) {
    for (const t of micStream.getTracks()) t.stop();
  }
  micStream = stream;
  sourceNode = audioCtx.createMediaStreamSource(stream);
  sourceNode.connect(gainNode);

  const track = stream.getAudioTracks()[0];
  if (track) {
    track.onended = () => onMicLost();
  }
  if (interrupted) {
    interrupted = false;
    showToast({ kind: 'success', title: 'Microphone reconnected', message: track ? track.label : '' });
    setStatus('Recording…', { busy: true });
  }
}

/** The live mic died (unplugged). Keep recording — the bus writes silence —
 *  and try to pick up whatever mic the OS has now. */
async function onMicLost() {
  if (status !== 'recording' && status !== 'paused') return;
  interrupted = true;
  showError('Microphone disconnected — recording continues (silence). Reconnect it or pick another mic.');
  showToast({
    kind: 'error',
    title: 'Microphone disconnected',
    message: 'The recording is still running and is safe on disk. Reconnect a mic or pick another one.',
  });
  try {
    await attachMicSource(els.device.value || null);
  } catch {
    // Stay interrupted; the devicechange handler refreshes the picker and the
    // operator can select a working mic (onDeviceChosen re-attaches).
  }
}

async function buildLoopbackSource() {
  // Windows-only: capture system audio (remote participants) and mix it in.
  // getDisplayMedia needs a video track even though we only want audio — it
  // is stopped immediately (see main.js setDisplayMediaRequestHandler).
  const display = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
  for (const t of display.getVideoTracks()) t.stop();
  if (display.getAudioTracks().length === 0) {
    throw new Error('System audio capture returned no audio track.');
  }
  loopbackStream = display;
  loopbackSource = audioCtx.createMediaStreamSource(display);
  const loopGain = audioCtx.createGain();
  loopGain.gain.value = 0.8; // keep the room mic dominant
  loopbackSource.connect(loopGain);
  loopGain.connect(destNode);
}

async function startRecording() {
  if (status !== 'idle') return;
  status = 'acquiring';
  updateRecUi();
  setStatus('Starting the recording…', { busy: true });

  let started = null;
  try {
    started = await ctx.api.recStart({ meetingId: ctx.state.meetingId });

    audioCtx = new AudioContext();
    gainNode = audioCtx.createGain();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    destNode = audioCtx.createMediaStreamDestination();
    gainNode.connect(destNode);
    gainNode.connect(analyser);

    await attachMicSource(els.device.value || null);
    if (els.loopback && els.loopback.checked && !els.loopbackField.hidden) {
      await buildLoopbackSource();
    }

    let mimeType = 'audio/webm;codecs=opus';
    if (!MediaRecorder.isTypeSupported(mimeType)) mimeType = 'audio/webm';
    if (!MediaRecorder.isTypeSupported(mimeType)) {
      throw new Error('This system cannot record webm/opus audio.');
    }
    mediaRecorder = new MediaRecorder(destNode.stream, {
      mimeType,
      audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
    });
  } catch (err) {
    // Nothing was captured — clean up the empty session dir and reset.
    if (started && started.recId) {
      try {
        await ctx.api.recDiscard(started.recId);
      } catch {
        // The empty dir is harmless if this fails.
      }
    }
    teardownGraph();
    status = 'idle';
    updateRecUi();
    throw err;
  }

  recId = started.recId;
  recFilePath = started.filePath;
  seq = 0;
  bytesOnDisk = 0;
  activeMs = 0;
  segmentStartedAt = Date.now();
  interrupted = false;
  warnedLowDisk = false;
  fatalAppendError = false;
  queue = [];

  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) {
      queue.push(e.data);
      drainQueue();
    }
  };
  mediaRecorder.onerror = (e) => {
    showError(`Recorder error: ${(e.error && e.error.message) || 'unknown'} — stopping.`);
    guarded(() => stopRecording(false));
  };

  mediaRecorder.start(TIMESLICE_MS);
  status = 'recording';
  maybeStartLive(); // fire-and-forget; never blocks or fails the recording
  // Starting a recording begins a NEW audio story for this meeting — drop any
  // previously attached file (it stays on disk in the recordings folder).
  ctx.state.recording = null;
  ctx.persist();
  updateRecUi();
  updateButtons(ctx);
  startTimer();
  startMeter();
  setStatus('Recording… captured audio is saved to disk every 5 seconds.', { busy: true });
}

function drainQueue() {
  if (!drainPromise) {
    drainPromise = (async () => {
      try {
        while (queue.length > 0 && !fatalAppendError) {
          const blob = queue.shift();
          const buf = await blob.arrayBuffer();
          const res = await ctx.api.recAppend(recId, seq, buf, currentActiveMs());
          seq += 1;
          bytesOnDisk = res.bytes;
          onFreeBytes(res.freeBytes);
        }
      } catch (err) {
        fatalAppendError = true;
        showError(`Could not save recording audio: ${err.message} — stopping.`);
        if (status === 'recording' || status === 'paused') {
          guarded(() => stopRecording(false));
        }
      } finally {
        drainPromise = null;
      }
    })();
  }
  return drainPromise;
}

/** Wait until every queued chunk is on disk (or a fatal error gave up). A
 *  chunk can arrive between one drain finishing and this check, so loop. */
async function drainAll() {
  while ((queue.length > 0 || drainPromise) && !fatalAppendError) {
    await drainQueue();
  }
}

function onFreeBytes(freeBytes) {
  if (typeof freeBytes !== 'number') return;
  if (freeBytes < LOW_DISK_STOP_BYTES && (status === 'recording' || status === 'paused')) {
    showToast({
      kind: 'error',
      title: 'Disk almost full — recording stopped',
      message: 'The recording was stopped to protect it. Everything up to now is attached.',
    });
    guarded(() => stopRecording(false));
  } else if (freeBytes < LOW_DISK_WARN_BYTES && !warnedLowDisk) {
    warnedLowDisk = true;
    showToast({
      kind: 'info',
      title: 'Disk space is getting low',
      message: 'Free up some space — the recording stops automatically if it runs out.',
    });
  }
}

function pauseRecording() {
  if (status !== 'recording' || !mediaRecorder) return;
  mediaRecorder.pause();
  activeMs += Date.now() - segmentStartedAt;
  status = 'paused';
  // Stop feeding the live tap; main's data-gap timer flushes the tail.
  if (tapSource && tapNode) {
    try {
      tapSource.disconnect(tapNode);
    } catch {
      // Already disconnected.
    }
  }
  updateRecUi();
  setStatus('Recording paused.', { busy: false });
}

function resumeRecording() {
  if (status !== 'paused' || !mediaRecorder) return;
  mediaRecorder.resume();
  segmentStartedAt = Date.now();
  status = 'recording';
  if (liveActive && tapSource && tapNode) {
    try {
      tapSource.connect(tapNode);
    } catch {
      // Live tap could not resume — recording is unaffected.
    }
  }
  updateRecUi();
  setStatus('Recording…', { busy: true });
}

/** Ask MediaRecorder for its final chunk and wait until it lands in `queue`. */
function stopMediaRecorder() {
  return new Promise((resolve) => {
    if (!mediaRecorder || mediaRecorder.state === 'inactive') {
      resolve();
      return;
    }
    mediaRecorder.onstop = () => resolve();
    try {
      mediaRecorder.stop(); // fires a last ondataavailable, then onstop
    } catch {
      resolve();
    }
  });
}

async function stopRecording(force) {
  if (status !== 'recording' && status !== 'paused') return;
  if (status === 'recording') activeMs += Date.now() - segmentStartedAt;
  status = 'stopping';
  updateRecUi();
  setStatus('Finishing the recording…', { busy: true });
  await stopLive(); // live is advisory — end it before finalizing the audio

  // The final ondataavailable fires before onstop, so its chunk is already
  // queued by the time this resolves — drainAll flushes everything to disk.
  await stopMediaRecorder();
  await drainAll();

  // Forced (window is closing): persist the attachment BEFORE recStop — main
  // closes the window as soon as the session finalizes, and localStorage
  // writes are synchronous, so this guarantees the meeting keeps its audio.
  const attach = (bytes, durationMs) => {
    ctx.state.recording = {
      recId,
      filePath: recFilePath,
      durationMs,
      bytes,
      finishedAt: Date.now(),
      source: 'in-app',
    };
    ctx.persist();
  };
  if (force) attach(bytesOnDisk, activeMs);

  try {
    const out = await ctx.api.recStop(recId, { durationMs: activeMs });
    attach(out.bytes, out.durationMs);
  } catch (err) {
    if (!force) {
      // The fsynced file is still on disk; the orphan flow can rescue it.
      showError(`Could not finalize the recording: ${err.message}`);
    }
  }

  teardownGraph();
  status = 'idle';
  recId = null;
  updateRecUi();
  renderNote();
  updateButtons(ctx);
  const rec = ctx.state.recording;
  if (rec) {
    setStatus(`Recording attached — ${fmtDuration(rec.durationMs)}, ${fmtBytes(rec.bytes)}.`);
    showToast({
      kind: 'success',
      title: 'Recording attached',
      message: '“Generate transcript” now uses this recording.',
    });
  }
}

async function discardRecording() {
  if (status !== 'recording' && status !== 'paused') return;
  const sure = window.confirm('Discard this recording? The audio captured so far is deleted.');
  if (!sure) return;
  if (status === 'recording') activeMs += Date.now() - segmentStartedAt;
  status = 'stopping';
  updateRecUi();
  await stopLive();

  await stopMediaRecorder();
  queue = []; // nothing to keep — drop unflushed chunks
  await drainAll(); // but let an in-flight append finish before deleting
  try {
    await ctx.api.recDiscard(recId);
  } catch (err) {
    showError(`Could not delete the recording: ${err.message}`);
  }

  teardownGraph();
  status = 'idle';
  recId = null;
  updateRecUi();
  updateButtons(ctx);
  setStatus('Recording discarded.');
}

function teardownGraph() {
  // Defensive: stopLive() normally ran already; make teardown idempotent.
  if (tapNode) tapNode.port.onmessage = null;
  for (const node of [tapSource, tapNode, muteGain]) {
    if (node) {
      try {
        node.disconnect();
      } catch {
        // Already disconnected.
      }
    }
  }
  tapSource = null;
  tapNode = null;
  muteGain = null;
  if (micStream) {
    for (const t of micStream.getTracks()) t.stop();
    micStream = null;
  }
  if (loopbackStream) {
    for (const t of loopbackStream.getTracks()) t.stop();
    loopbackStream = null;
  }
  loopbackSource = null;
  sourceNode = null;
  gainNode = null;
  analyser = null;
  destNode = null;
  mediaRecorder = null;
  if (audioCtx) {
    audioCtx.close().catch(() => {});
    audioCtx = null;
  }
  stopTimer();
  stopMeter();
}

// ---- Timer + level meter ----------------------------------------------------

function currentActiveMs() {
  return activeMs + (status === 'recording' ? Date.now() - segmentStartedAt : 0);
}

function startTimer() {
  stopTimer();
  timerInterval = setInterval(() => {
    els.timer.textContent = fmtDuration(currentActiveMs());
    updateWindowTitle();
    pushMiniStatus();
  }, 500);
  els.timer.textContent = '00:00';
}

function stopTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

function startMeter() {
  const data = new Uint8Array(analyser.fftSize);
  const tick = () => {
    if (!analyser || status === 'idle' || status === 'stopping') return;
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i += 1) {
      const v = (data[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / data.length);
    lastRms = rms; // sampled by the mini-mode status push (timer cadence)
    // Speech RMS rarely exceeds ~0.3 — scale so normal talk fills the bar.
    els.meterFill.style.width = `${Math.min(100, Math.round(rms * 300))}%`;
    meterRaf = requestAnimationFrame(tick);
  };
  meterRaf = requestAnimationFrame(tick);
}

function stopMeter() {
  if (meterRaf) {
    cancelAnimationFrame(meterRaf);
    meterRaf = 0;
  }
  if (els.meterFill) els.meterFill.style.width = '0%';
}

// ---- UI state ---------------------------------------------------------------

function updateRecUi() {
  const live = status === 'recording' || status === 'paused';
  els.start.hidden = live || status === 'stopping';
  els.start.disabled = status === 'acquiring' || status === 'stopping';
  els.pause.hidden = status !== 'recording';
  els.resume.hidden = status !== 'paused';
  els.stop.hidden = !live;
  els.stop.disabled = status === 'stopping';
  els.discard.hidden = !live;
  els.discard.disabled = status === 'stopping';
  els.timer.hidden = !live && status !== 'stopping';
  els.timer.classList.toggle('is-paused', status === 'paused');
  els.meter.hidden = !live;
  if (els.mini) {
    els.mini.hidden = !live || typeof ctx.api.miniOpen !== 'function';
  }
  // The sidebar dot: recording stays visible from any screen.
  const navMeeting = document.getElementById('nav-meeting');
  if (navMeeting) navMeeting.classList.toggle('is-recording', live);
  updateWindowTitle();
  updateRecordGuard();
  pushMiniStatus();
  // Let the stage shell react to recording transitions.
  document.dispatchEvent(new CustomEvent('mm:stage'));
}

/** Taskbar/window title mirrors the meeting + recording state, so even a
 *  minimized window shows it's rolling. */
export function updateWindowTitle() {
  if (!ctx) return;
  const meetingTitle = ((ctx.state.details && ctx.state.details.title) || '').trim();
  let title;
  if (status === 'recording' || status === 'paused') {
    const mark = status === 'paused' ? '⏸' : '●';
    title = `${mark} ${fmtDuration(currentActiveMs())} — ${meetingTitle || 'Recording'}`;
  } else {
    title = meetingTitle ? `${meetingTitle} — Meeting Master` : 'Meeting Master';
  }
  if (document.title !== title) document.title = title;
}

/** "You're typing but nothing is being captured" — the most expensive
 *  mistake this app can prevent. Quiet, persistent, gone once you record. */
export function updateRecordGuard() {
  if (!ctx || !els || !els.guard) return;
  const job = ctx.state.job || {};
  const meaningful = Boolean(
    ((ctx.state.details && ctx.state.details.title) || '').trim() ||
      (ctx.state.cards || []).length > 0
  );
  const canRecord =
    Boolean(ctx.api && typeof ctx.api.recStart === 'function') &&
    els.panel &&
    !els.panel.hidden;
  els.guard.hidden = !(
    status === 'idle' &&
    canRecord &&
    meaningful &&
    !ctx.state.recording &&
    !job.id &&
    !ctx.state.transcript
  );
}

/** Feed the mini-mode window (if open, main relays; otherwise a cheap no-op). */
function pushMiniStatus() {
  if (!ctx || !ctx.api || typeof ctx.api.miniStatus !== 'function') return;
  ctx.api
    .miniStatus({
      status,
      elapsedMs: currentActiveMs(),
      rms: lastRms,
      title: ((ctx.state.details && ctx.state.details.title) || '').trim(),
    })
    .catch(() => {});
}

/** The "Recording attached" line under the controls. */
export function renderNote() {
  if (!els || !els.note) return;
  const rec = ctx.state.recording;
  if (!rec || !rec.filePath) {
    els.note.hidden = true;
    els.note.textContent = '';
    return;
  }
  els.note.hidden = false;
  els.note.textContent = '';
  const label = document.createElement('span');
  const when = rec.source === 'recovered' ? ' (recovered after a crash)' : '';
  label.textContent =
    `Recording attached${when} — ${fmtDuration(rec.durationMs)}, ${fmtBytes(rec.bytes)}. ` +
    '“Generate transcript” will use it. ';
  els.note.append(label);
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'btn btn-secondary btn-small';
  remove.textContent = 'Remove';
  remove.title = 'Detach from this meeting — the file stays in the recordings folder';
  remove.addEventListener('click', () => {
    ctx.state.recording = null;
    ctx.persist();
    renderNote();
    updateButtons(ctx);
    setStatus('Recording detached — “Generate transcript” opens the file picker again.');
  });
  els.note.append(remove);
}

// ---- Crash recovery ---------------------------------------------------------

async function maybeOfferOrphan() {
  if (typeof ctx.api.recListOrphans !== 'function') return;
  if (ctx.state.recording && ctx.state.recording.filePath) return; // already have audio
  let orphans = [];
  try {
    ({ orphans } = await ctx.api.recListOrphans());
  } catch {
    return;
  }
  if (!Array.isArray(orphans) || orphans.length === 0) return;
  const o = orphans[0]; // newest first — realistically there is only one
  const started = o.startedAt ? new Date(o.startedAt).toLocaleString() : 'an earlier session';
  showToast({
    kind: 'info',
    title: 'Unfinished recording found',
    message:
      `From ${started} — ${fmtDuration(o.durationMs)}, ${fmtBytes(o.bytes)}. ` +
      'Attach it to this meeting? (Dismiss keeps it in the recordings folder.)',
    timeoutMs: 0, // decisions about meeting audio shouldn't auto-fade
    action: {
      label: 'Use it',
      onClick: () =>
        guarded(async () => {
          const r = await ctx.api.recResolveOrphan(o.recId, 'attach');
          ctx.state.recording = {
            recId: o.recId,
            filePath: r.filePath,
            durationMs: r.durationMs || o.durationMs || 0,
            bytes: r.bytes || o.bytes || 0,
            finishedAt: Date.now(),
            source: 'recovered',
          };
          ctx.persist();
          renderNote();
          updateButtons(ctx);
          setStatus('Recovered recording attached — “Generate transcript” will use it.');
        }),
    },
  });
}

// ---- Formatting -------------------------------------------------------------

function fmtDuration(ms) {
  const totalSec = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function fmtBytes(bytes) {
  const b = Number(bytes) || 0;
  if (b >= 1024 * 1024 * 1024) return `${(b / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (b >= 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(b / 1024))} KB`;
}
