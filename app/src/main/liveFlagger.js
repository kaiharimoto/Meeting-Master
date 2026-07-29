'use strict';

// Mid-meeting live-suggestion loop (main-process side).
//
// While live transcription runs, the newest slice of live text goes to the home
// server's POST /live/questions (Ollama on the home PC) on a fixed interval;
// what comes back — candidate Q&A pairs AND candidate key insights — is pushed
// to the renderer as LIVE_EVENT {type:'flag-candidates'} for the side rail's
// approve/dismiss list.
//
// The home server owns the configuration (GET /live/config, set on its
// dashboard), so there is exactly one place to tune this and the laptop needs
// no settings of its own. Two numbers from there matter most:
//
//   * intervalSec — how often to ask.
//   * clientTimeoutSec — always LONGER than the server's own budget. The
//     previous version hard-coded 45 s against a server that allowed itself
//     60 s, so a home PC running a big model failed EVERY tick from the
//     client side while answering fine: three failures, then a 2-minute
//     backoff, and live suggestions were dead for the rest of the meeting
//     with nothing on screen to say why.
//
// Failure contract: NEVER INTERRUPTIVE — no dialogs, no toasts, nothing that
// steals focus or disturbs recording/transcription; the post-meeting extraction
// remains the quality backstop. But no longer SILENT: every state change is
// reported as LIVE_EVENT {type:'flag-status'} and shown as one quiet line in
// the rail. "Working on it", "the home server is unreachable" and "this is
// switched off" are three very different things, and the operator could
// previously not tell them apart.

const homeClient = require('./homeClient');
const liveTranscriber = require('./liveTranscriber');

// Used until GET /live/config answers (and if it never does).
const DEFAULTS = {
  intervalSec: 45,
  windowChars: 4000,
  clientTimeoutSec: 110,
};
// The first ask comes early: a suggestion in the first minute is what tells the
// operator the feature is alive at all.
const FIRST_TICK_MS = 20000;
const BACKOFF_TICK_MS = 120000;
const FAILURES_BEFORE_BACKOFF = 3;
const MAX_FLAGGED_MEMORY = 50;

let emit = () => {};
let timer = null;
let inFlight = false;
let consecutiveFailures = 0;
let flaggedQuestions = []; // question texts already returned this session
let seenInsights = []; // insight texts already returned this session
let highWaterMark = 0; // transcript length at the last successful call
let cfg = { ...DEFAULTS };
let enabled = true;
let sessionGeneration = 0; // invalidates async work from a previous session

function setEmitter(fn) {
  emit = typeof fn === 'function' ? fn : () => {};
}

/** One quiet line in the rail. `state` drives the styling; `message` the words. */
function status(state, message) {
  emit({ type: 'flag-status', state, message: message || '' });
}

function start() {
  stop();
  const gen = ++sessionGeneration;
  consecutiveFailures = 0;
  flaggedQuestions = [];
  seenInsights = [];
  highWaterMark = 0;
  cfg = { ...DEFAULTS };
  enabled = true;
  status('starting', 'Connecting to the home server…');
  // Configure + warm up, then start ticking. Deliberately not awaited: a slow
  // home server must not delay the recording that is already running.
  prepare(gen);
}

function stop() {
  sessionGeneration += 1;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  inFlight = false;
}

function isCurrent(gen) {
  return gen === sessionGeneration && liveTranscriber.isActive();
}

/**
 * Read the server's settings, then pin the model in VRAM before the first ask.
 *
 * Both steps are best-effort: on failure the loop still runs with the defaults
 * (a cold first call is slow, not broken), but the reason is reported so a
 * misconfigured or unreachable server is visible rather than mysterious.
 */
