'use strict';

// The mid-meeting suggestion loop, which lives entirely in the main process and
// is therefore invisible to every Playwright spec (those drive plain Chromium
// with window.api stubbed). Its whole job is to talk to the home server on a
// timer, so what is worth asserting is the numbers and the ORDER it talks in —
// and both of those are why the feature appeared not to work:
//
//   * the client's HTTP timeout was hard-coded to 45 s while the server allowed
//     itself 60 s, so a home PC running a big model failed EVERY ask from the
//     client side while answering perfectly well; and
//   * the first ask raced the model warmup, so the one suggestion that tells the
//     operator this works at all was the most likely to time out.
//
// Both collaborators are stubbed through the require cache, so no Electron and
// no network are involved.

const test = require('node:test');
const assert = require('node:assert');

const HOME_CLIENT = require.resolve('../../src/main/homeClient');
const TRANSCRIBER = require.resolve('../../src/main/liveTranscriber');
const FLAGGER = require.resolve('../../src/main/liveFlagger');

// Enough speech to be worth a GPU call (the loop skips a trickle), and longer
// than the re-ask overlap so "don't re-send mined text" is a real assertion.
const SPEECH = 'Priya: what did the renewal quote come back at? '.repeat(40);

/** Let every pending promise chain in the loop run to completion. */
async function settle() {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

/**
 * Load liveFlagger with stubbed collaborators.
 *
 * `serverConfig` is what GET /live/config answers (null => the request fails,
 * which is how an older home server behaves). `warmup`/`ask` may be an Error to
 * throw — set `.status` on it to model an HTTP status the loop must act on.
 */
function loadFlagger({
  serverConfig,
  transcript = '',
  questionsReply,
  askError,
  warmupError,
  warmupResult,
}) {
  const calls = { config: 0, warmup: [], questions: [] };
  const order = []; // 'config' | 'warmup' | 'ask' — the sequence matters
  // Mutable: the loop deliberately skips an ask when too little new text has
  // arrived, so a test that wants a second ask must give it something new.
  const draft = { text: transcript };
  const events = [];

  const stub = (path, exports) => {
    require.cache[path] = { id: path, filename: path, loaded: true, exports };
  };

  stub(HOME_CLIENT, {
    async getLiveConfig() {
      calls.config += 1;
      order.push('config');
      if (!serverConfig) throw new Error('Not Found');
      return serverConfig;
    },
    async postLiveWarmup(timeoutMs) {
      calls.warmup.push(timeoutMs);
      order.push('warmup');
      if (warmupError) throw warmupError;
      return warmupResult || { ok: true, model: 'stub-model', error: null };
    },
    async postLiveQuestions(payload, timeoutMs) {
      calls.questions.push({ payload, timeoutMs });
      order.push('ask');
      if (askError) throw askError;
      return questionsReply || { questions: [], insights: [] };
    },
  });

  stub(TRANSCRIBER, {
    isActive: () => true,
    getRecentText: () => draft.text,
    getAttendees: () => ['Priya', 'Marcus'],
  });

  delete require.cache[FLAGGER];
  const flagger = require(FLAGGER);
  flagger.setEmitter((payload) => events.push(payload));
  return { flagger, calls, events, draft, order };
}

/** start() + the async prepare() it kicks off, without the first ask yet. */
async function startAndPrepare(harness) {
  harness.flagger.start();
  await settle();
}

/** Advance to (and through) the next scheduled ask. */
async function runTick(t, ms) {
  t.mock.timers.tick(ms);
  await settle();
}

const statuses = (events) => events.filter((e) => e.type === 'flag-status');
const lastStatus = (events) => statuses(events).at(-1);

test.afterEach(() => {
  delete require.cache[HOME_CLIENT];
  delete require.cache[TRANSCRIBER];
  delete require.cache[FLAGGER];
});

const SERVER_CONFIG = {
  enabled: true,
  intervalSec: 30,
  windowChars: 4000,
  timeoutSec: 60,
  clientTimeoutSec: 80,
  model: 'stub-model',
};

const httpError = (status, detail) => {
  const err = new Error(`Home server returned ${status}`);
  err.status = status;
  err.detail = detail || '';
  return err;
};

test('the loop takes its interval, window and timeout from the home server', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const h = loadFlagger({
    serverConfig: { ...SERVER_CONFIG, windowChars: 100 },
    transcript: SPEECH,
  });

  await startAndPrepare(h);
  assert.strictEqual(h.calls.config, 1);

  await runTick(t, 20000); // the first ask comes early, not after a full interval
  assert.strictEqual(h.calls.questions.length, 1, 'one ask after the first tick');
  const ask = h.calls.questions[0];
  // The window is the server's, not a laptop-side constant…
  assert.strictEqual(ask.payload.transcriptWindow.length, 100);
  // …and so is the timeout, which MUST exceed the server's own budget.
  assert.strictEqual(ask.timeoutMs, 80000);
  assert.ok(
    ask.timeoutMs > SERVER_CONFIG.timeoutSec * 1000,
    'the client must be the more patient of the two'
  );
  h.flagger.stop();
});

