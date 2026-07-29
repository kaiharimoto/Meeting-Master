'use strict';

// The mid-meeting suggestion loop, which lives entirely in the main process and
// is therefore invisible to every Playwright spec (those drive plain Chromium
// with window.api stubbed). Its whole job is to talk to the home server on a
// timer, so the things worth asserting are the numbers it talks with — and one
// of those numbers is exactly why the feature appeared not to work at all:
//
//   the client's HTTP timeout was hard-coded to 45 s while the server allowed
//   itself 60 s, so a home PC running a big model failed EVERY ask from the
//   client side while answering perfectly well.
//
// Both collaborators are stubbed through the require cache, so no Electron and
// no network are involved.

const test = require('node:test');
const assert = require('node:assert');

const HOME_CLIENT = require.resolve('../../src/main/homeClient');
const TRANSCRIBER = require.resolve('../../src/main/liveTranscriber');
const FLAGGER = require.resolve('../../src/main/liveFlagger');

/**
 * Load liveFlagger with stubbed collaborators.
 *
 * `serverConfig` is what GET /live/config answers (null => the request fails,
 * which is how an older home server behaves). Returns the loop plus the calls
 * and status events it produced.
 */
function loadFlagger({ serverConfig, transcript = '', questionsReply, questionsError }) {
  const calls = { config: 0, warmup: [], questions: [] };
  // Mutable: the loop deliberately skips an ask when no new text has arrived,
  // so a test that wants a second ask has to give it something new to read.
  const draft = { text: transcript };
  const events = [];

  const stub = (path, exports) => {
    require.cache[path] = { id: path, filename: path, loaded: true, exports };
  };

  stub(HOME_CLIENT, {
    async getLiveConfig() {
      calls.config += 1;
      if (!serverConfig) throw new Error('Not Found');
      return serverConfig;
    },
    async postLiveWarmup(timeoutMs) {
      calls.warmup.push(timeoutMs);
      return { ok: true, model: 'stub-model', error: null };
    },
    async postLiveQuestions(payload, timeoutMs) {
      calls.questions.push({ payload, timeoutMs });
      if (questionsError) throw new Error(questionsError);
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
  return { flagger, calls, events, draft };
}

test.afterEach(() => {
  delete require.cache[HOME_CLIENT];
  delete require.cache[TRANSCRIBER];
  delete require.cache[FLAGGER];
});

const SERVER_CONFIG = {
  enabled: true,
  intervalSec: 30,
  windowChars: 100,
  timeoutSec: 60,
  clientTimeoutSec: 80,
  model: 'stub-model',
};

test('the loop takes its interval, window and timeout from the home server', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const long = 'x'.repeat(500);
  const { flagger, calls } = loadFlagger({
    serverConfig: SERVER_CONFIG,
    transcript: long,
    questionsReply: { questions: [], insights: [] },
  });

  flagger.start();
  await new Promise(queueMicrotask); // let prepare() read the config
  await new Promise(queueMicrotask);
  assert.strictEqual(calls.config, 1);

  t.mock.timers.tick(20000); // the first ask comes early, not after a full interval
  await new Promise(queueMicrotask);
  await new Promise(queueMicrotask);

  assert.strictEqual(calls.questions.length, 1, 'one ask after the first tick');
  const ask = calls.questions[0];
  // The window is the server's, not a laptop-side constant…
  assert.strictEqual(ask.payload.transcriptWindow.length, 100);
  // …and so is the timeout, which MUST exceed the server's own budget.
  assert.strictEqual(ask.timeoutMs, 80000);
  assert.ok(
    ask.timeoutMs > SERVER_CONFIG.timeoutSec * 1000,
    'the client must be the more patient of the two'
  );
  // Warmup is what stops the first real ask paying for a cold model load.
  assert.deepStrictEqual(calls.warmup, [80000]);
  flagger.stop();
});

test('suggestions already offered are never asked about twice', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { flagger, calls, events, draft } = loadFlagger({
    serverConfig: SERVER_CONFIG,
    transcript: 'Priya: what did the quote come back at? Marcus: twelve percent.',
    questionsReply: {
      questions: [{ question: 'What did the quote come back at?', answer: 'Twelve percent.' }],
      insights: ['Chase the vendor earlier next time.'],
    },
  });

  flagger.start();
  await new Promise(queueMicrotask);
  await new Promise(queueMicrotask);
  t.mock.timers.tick(20000);
  await new Promise(queueMicrotask);
  await new Promise(queueMicrotask);

  const candidates = events.find((e) => e.type === 'flag-candidates');
  assert.ok(candidates, 'questions AND insights reach the renderer');
  assert.strictEqual(candidates.questions.length, 1);
  assert.deepStrictEqual(candidates.insights, ['Chase the vendor earlier next time.']);

  // A later ask carries both memories, so the rail cannot repeat itself. (The
  // conversation has to move on first — an ask with nothing new to read is
  // skipped before it reaches the network.)
  draft.text += ' Priya: and when does the migration finish?';
  t.mock.timers.tick(30000);
  await new Promise(queueMicrotask);
  await new Promise(queueMicrotask);
  assert.strictEqual(calls.questions.length, 2, 'new text produces a second ask');
  const latest = calls.questions[calls.questions.length - 1].payload;
  assert.deepStrictEqual(latest.alreadyFlagged, ['What did the quote come back at?']);
  assert.deepStrictEqual(latest.alreadyInsights, ['Chase the vendor earlier next time.']);
  flagger.stop();
});

test('"switched off" is reported and asked about zero times', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { flagger, calls, events } = loadFlagger({
    serverConfig: { ...SERVER_CONFIG, enabled: false },
    transcript: 'some text',
  });

  flagger.start();
  await new Promise(queueMicrotask);
  await new Promise(queueMicrotask);
  t.mock.timers.tick(120000);
  await new Promise(queueMicrotask);

  assert.strictEqual(calls.questions.length, 0, 'a disabled loop never asks');
  assert.strictEqual(calls.warmup.length, 0);
  const off = events.find((e) => e.type === 'flag-status' && e.state === 'off');
  assert.ok(off && /switched off/i.test(off.message), 'the operator is told why');
  flagger.stop();
});