async function prepare(gen) {
  try {
    const remote = await homeClient.getLiveConfig();
    if (!isCurrent(gen)) return;
    if (remote && remote.enabled === false) {
      enabled = false;
      status('off', 'Live suggestions are switched off on the home server.');
      return;
    }
    cfg = {
      intervalSec: positive(remote && remote.intervalSec, DEFAULTS.intervalSec),
      windowChars: positive(remote && remote.windowChars, DEFAULTS.windowChars),
      clientTimeoutSec: positive(
        remote && remote.clientTimeoutSec,
        DEFAULTS.clientTimeoutSec
      ),
    };
  } catch (err) {
    if (!isCurrent(gen)) return;
    // An older home server has no /live/config: keep the defaults and carry on
    // rather than disabling a feature that may work perfectly well.
    status('waiting', `Using default live settings (${short(err)}).`);
  }

  if (!isCurrent(gen)) return;
  status('listening', 'Listening for questions and insights…');
  schedule(Math.min(FIRST_TICK_MS, cfg.intervalSec * 1000));

  try {
    const warm = await homeClient.postLiveWarmup(cfg.clientTimeoutSec * 1000);
    if (!isCurrent(gen)) return;
    if (warm && warm.ok === false && warm.error) {
      status('error', `The home server's AI could not start: ${short(warm.error)}`);
    }
  } catch (err) {
    if (!isCurrent(gen)) return;
    // Warmup failing usually means the real asks will fail too — say so now
    // rather than after three silent minutes.
    status('error', `The home server's AI is not answering: ${short(err)}`);
  }
}

function positive(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function short(err) {
  const text = String((err && err.message) || err || 'unknown error');
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}

function schedule(delayMs) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(tick, delayMs);
}

async function tick() {
  timer = null;
  const gen = sessionGeneration;
  if (!enabled || !isCurrent(gen)) return; // session ended — loop dies with it
  const nextDelay = () =>
    consecutiveFailures >= FAILURES_BEFORE_BACKOFF
      ? BACKOFF_TICK_MS
      : cfg.intervalSec * 1000;

  if (inFlight) {
    schedule(nextDelay());
    return;
  }

  const fullText = liveTranscriber.getRecentText(Infinity);
  if (fullText.length <= highWaterMark) {
    // Nothing new since the last successful call — skip the network entirely.
    schedule(nextDelay());
    return;
  }

  inFlight = true;
  try {
    status('asking', 'Asking the home server…');
    const result = await homeClient.postLiveQuestions(
      {
        transcriptWindow: fullText.slice(-cfg.windowChars),
        attendees: liveTranscriber.getAttendees(),
        alreadyFlagged: flaggedQuestions.slice(-MAX_FLAGGED_MEMORY),
        alreadyInsights: seenInsights.slice(-MAX_FLAGGED_MEMORY),
      },
      cfg.clientTimeoutSec * 1000
    );
    if (!isCurrent(gen)) return;
    consecutiveFailures = 0;
    highWaterMark = fullText.length;
    const questions = Array.isArray(result && result.questions) ? result.questions : [];
    const insights = (Array.isArray(result && result.insights) ? result.insights : [])
      .map((i) => String(i || '').trim())
      .filter(Boolean);
    if (questions.length > 0 || insights.length > 0) {
      flaggedQuestions.push(...questions.map((q) => String(q.question || '')));
      seenInsights.push(...insights);
      emit({ type: 'flag-candidates', questions, insights });
    }
    status('listening', 'Listening for questions and insights…');
  } catch (err) {
    if (!isCurrent(gen)) return;
    consecutiveFailures += 1;
    // Advisory, so this is a note in the rail and never a dialog — but after
    // repeated failures say that asking has slowed down, so a quiet rail is
    // not mistaken for a quiet meeting.
    status(
      'error',
      consecutiveFailures >= FAILURES_BEFORE_BACKOFF
        ? `Live suggestions are paused — ${short(err)}. Retrying every 2 minutes.`
        : `Last request failed — ${short(err)}. Retrying.`
    );
  } finally {
    inFlight = false;
    if (isCurrent(gen) && enabled) schedule(nextDelay());
  }
}

module.exports = { setEmitter, start, stop };
