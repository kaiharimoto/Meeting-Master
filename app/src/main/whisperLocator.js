'use strict';

// Resolve the whisper-cli binary and live-transcription models on the LAPTOP.
//
// The unified installer already ships whisper-cli.exe on every machine: the
// PyInstaller server sidecar is bundled into resources/server even in
// operator mode, and CI stages whisper-cli.exe (+ its DLLs) into the
// sidecar's bin/ folder. So live transcription reuses that binary — zero
// extra installer bytes. Resolution order:
//   1. MM_WHISPER_CLI env var (dev/tests — point it at any binary or stub)
//   2. The bundled sidecar bin dir (PyInstaller 6 onedir: _internal/bin;
//      older layouts: bin) under process.resourcesPath/server
//   3. PATH lookup (Linux/macOS dev convenience)
// Models are downloaded on demand (modelManager.js) into userData/models.

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

// Whitelist — model names are interpolated into URLs and file paths, so an
// arbitrary string must never get through.
const MODELS = Object.freeze({
  small: { file: 'ggml-small.bin', label: 'small (~466 MB)', bytes: 488 * 1024 * 1024 },
  base: { file: 'ggml-base.bin', label: 'base (~142 MB)', bytes: 148 * 1024 * 1024 },
});

function exeName() {
  return process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli';
}

/** Absolute path to whisper-cli, or null when this install has none. */
function cliPath() {
  const fromEnv = process.env.MM_WHISPER_CLI;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;

  if (app.isPackaged) {
    const candidates = [
      // PyInstaller 6 onedir puts datas under _internal/.
      path.join(process.resourcesPath, 'server', '_internal', 'bin', exeName()),
      path.join(process.resourcesPath, 'server', 'bin', exeName()),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
    return null;
  }

  // Dev without MM_WHISPER_CLI: try PATH.
  const dirs = String(process.env.PATH || '').split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = path.join(dir, exeName());
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // Unreadable PATH entry — keep looking.
    }
  }
  return null;
}

function modelsDir() {
  const dir = path.join(app.getPath('userData'), 'models');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // The download will surface the real error.
  }
  return dir;
}

/** Absolute path a model lives at (whether or not it's downloaded yet). */
function modelPath(name) {
  const spec = MODELS[name];
  if (!spec) throw new Error(`Unknown live-transcription model "${name}".`);
  return path.join(modelsDir(), spec.file);
}

function modelDownloaded(name) {
  try {
    return fs.statSync(modelPath(name)).size > 0;
  } catch {
    return false;
  }
}

/**
 * Everything the renderer needs to render the feature's availability:
 * whether a binary exists at all (else hide the feature), and per-model
 * download state (else prompt for a download).
 */
function support() {
  const cli = cliPath();
  return {
    supported: Boolean(cli),
    reason: cli ? null : 'whisper-cli was not found on this machine.',
    models: Object.fromEntries(
      Object.entries(MODELS).map(([name, spec]) => [
        name,
        { label: spec.label, downloaded: modelDownloaded(name) },
      ])
    ),
  };
}

module.exports = { MODELS, cliPath, modelsDir, modelPath, modelDownloaded, support };