test('a failing ask is reported in the rail, never silently', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { flagger, events } = loadFlagger({
    serverConfig: SERVER_CONFIG,
    transcript: 'some text',
    questionsError: 'The home server did not respond in time.',
  });

  flagger.start();
  await new Promise(queueMicrotask);
  await new Promise(queueMicrotask);
  t.mock.timers.tick(20000);
  await new Promise(queueMicrotask);
  await new Promise(queueMicrotask);

  const err = events.find((e) => e.type === 'flag-status' && e.state === 'error');
  assert.ok(err, 'a failed ask produces a status the rail can show');
  assert.match(err.message, /did not respond in time/);
  // Advisory means non-interruptive, NOT invisible: no other event type is
  // emitted, so nothing can steal focus mid-meeting.
  assert.deepStrictEqual(
    [...new Set(events.map((e) => e.type))],
    ['flag-status'],
    'the loop only ever emits status and candidates'
  );
  flagger.stop();
});

test('an older home server with no /live/config still runs, on defaults', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { flagger, calls, events } = loadFlagger({
    serverConfig: null, // GET /live/config 404s
    transcript: 'some text',
  });

  flagger.start();
  await new Promise(queueMicrotask);
  await new Promise(queueMicrotask);
  t.mock.timers.tick(20000);
  await new Promise(queueMicrotask);
  await new Promise(queueMicrotask);

  assert.strictEqual(calls.questions.length, 1, 'the loop degrades, it does not stop');
  // The default client timeout still beats the server's default budget (90 s).
  assert.ok(calls.questions[0].timeoutMs > 90000);
  assert.ok(events.some((e) => e.type === 'flag-status' && /default live settings/.test(e.message)));
  flagger.stop();
});

test('the home client really exposes the three live endpoints', () => {
  // The loop above talks to a stub, so nothing in this file would notice the
  // real client missing a function or pointing at the wrong path.
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main', 'homeClient.js'), 'utf8');
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
});