test('the model is warmed up BEFORE the first ask, never alongside it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const h = loadFlagger({ serverConfig: SERVER_CONFIG, transcript: SPEECH });

  await startAndPrepare(h);
  // Warmup has already run, and no ask has been scheduled behind it yet: an ask
  // fired during a cold model load queues inside Ollama and burns its timeout.
  assert.deepStrictEqual(h.order, ['config', 'warmup']);
  assert.deepStrictEqual(h.calls.warmup, [80000], 'warmup gets the full budget');

  await runTick(t, 20000);
  assert.deepStrictEqual(h.order, ['config', 'warmup', 'ask']);
  h.flagger.stop();
});

test('an ask covers where the last one left off, with overlap — not a blind tail', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const h = loadFlagger({ serverConfig: SERVER_CONFIG, transcript: SPEECH });

  await startAndPrepare(h);
  await runTick(t, 20000);
  const firstEnd = SPEECH.length;

  // The meeting continues; the next ask must not re-send the whole transcript.
  const fresh = 'Marcus: twelve percent, locked for twenty-four months. '.repeat(6);
  h.draft.text += fresh;
  await runTick(t, 30000);

  assert.strictEqual(h.calls.questions.length, 2);
  const second = h.calls.questions[1].payload.transcriptWindow;
  assert.ok(second.endsWith(fresh.slice(-40)), 'it reaches the newest speech');
  assert.ok(
    second.length < h.draft.text.length,
    'it does not re-send text the model already mined'
  );
  // …but it does overlap, so a Q&A pair split across two asks survives whole.
  assert.ok(second.length > fresh.length, 'the overlap is there');
  assert.ok(
    h.draft.text.slice(firstEnd - 100, firstEnd).slice(-40).length > 0 &&
      second.includes(h.draft.text.slice(firstEnd - 40, firstEnd)),
    'the overlap comes from just before the previous ask ended'
  );
  h.flagger.stop();
});

test('a trickle of speech is not worth a GPU call, and the rail says why', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const h = loadFlagger({ serverConfig: SERVER_CONFIG, transcript: 'Priya: mm.' });

  await startAndPrepare(h);
  await runTick(t, 20000);
  assert.strictEqual(h.calls.questions.length, 0, 'ten characters buys nothing');

  // Minutes of near-silence: an unchanging "Listening…" reads exactly like a
  // broken loop, so the loop volunteers how long it has been quiet.
  for (let i = 0; i < 12; i += 1) await runTick(t, 30000);
  const quiet = statuses(h.events).find((e) => e.state === 'quiet');
  assert.ok(quiet, 'the quiet notice appears');
  assert.match(quiet.message, /still listening/i);
  assert.strictEqual(h.calls.questions.length, 0);
  h.flagger.stop();
});

test('suggestions already offered are never asked about twice', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const h = loadFlagger({
    serverConfig: SERVER_CONFIG,
    transcript: SPEECH,
    questionsReply: {
      questions: [{ question: 'What did the quote come back at?', answer: 'Twelve percent.' }],
      insights: ['Chase the vendor earlier next time.'],
    },
  });

  await startAndPrepare(h);
  await runTick(t, 20000);

  const candidates = h.events.find((e) => e.type === 'flag-candidates');
  assert.ok(candidates, 'questions AND insights reach the renderer');
  assert.strictEqual(candidates.questions.length, 1);
  assert.deepStrictEqual(candidates.insights, ['Chase the vendor earlier next time.']);

  h.draft.text += SPEECH; // the conversation moves on
  await runTick(t, 30000);
  assert.strictEqual(h.calls.questions.length, 2, 'new text produces a second ask');
  const latest = h.calls.questions[1].payload;
  assert.deepStrictEqual(latest.alreadyFlagged, ['What did the quote come back at?']);
  assert.deepStrictEqual(latest.alreadyInsights, ['Chase the vendor earlier next time.']);
  h.flagger.stop();
});

test('"switched off" is reported and asked about zero times', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const h = loadFlagger({
    serverConfig: { ...SERVER_CONFIG, enabled: false },
    transcript: SPEECH,
  });

  await startAndPrepare(h);
  await runTick(t, 120000);

  assert.strictEqual(h.calls.questions.length, 0, 'a disabled loop never asks');
  assert.strictEqual(h.calls.warmup.length, 0, 'and never warms a model up');
  const off = h.events.find((e) => e.type === 'flag-status' && e.state === 'off');
  assert.ok(off && /switched off/i.test(off.message), 'the operator is told why');
  h.flagger.stop();
});

