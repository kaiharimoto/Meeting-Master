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
// Ordering matters as much as the numbers: the warmup is AWAITED before the
// first ask is scheduled. An ask fired while a cold model is still loading
// queues behind that load inside Ollama and can burn its entire timeout waiting,
// which made the meeting's first suggestion the one most likely to fail.
//
// Three answers from the server are NOT failures and must never be treated as
// such (a backoff would punish the server for behaving correctly):
//   * 503 — switched off. Stop asking and say so.
//   * 409 — a pipeline job holds the GPU. Keep asking on the normal cadence.
//   * too little new transcript — skip the call entirely; nothing to ask about.
//
// Failure contract: NEVER INTERRUPTIVE — no dialogs, no toasts, nothing that
// steals focus or disturbs recording/transcription; the post-meeting extraction
// remains the quality backstop. But no longer SILENT: every state change is
// reported as LIVE_EVENT {type:'flag-status'} and shown as one quiet line in
// the rail. "Working on it", "the home server is unreachable", "it's busy with
// another meeting", "nothing new has been said for six minutes" and "this is
// switched off" are five very different things, and the operator could
// previously not tell any of them apart.

const homeClient = require('./homeClient');
const liveTranscriber = require('./liveTranscriber');

// Used until GET /live/config answers (and if it never does).
const DEFAULTS = {
  intervalSec: 45,
  windowChars: 4000,
  clientTimeoutSec: 110,
};
// The first ask comes early (once the model is warm): a suggestion in the first
// minute is what tells the operator the feature is alive at all.
const FIRST_TICK_MS = 20000;
const BACKOFF_TICK_MS = 120000;
// A "busy" answer is the server working as intended, so it retries sooner than
// a failure and never counts towards the backoff.
const BUSY_RETRY_MS = 45000;
const FAILURES_BEFORE_BACKOFF = 3;
const MAX_FLAGGED_MEMORY = 50;
// Don't spend a GPU call on a trickle of words: below this much new text an ask
// produces either nothing or something invented. ~30 words of speech.
const MIN_NEW_CHARS = 200;
// Re-send a little of the already-mined text so a Q&A pair that straddles two
// asks is still seen whole. Everything before this is text the model already
// read, and re-reading it only invites duplicate suggestions.
const OVERLAP_CHARS = 600;
// After this long with nothing new heard, say so — an unchanging "Listening…"
// reads identically to a broken loop.
const QUIET_NOTICE_MS = 300000;

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
let lastAskAt = 0; // Date.now() of the last completed ask, for the quiet notice
let sessionStartedAt = 0;
// Set when the server answered 409 (a job holds the GPU); clears on the next
// attempt so one busy answer doesn't pin the retry cadence for the meeting.
let busyUntilNextTry = false;

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
  lastAskAt = 0;
  sessionStartedAt = Date.now();
  busyUntilNextTry = false;
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
 * Read the server's settings, pin the model in VRAM, THEN start asking.
 *
 * The warmup is awaited before the first tick is scheduled, and that ordering is
 * the point: a cold 26B model takes tens of seconds to load, so an ask fired
 * during the load queues behind it inside Ollama and can burn its whole timeout
 * waiting — the first suggestion of the meeting, the one that tells the operator
 * this works at all, was the single most likely to fail.
 *
 * Both steps are best-effort: on failure the loop still runs (on defaults, with
 * a cold model), but the reason is reported so a misconfigured or unreachable
 * server is visible rather than mysterious.
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
    if (err && err.status === 503) {
      // An up-to-date server saying "off" — same meaning as enabled:false.
      enabled = false;
      status('off', 'Live suggestions are switched off on the home server.');
      return;
    }
    // An older home server has no /live/config: keep the defaults and carry on
    // rather than disabling a feature that may work perfectly well.
    status('waiting', `Using default live settings (${short(err)}).`);
  }

  if (!isCurrent(gen)) return;
  status('starting', "Getting the home server's AI ready…");

  // What to say once the model is (or isn't) warm. Held rather than emitted
  // inline so exactly one status survives into the listening phase.
  let ready = { state: 'listening', message: LISTENING };
  try {
    const warm = await homeClient.postLiveWarmup(cfg.clientTimeoutSec * 1000);
    if (!isCurrent(gen)) return;
    if (warm && warm.ok === false && warm.error) {
      ready = {
        state: 'error',
        message: `The home server's AI could not start: ${short(warm.error)}`,
      };
    }
  } catch (err) {
    if (!isCurrent(gen)) return;
    if (err && err.status === 409) {
      // A pipeline job holds the GPU. Normal, and it clears on its own.
      ready = { state: 'waiting', message: busyMessage(err) };
    } else if (err && err.status === 503) {
      enabled = false;
      status('off', 'Live suggestions are switched off on the home server.');
      return;
    } else {
      // Warmup failing usually means the real asks will fail too — say so now
      // rather than after three silent minutes.
      ready = {
        state: 'error',
        message: `The home server's AI is not answering: ${short(err)}`,
      };
    }
  }

  if (!isCurrent(gen)) return;
  // The loop starts either way: a server that failed to warm up may still
  // answer, and the ask itself reports honestly if it doesn't.
  status(ready.state, ready.message);
  schedule(Math.min(FIRST_TICK_MS, cfg.intervalSec * 1000));
}

