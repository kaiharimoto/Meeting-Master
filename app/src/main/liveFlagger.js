'use strict';

// Mid-meeting question flagging loop (main-process side).
//
// While live transcription runs, every ~30 s the newest slice of live text
// goes to the home server's POST /live/questions (Ollama on the home PC);
// returned candidates are pushed to the renderer as LIVE_EVENT
// {type:'flag-candidates'} for the inline approve/dismiss list.
//
// Failure contract: SILENT. Live flagging is advisory — if the home server
// or Tailscale is down mid-meeting, ticks are skipped (with backoff so dead
// networks aren't hammered) and the post-meeting extraction catches
// everything. Nothing here may ever surface an error to the operator or
// disturb recording/transcription.

const homeClient = require('./homeClient');
const liveTranscriber = require('./liveTranscriber');

const TICK_MS = 30000;
const BACKOFF_TICK_MS = 120000;
const FAILURES_BEFORE_BACKOFF = 3;
const WINDOW_CHARS = 8000;
const MAX_FLAGGED_MEMORY = 50;

let emit = () => {};
let timer = null;
let inFlight = false;
let consecutiveFailures = 0;
let flaggedQuestions = []; // question texts already returned this session
let highWaterMark = 0; // transcript length at the last successful call

function setEmitter(fn) {
  emit = typeof fn === 'function' ? fn : () => {};
}

function start() {
  stop();
  consecutiveFailures = 0;
  flaggedQuestions = [];
  highWaterMark = 0;
  schedule(TICK_MS);
}

function stop() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  inFlight = false;
}

function schedule(delayMs) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(tick, delayMs);
}

async function tick() {
  timer = null;
  if (!liveTranscriber.isActive()) return; // session ended — loop dies with it
  const nextDelay = () =>
    consecutiveFailures >= FAILURES_BEFORE_BACKOFF ? BACKOFF_TICK_MS : TICK_MS;

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
    const result = await homeClient.postLiveQuestions({
      transcriptWindow: fullText.slice(-WINDOW_CHARS),
      attendees: liveTranscriber.getAttendees(),
      alreadyFlagged: flaggedQuestions.slice(-MAX_FLAGGED_MEMORY),
    });
    consecutiveFailures = 0;
    highWaterMark = fullText.length;
    const questions = Array.isArray(result && result.questions) ? result.questions : [];
    if (questions.length > 0) {
      flaggedQuestions.push(...questions.map((q) => String(q.question || '')));
      emit({ type: 'flag-candidates', questions });
    }
  } catch {
    consecutiveFailures += 1; // silent by contract
  } finally {
    inFlight = false;
    if (liveTranscriber.isActive()) schedule(nextDelay());
  }
}

module.exports = { setEmitter, start, stop };