test('switching the feature off mid-meeting stops the loop instead of failing it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const h = loadFlagger({
    serverConfig: SERVER_CONFIG,
    transcript: SPEECH,
    askError: httpError(503, 'Live suggestions are turned off on the home server.'),
  });

  await startAndPrepare(h);
  await runTick(t, 20000);
  assert.strictEqual(h.calls.questions.length, 1);
  assert.strictEqual(lastStatus(h.events).state, 'off');

  // No further asks — a 503 is an answer, not something to retry into forever.
  h.draft.text += SPEECH;
  await runTick(t, 60000);
  await runTick(t, 60000);
  assert.strictEqual(h.calls.questions.length, 1);
  h.flagger.stop();
});

test('a busy GPU is "waiting", not a failure: it retries and never backs off', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const busy = httpError(
    409,
    "The home server's GPU is busy processing another meeting (transcribing)."
  );
  const h = loadFlagger({ serverConfig: SERVER_CONFIG, transcript: SPEECH, askError: busy });

  await startAndPrepare(h);
  // Three busy answers in a row would trip the failure backoff if they counted.
  await runTick(t, 20000);
  h.draft.text += SPEECH;
  await runTick(t, 45000);
  h.draft.text += SPEECH;
  await runTick(t, 45000);

  assert.strictEqual(h.calls.questions.length, 3, 'it keeps asking on the normal cadence');
  const waiting = statuses(h.events).filter((e) => e.state === 'waiting');
  assert.ok(waiting.length >= 3, 'each one is reported as waiting, not failing');
  assert.match(waiting.at(-1).message, /busy processing another meeting/);
  assert.ok(
    !statuses(h.events).some((e) => e.state === 'error'),
    'a server doing the right thing must never look like an error'
  );

  // And it recovers on its own the moment the job finishes.
  h.flagger.stop();
});

test('a failing ask is reported in the rail, never silently', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const h = loadFlagger({
    serverConfig: SERVER_CONFIG,
    transcript: SPEECH,
    askError: new Error('The home server did not respond in time.'),
  });

  await startAndPrepare(h);
  await runTick(t, 20000);

  const err = statuses(h.events).find((e) => e.state === 'error');
  assert.ok(err, 'a failed ask produces a status the rail can show');
  assert.match(err.message, /did not respond in time/);
  // Advisory means non-interruptive, NOT invisible: no other event type is
  // emitted, so nothing can steal focus mid-meeting.
  assert.deepStrictEqual(
    [...new Set(h.events.map((e) => e.type))],
    ['flag-status'],
    'the loop only ever emits status and candidates'
  );
  h.flagger.stop();
});

test('a warmup that fails still lets the asks run, and says so', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const h = loadFlagger({
    serverConfig: SERVER_CONFIG,
    transcript: SPEECH,
    warmupResult: { ok: false, model: 'stub-model', error: 'model not found' },
  });

  await startAndPrepare(h);
  const warned = statuses(h.events).find((e) => e.state === 'error');
  assert.ok(warned && /could not start/.test(warned.message), 'reported at once');

  await runTick(t, 20000);
  assert.strictEqual(h.calls.questions.length, 1, 'a cold model is slow, not broken');
  h.flagger.stop();
});

test('an older home server with no /live/config still runs, on defaults', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const h = loadFlagger({ serverConfig: null, transcript: SPEECH });

  await startAndPrepare(h);
  await runTick(t, 20000);

  assert.strictEqual(h.calls.questions.length, 1, 'the loop degrades, it does not stop');
  // The default client timeout still beats the server's default budget (90 s).
  assert.ok(h.calls.questions[0].timeoutMs > 90000);
  assert.ok(
    statuses(h.events).some((e) => /default live settings/.test(e.message)),
    'and says it is guessing'
  );
  h.flagger.stop();
});

test('stopping the session ends the loop, in flight or not', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const h = loadFlagger({ serverConfig: SERVER_CONFIG, transcript: SPEECH });

  await startAndPrepare(h);
  await runTick(t, 20000);
  assert.strictEqual(h.calls.questions.length, 1);

  h.flagger.stop();
  h.draft.text += SPEECH;
  await runTick(t, 60000);
  await runTick(t, 60000);
  assert.strictEqual(h.calls.questions.length, 1, 'no ask outlives the recording');
});

test('the home client really exposes the three live endpoints', () => {
  // The loop above talks to a stub, so nothing in this file would notice the
  // real client missing a function or pointing at the wrong path.
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'main', 'homeClient.js'),
    'utf8'
  );
  for (const route of ['/live/config', '/live/warmup', '/live/questions']) {
    assert.ok(source.includes(route), `homeClient must call ${route}`);
  }
  assert.match(
    source,
    /module\.exports = \{[^}]*getLiveConfig[^}]*postLiveWarmup[^}]*\}/s,
    'and export both new calls'
  );
  // The ask's timeout is a parameter, not a constant: the hard-coded one is
  // what made every ask fail against a slower-but-healthy home server.
  assert.match(source, /async function postLiveQuestions\(payload, timeoutMs\)/);
  // And the status reaches the loop as a number, which is how "busy" and
  // "switched off" stay distinguishable from a real failure.
  assert.match(source, /err\.status = res\.status;/);
});
