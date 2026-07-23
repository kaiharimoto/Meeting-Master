'use strict';

// Recording session file writer (main process side of in-app recording).
//
// The renderer owns the MediaRecorder; this module owns durability. Chunks
// arrive over IPC every ~5 s and are appended + fsynced to a single
// audio.webm, so a crash or power loss costs at most the last timeslice.
// Sequential timeslice chunks of one MediaRecorder session concatenate into
// one valid webm stream (only the first chunk carries the EBML header), and
// ffmpeg tolerates a truncated final cluster — which is the whole crash
// recovery story: an un-finalized file is still transcribable as-is.
//
// Layout: <userData>/recordings/<recId>/audio.webm + meta.json. meta.json has
// finalized:false while a session is live; an un-finalized dir that is not
// the active session is an orphan (crashed session) offered for recovery on
// the next launch. Recordings are NEVER deleted automatically — only an
// explicit user Discard removes one.

const fs = require('fs');
const path = require('path');
const paths = require('./paths');

const MIN_FREE_BYTES_TO_START = 500 * 1024 * 1024;
// Refresh the (statfs-based) free-space figure every Nth append (~30 s at the
// renderer's 5 s timeslice) — cheap enough, and low-disk warnings don't need
// to be second-accurate.
const FREE_BYTES_REFRESH_EVERY = 6;

let active = null; // { recId, dir, filePath, fd, bytes, nextSeq, appends, meta, freeBytes }

function freeBytesAt(dir) {
  try {
    const s = fs.statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null; // unknown — callers treat null as "don't warn"
  }
}

function writeMeta(dir, meta) {
  try {
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
  } catch {
    // Best effort — the audio file itself is the thing that must survive.
  }
}

function readMeta(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  } catch {
    return null;
  }
}

function requireActive(recId) {
  if (!active || active.recId !== recId) {
    throw new Error('No recording session with that id is active.');
  }
  return active;
}

