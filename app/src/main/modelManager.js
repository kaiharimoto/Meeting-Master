'use strict';

// Download/delete live-transcription whisper models on the laptop.
//
// Node port of the server's guided-install download (setup/bootstrap.py
// _download): stream from HuggingFace to <model>.part with percent progress,
// then an atomic rename — a crashed download can never look installed.
// Progress is pushed to the renderer over LIVE_MODEL_EVENT via the emitter
// registered by ipc.js.

const fs = require('fs');
const locator = require('./whisperLocator');

const MODEL_URL = (file) =>
  `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${file}`;

let emit = () => {};

/** ipc.js hands us its push function ({model, state, progress, message}). */
function setEmitter(fn) {
  emit = typeof fn === 'function' ? fn : () => {};
}

const inFlight = new Set(); // model names currently downloading

async function download(name) {
  const spec = locator.MODELS[name];
  if (!spec) throw new Error(`Unknown live-transcription model "${name}".`);
  if (inFlight.has(name)) return { started: false, reason: 'already-downloading' };
  if (locator.modelDownloaded(name)) return { started: false, reason: 'already-downloaded' };

  inFlight.add(name);
  // Fire-and-forget: the caller gets an immediate ack, progress arrives as
  // LIVE_MODEL_EVENT pushes (mirrors the server's TASKS polling pattern).
  run(name, spec).finally(() => inFlight.delete(name));
  return { started: true };
}

async function run(name, spec) {
  const dest = locator.modelPath(name);
  const part = `${dest}.part`;
  emit({ model: name, state: 'running', progress: 0, message: 'Starting download…' });
  try {
    const res = await fetch(MODEL_URL(spec.file));
    if (!res.ok || !res.body) {
      throw new Error(`HuggingFace answered ${res.status}`);
    }
    const total = Number(res.headers.get('content-length')) || spec.bytes;
    const out = fs.createWriteStream(part);
    let received = 0;
    let lastPct = -1;
    for await (const chunk of res.body) {
      out.write(Buffer.from(chunk));
      received += chunk.length;
      const pct = Math.min(99, Math.floor((received / total) * 100));
      if (pct !== lastPct) {
        lastPct = pct;
        emit({
          model: name,
          state: 'running',
          progress: pct,
          message: `Downloading… ${pct}%`,
        });
      }
    }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
    fs.renameSync(part, dest); // atomic: only a complete file gets the real name
    emit({ model: name, state: 'done', progress: 100, message: 'Model ready.' });
  } catch (err) {
    try {
      fs.rmSync(part, { force: true });
    } catch {
      // A stale .part is harmless — the next download overwrites it.
    }
    emit({
      model: name,
      state: 'failed',
      progress: 0,
      message: `Download failed: ${err.message}`,
    });
  }
}

function remove(name) {
  if (inFlight.has(name)) throw new Error('That model is still downloading.');
  fs.rmSync(locator.modelPath(name), { force: true });
  return { ok: true };
}

module.exports = { setEmitter, download, remove };