const LISTENING = 'Listening for questions and insights…';

/** The server's own words for why it is busy, or a plain fallback. */
function busyMessage(err) {
  return (
    (err && err.detail) ||
    'The home server is busy with another meeting — retrying shortly.'
  );
}

/** How long since the loop last had something new to ask about. */
function quietFor() {
  return Date.now() - (lastAskAt || sessionStartedAt);
}

/**
 * The quiet notice. "Listening…" that never changes is indistinguishable from a
 * broken loop, and the operator's real question is "is this thing on?" — so say
 * when it last heard something new, in words, not a spinner.
 */
function quietMessage() {
  const minutes = Math.floor(quietFor() / 60000);
  const since = lastAskAt
    ? `Nothing new heard for ${minutes} min`
    : `Waiting for the live transcript (${minutes} min)`;
  return `${since} — still listening.`;
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
  const nextDelay = () => {
    // A busy server clears on its own, so retry on the normal-ish cadence
    // rather than the failure backoff.
    if (busyUntilNextTry) return Math.min(BUSY_RETRY_MS, cfg.intervalSec * 1000);
    return consecutiveFailures >= FAILURES_BEFORE_BACKOFF
      ? BACKOFF_TICK_MS
      : cfg.intervalSec * 1000;
  };

  if (inFlight) {
    schedule(nextDelay());
    return;
  }

  const fullText = liveTranscriber.getRecentText(Infinity);
  if (fullText.length - highWaterMark < MIN_NEW_CHARS) {
    // Not enough new speech to be worth a GPU call. Say so once the silence
    // gets long enough to be mistaken for a broken loop.
    if (quietFor() > QUIET_NOTICE_MS) status('quiet', quietMessage());
    schedule(nextDelay());
    return;
  }

  inFlight = true;
  busyUntilNextTry = false;
  try {
    status('asking', 'Asking the home server…');
    const result = await homeClient.postLiveQuestions(
      {
        // From just before where the last ask finished — not a blind tail
        // slice. The overlap keeps a Q&A pair that straddles two asks intact,
        // while everything the model already mined stays out of the prompt
        // (cheaper, and far less to filter back out as a duplicate).
        transcriptWindow: fullText
          .slice(Math.max(0, highWaterMark - OVERLAP_CHARS))
          .slice(-cfg.windowChars),
        attendees: liveTranscriber.getAttendees(),
        alreadyFlagged: flaggedQuestions.slice(-MAX_FLAGGED_MEMORY),
        alreadyInsights: seenInsights.slice(-MAX_FLAGGED_MEMORY),
      },
      cfg.clientTimeoutSec * 1000
    );
    if (!isCurrent(gen)) return;
    consecutiveFailures = 0;
    highWaterMark = fullText.length;
    lastAskAt = Date.now();
    const questions = Array.isArray(result && result.questions) ? result.questions : [];
    const insights = (Array.isArray(result && result.insights) ? result.insights : [])
      .map((i) => String(i || '').trim())
      .filter(Boolean);
    if (questions.length > 0 || insights.length > 0) {
      flaggedQuestions.push(...questions.map((q) => String(q.question || '')));
      seenInsights.push(...insights);
      emit({ type: 'flag-candidates', questions, insights });
    }
    status('listening', LISTENING);
  } catch (err) {
    if (!isCurrent(gen)) return;
    // "Switched off" and "GPU busy" are the server working correctly, NOT
    // failures: counting them would back the loop off — or in the busy case
    // stop it entirely — for doing the right thing.
    if (err && err.status === 503) {
      enabled = false;
      status('off', 'Live suggestions are switched off on the home server.');
      return;
    }
    if (err && err.status === 409) {
      busyUntilNextTry = true;
      status('waiting', busyMessage(err));
      return; // the finally block reschedules, sooner than a failure would
    }
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