/** Begin a new session. Throws if one is already active or disk is too full. */
function start({ meetingId } = {}) {
  if (active) throw new Error('A recording is already in progress.');

  const root = paths.recordingsDir();
  const freeBytes = freeBytesAt(root);
  if (freeBytes !== null && freeBytes < MIN_FREE_BYTES_TO_START) {
    throw new Error('Not enough free disk space to record (need at least 500 MB free).');
  }

  const recId = `rec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const dir = path.join(root, recId);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'audio.webm');
  const fd = fs.openSync(filePath, 'w');

  const meta = {
    recId,
    meetingId: meetingId || null,
    startedAt: new Date().toISOString(),
    bytes: 0,
    durationMs: 0,
    finalized: false,
  };
  writeMeta(dir, meta);

  active = { recId, dir, filePath, fd, bytes: 0, nextSeq: 0, appends: 0, meta, freeBytes };
  return { recId, filePath, freeBytes };
}

/**
 * Append one MediaRecorder chunk. seq must be the next expected number — the
 * renderer serializes appends through a single queue, so a mismatch means a
 * dropped or duplicated chunk and the file can no longer be trusted.
 */
function append(recId, seq, arrayBuffer, elapsedMs) {
  const s = requireActive(recId);
  if (seq !== s.nextSeq) {
    throw new Error(`Recording chunk out of order (got ${seq}, expected ${s.nextSeq}).`);
  }
  const buf = Buffer.from(arrayBuffer);
  fs.writeSync(s.fd, buf);
  fs.fsyncSync(s.fd);
  s.bytes += buf.length;
  s.nextSeq += 1;
  s.appends += 1;

  s.meta.bytes = s.bytes;
  s.meta.durationMs = Math.max(0, Number(elapsedMs) || 0);
  if (s.appends % FREE_BYTES_REFRESH_EVERY === 0) {
    s.freeBytes = freeBytesAt(s.dir);
    writeMeta(s.dir, s.meta);
  }
  return { bytes: s.bytes, freeBytes: s.freeBytes };
}

/** Finalize the active session; the file becomes the meeting's attachment. */
function stop(recId, { durationMs } = {}) {
  const s = requireActive(recId);
  try {
    fs.fsyncSync(s.fd);
  } catch {
    // The per-append fsync already ran; a failure here loses nothing new.
  }
  fs.closeSync(s.fd);
  s.meta.finalized = true;
  s.meta.finishedAt = new Date().toISOString();
  s.meta.bytes = s.bytes;
  if (durationMs !== undefined) s.meta.durationMs = Math.max(0, Number(durationMs) || 0);
  writeMeta(s.dir, s.meta);
  active = null;
  return { filePath: s.filePath, bytes: s.bytes, durationMs: s.meta.durationMs };
}

/** Delete a recording (the only deletion path — always user-initiated). */
function discard(recId) {
  if (active && active.recId === recId) {
    try {
      fs.closeSync(active.fd);
    } catch {
      // Already closed or invalid — removal below is what matters.
    }
    active = null;
  }
  const dir = path.join(paths.recordingsDir(), String(recId));
  if (!isInsideRecordings(dir)) throw new Error('Invalid recording id.');
  fs.rmSync(dir, { recursive: true, force: true });
  return { ok: true };
}

/**
 * Sessions that never finalized (crash/power loss), newest first. A dir with
 * an unreadable meta.json is treated as an orphan too — meta writes only
 * happen while a session is live or at stop, so a corrupt one means the
 * session died mid-write.
 */
function listOrphans() {
  const root = paths.recordingsDir();
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const orphans = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (active && active.recId === ent.name) continue;
    const dir = path.join(root, ent.name);
    const meta = readMeta(dir);
    if (meta && meta.finalized) continue;
    const filePath = path.join(dir, 'audio.webm');
    let bytes = 0;
    let mtimeMs = 0;
    try {
      const st = fs.statSync(filePath);
      bytes = st.size;
      mtimeMs = st.mtimeMs;
    } catch {
      continue; // no audio file — nothing worth recovering
    }
    if (bytes === 0) continue;
    orphans.push({
      recId: ent.name,
      filePath,
      startedAt: (meta && meta.startedAt) || new Date(mtimeMs).toISOString(),
      bytes,
      durationMs: (meta && meta.durationMs) || 0,
    });
  }
  orphans.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  return orphans;
}

/** 'attach' marks an orphan usable (finalized); 'discard' deletes it. */
function resolveOrphan(recId, action) {
  if (action === 'discard') return discard(recId);
  const dir = path.join(paths.recordingsDir(), String(recId));
  if (!isInsideRecordings(dir)) throw new Error('Invalid recording id.');
  const filePath = path.join(dir, 'audio.webm');
  const st = fs.statSync(filePath); // throws if gone — surfaces as a clean error
  const meta = readMeta(dir) || { recId, startedAt: new Date(st.mtimeMs).toISOString() };
  meta.finalized = true;
  meta.recoveredAt = new Date().toISOString();
  meta.bytes = st.size;
  writeMeta(dir, meta);
  return {
    filePath,
    bytes: st.size,
    durationMs: meta.durationMs || 0,
    startedAt: meta.startedAt,
  };
}

/** Existence probe for the renderer — recordings folder only, by design. */
function stat(filePath) {
  const resolved = path.resolve(String(filePath || ''));
  if (!isInsideRecordings(resolved)) {
    throw new Error('Only files inside the recordings folder can be checked.');
  }
  try {
    const st = fs.statSync(resolved);
    return { exists: st.isFile(), bytes: st.size };
  } catch {
    return { exists: false, bytes: 0 };
  }
}

function isInsideRecordings(resolved) {
  const root = paths.recordingsDir();
  return resolved.startsWith(root + path.sep) && !resolved.includes('..');
}

function isActive() {
  return Boolean(active);
}

/**
 * Quit path: close the fd but leave finalized:false, so the session becomes
 * a recoverable orphan on the next launch instead of a half-open file handle.
 */
function abandonActive() {
  if (!active) return;
  try {
    fs.fsyncSync(active.fd);
    fs.closeSync(active.fd);
  } catch {
    // Nothing more we can do on the way out.
  }
  writeMeta(active.dir, active.meta);
  active = null;
}

module.exports = {
  start,
  append,
  stop,
  discard,
  listOrphans,
  resolveOrphan,
  stat,
  isActive,
  abandonActive,
};
