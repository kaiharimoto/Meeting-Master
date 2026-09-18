'use strict';

// The meeting progress map: what it is, where it lives, and how it grows.
//
// While live transcription runs, the newest slice of draft transcript goes to
// the home server's POST /live/map alongside a DIGEST of the map so far, and
// what comes back is a list of CHANGES — not a new map. Those changes are
// applied here, in the main process, and the result is pushed to the operator
// window and the pop-out map window as MAP_STATE.
//
// Why the map lives HERE and not in the renderer's ctx.state:
//   * Two windows need it. The pop-out is the one the operator watches; the
//     operator window needs enough to render its button. One owner, two
//     subscribers.
//   * ctx.state is persisted to localStorage on every change. A map that grew
//     a node every 90 seconds would be written to disk all meeting, and — far
//     worse — a half-built map would survive a restart into a DIFFERENT
//     meeting, because loadState() merges by top-level key.
//   * It is derived from the live draft transcript, which is itself a
//     main-process module-local that dies with the session. The map belongs on
//     the same side of that line: it is live-only, never persisted, never part
//     of the meeting record, and never seen by the AI that writes the notes.
//
// Why CHANGES rather than a fresh map each tick — the two reasons that matter
// more than the token saving:
//   * Stability. A re-emitted map has new ids every tick, so nodes jump and the
//     operator loses their place in a thing they are watching from across a
//     desk.
//   * Shape. Re-emission costs tokens in proportion to meeting length, so the
//     second hour of a meeting would be the one that stops working. The digest
//     is bounded by TOPIC COUNT instead: full detail for the newest topics, one
//     rollup line each for the rest.
//
// The model is not trusted with ids. An op is applied only if it resolves
// against what we actually hold; see applyOps for the rules. A confused op
// costs one op, never the tick.

const homeClient = require('./homeClient');
const liveTranscriber = require('./liveTranscriber');
const gpuLock = require('./liveGpuLock');

// Used until GET /live/config answers (and if it never does).
const DEFAULTS = {
  intervalSec: 90,
  windowChars: 6000,
  digestChars: 3000,
  clientTimeoutSec: 110,
};
// Later than the questions loop's first tick: the map wants enough speech to
// have an actual topic in it, and a map whose first drawing is one vague node
// is worse than a map that appears a minute in already saying something.
const FIRST_TICK_MS = 45000;
const BACKOFF_TICK_MS = 180000;
const BUSY_RETRY_MS = 60000;
const FAILURES_BEFORE_BACKOFF = 3;
// A topic shift needs more new speech to be visible than a Q&A pair does.
const MIN_NEW_CHARS = 400;
const OVERLAP_CHARS = 400;

// Caps. Past these the map stops being glanceable, which is its whole job.
const MAX_TOPICS = 24;
const MAX_NODES_PER_TOPIC = 12;
const MAX_LINKS = 80;

// How many topics stay at each level of detail, newest first. Everything past
// the end is a seam — a single bar with a rollup behind it.
const LIVE_TOPICS = 1;
const WARM_TOPICS = 2;
const COLD_TOPICS = 3;

const NODE_KINDS = new Set([
  'point', 'question', 'decision', 'action', 'risk', 'disagreement',
]);
const NODE_STATUSES = new Set(['open', 'resolved', 'parked']);
const LINK_KINDS = new Set(['leads_to', 'answers', 'contradicts', 'supports']);

let emit = () => {};
let timer = null;
let inFlight = false;
let consecutiveFailures = 0;
let highWaterMark = 0;
let cfg = { ...DEFAULTS };
let enabled = true;
let sessionGeneration = 0;
let busyUntilNextTry = false;
let tickSerial = 0;
// Ids sent in the last digest. An op naming one of these MEANS that item; an op
// naming anything else is treated as new, whatever it collides with.
let digestIds = new Set();

let map = emptyMap();
let loopStatus = { state: 'idle', message: '' };

function emptyMap() {
  return { topics: [], links: [], rev: 0 };
}

function setEmitter(fn) {
  emit = typeof fn === 'function' ? fn : () => {};
}

function status(state, message) {
  loopStatus = { state, message: message || '' };
  push();
}

/** The whole map, plus the loop's status, to whoever is listening. */
function push() {
  emit({ map: withRanks(map), status: loopStatus, live: liveTranscriber.isActive() });
}

/** The current snapshot, for a window that opened mid-meeting (MAP_GET). */
function getState() {
  return { map: withRanks(map), status: loopStatus, live: liveTranscriber.isActive() };
}

/**
 * Age-rank every topic: live / warm / cold / seam, newest first.
 *
 * Computed HERE rather than in the renderer so both windows agree, and so the
 * rule is testable without a DOM. Layout compression is deterministic and
 * instant; the SEMANTIC compression — the one sentence a collapsed topic shows
 * — rides on every topic op, so a topic already has its rollup the moment it
 * goes cold. No round trip, no "awaiting rollup" state to get stuck in.
 */
function withRanks(source) {
  const total = source.topics.length;
  const topics = source.topics.map((topic, index) => {
    const fromEnd = total - 1 - index; // 0 = newest
    let rank = 'seam';
    if (fromEnd < LIVE_TOPICS) rank = 'live';
    else if (fromEnd < LIVE_TOPICS + WARM_TOPICS) rank = 'warm';
    else if (fromEnd < LIVE_TOPICS + WARM_TOPICS + COLD_TOPICS) rank = 'cold';
    return { ...topic, rank };
  });
  return { topics, links: source.links, rev: source.rev };
}

// ---- Op application ---------------------------------------------------------

function findTopic(id) {
  return map.topics.find((t) => t.id === id) || null;
}

function findNode(id) {
  for (const topic of map.topics) {
    const node = topic.nodes.find((n) => n.id === id);
    if (node) return { topic, node };
  }
  return null;
}

/** A free id derived from one the model reused for something new. */
function mintId(wanted) {
  return `${wanted || 'x'}~${tickSerial}`;
}

function text(value, max) {
  const out = String(value == null ? '' : value).trim().replace(/\s+/g, ' ');
  return max && out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

/**
 * Apply the server's ops to the map. Returns how many actually landed.
 *
 * The id rule, which is the whole reason a small model can drive this:
 *   * An id WE SENT in the digest means that item — update it.
 *   * Any other id is something new, even if it collides with an item we hold
 *     but did not show (a node inside a collapsed topic). It gets a minted id.
 * So a model that emits "n1" every single tick cannot overwrite earlier nodes,
 * and a model that echoes the ids it was shown updates exactly what it meant.
 */
function applyOps(ops) {
  let changed = 0;
  for (const op of Array.isArray(ops) ? ops : []) {
    if (!op || typeof op !== 'object') continue;
    switch (op.op) {
      case 'topic':
        changed += applyTopic(op) ? 1 : 0;
        break;
      case 'node':
        changed += applyNode(op) ? 1 : 0;
        break;
      case 'link':
        changed += applyLink(op) ? 1 : 0;
        break;
      case 'status':
        changed += applyStatus(op) ? 1 : 0;
        break;
      default:
        break; // unknown op — drop it, not the tick
    }
  }
  if (changed > 0) {
    enforceCaps();
    map.rev += 1;
  }
  return changed;
}

function applyTopic(op) {
  const id = String(op.id || '').trim();
  if (!id) return false;
  const title = text(op.title, 60);
  const rollup = text(op.rollup, 240);
  const existing = digestIds.has(id) ? findTopic(id) : null;
  if (existing) {
    if (title) existing.title = title;
    // A rollup is only ever replaced by a non-empty one: a tick that omits it
    // must not blank the sentence a collapsed topic is relying on.
    if (rollup) existing.rollup = rollup;
    return Boolean(title || rollup);
  }
  if (!title) return false; // a new topic with no name is not a topic
  const fresh = {
    id: findTopic(id) ? mintId(id) : id,
    title,
    rollup,
    nodes: [],
    isNew: true,
  };
  map.topics.push(fresh);
  digestIds.add(fresh.id);
  return true;
}

function applyNode(op) {
  const id = String(op.id || '').trim();
  const body = text(op.text, 160);
  if (!id || !body) return false;

  const existing = digestIds.has(id) ? findNode(id) : null;
  if (existing) {
    existing.node.text = body;
    if (NODE_KINDS.has(op.kind)) existing.node.kind = op.kind;
    return true;
  }

  // Which topic does it belong to? A node naming a topic we do not hold is
  // attached to the NEWEST topic rather than dropped: it was said just now, and
  // "just now" is what the newest topic is. Dropping it would lose something
  // the meeting actually contained over an id the model got slightly wrong.
  const named = String(op.topic || '').trim();
  const topic = (named && findTopic(named)) || map.topics[map.topics.length - 1];
  if (!topic) return false; // nothing said yet has been given a subject

  topic.nodes.push({
    id: findNode(id) ? mintId(id) : id,
    kind: NODE_KINDS.has(op.kind) ? op.kind : 'point',
    text: body,
    status: 'open',
    isNew: true,
  });
  digestIds.add(topic.nodes[topic.nodes.length - 1].id);
  return true;
}

function applyLink(op) {
  const from = String(op.from || '').trim();
  const to = String(op.to || '').trim();
  if (!from || !to || from === to) return false;
  // Both ends must be nodes we actually hold — a link to nothing draws an arc
  // to nowhere, which is worse than no arc.
  if (!findNode(from) || !findNode(to)) return false;
  if (map.links.some((l) => l.from === from && l.to === to)) return false;
  map.links.push({
    from,
    to,
    kind: LINK_KINDS.has(op.kind) ? op.kind : 'leads_to',
  });
  return true;
}

function applyStatus(op) {
  const id = String(op.id || '').trim();
  if (!id || !NODE_STATUSES.has(op.status)) return false;
  const found = findNode(id);
  if (!found) return false;
  if (found.node.status === op.status) return false;
  found.node.status = op.status;
  return true;
}

/** Hard ceilings, oldest first. A map past these has stopped being readable. */
function enforceCaps() {
  for (const topic of map.topics) {
    if (topic.nodes.length > MAX_NODES_PER_TOPIC) {
      topic.nodes.splice(0, topic.nodes.length - MAX_NODES_PER_TOPIC);
    }
  }
  if (map.topics.length > MAX_TOPICS) {
    map.topics.splice(0, map.topics.length - MAX_TOPICS);
  }
  // Links whose endpoints fell off the end would draw to nowhere.
  const nodeIds = new Set();
  for (const topic of map.topics) for (const node of topic.nodes) nodeIds.add(node.id);
  map.links = map.links.filter((l) => nodeIds.has(l.from) && nodeIds.has(l.to));
  if (map.links.length > MAX_LINKS) {
    map.links.splice(0, map.links.length - MAX_LINKS);
  }
}

// ---- The digest -------------------------------------------------------------

/**
 * The map as the model sees it: full detail for what is current, one line each
 * for what is not.
 *
 * This is the function that keeps the feature affordable. Its output is bounded
 * by how many TOPICS a meeting has, not by how long it has run, so a two-hour
 * meeting costs the same per tick as a ten-minute one. It also records which
 * ids were shown (digestIds), which is what makes "an id I sent means that
 * item" a rule the apply step can rely on.
 */
function buildDigest(limitChars) {
  const ranked = withRanks(map);
  digestIds = new Set();
  const lines = [];
  for (const topic of ranked.topics) {
    digestIds.add(topic.id);
    const detailed = topic.rank === 'live' || topic.rank === 'warm';
    lines.push(
      detailed
        ? `${topic.id} "${topic.title}" — ${topic.rollup || '(no summary yet)'}`
        : `${topic.id} "${topic.title}" (collapsed) — ${topic.rollup || '(no summary yet)'}`
    );
    if (!detailed) continue;
    for (const node of topic.nodes) {
      digestIds.add(node.id);
      lines.push(`   ${node.id} ${node.kind} ${node.status}  ${node.text}`);
    }
  }
  // Trim from the TOP when too long: those are the coldest topics, already one
  // line each, and the least likely to be what is being said right now.
  let out = lines.join('\n');
  while (out.length > limitChars && lines.length > 1) {
    lines.shift();
    out = lines.join('\n');
  }
  return out;
}

// ---- The loop ---------------------------------------------------------------

function start() {
  stop();
  const gen = ++sessionGeneration;
  consecutiveFailures = 0;
  highWaterMark = 0;
  tickSerial = 0;
  cfg = { ...DEFAULTS };
  enabled = true;
  busyUntilNextTry = false;
  digestIds = new Set();
  map = emptyMap();
  status('starting', 'Waiting for the meeting to get going…');
  prepare(gen);
}

/**
 * Stop asking. The MAP ITSELF SURVIVES, deliberately.
 *
 * The mini recording strip closes itself when recording ends, because its job
 * is done. The map's job is not: the operator wants to read what the meeting
 * turned into, and that is most true in the minute after it finishes. So the
 * loop dies, the window stays, and the next start() is what clears the map.
 */
function stop() {
  sessionGeneration += 1;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (inFlight) gpuLock.release();
  inFlight = false;
  if (map.topics.length > 0) status('stopped', 'The meeting has ended.');
}

function isCurrent(gen) {
  return gen === sessionGeneration && liveTranscriber.isActive();
}

function positive(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function short(err) {
  const text_ = String((err && err.message) || err || 'unknown error');
  return text_.length > 160 ? `${text_.slice(0, 160)}…` : text_;
}

function schedule(delayMs) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(tick, delayMs);
}

/**
 * Read the map's half of GET /live/config, then start ticking.
 *
 * No warmup of its own: the questions loop has already asked for one on the
 * same model, and a second warmup would be a second cold-load ask competing for
 * the same VRAM to achieve nothing. If the map is running ALONE (questions
 * switched off) the first ask pays the load, which is why FIRST_TICK_MS is
 * generous.
 */
async function prepare(gen) {
  try {
    const remote = await homeClient.getLiveConfig();
    if (!isCurrent(gen)) return;
    const mapCfg = (remote && remote.map) || null;
    if (!mapCfg) {
      // A home server too old to know about the map. Not an error worth
      // shouting about — say so once and stay quiet.
      enabled = false;
      status('off', 'This home server is too old to build a meeting map.');
      return;
    }
    if (mapCfg.enabled === false) {
      enabled = false;
      status('off', 'The meeting map is switched off on the home server.');
      return;
    }
    cfg = {
      intervalSec: positive(mapCfg.intervalSec, DEFAULTS.intervalSec),
      windowChars: positive(mapCfg.windowChars, DEFAULTS.windowChars),
      digestChars: positive(mapCfg.digestChars, DEFAULTS.digestChars),
      clientTimeoutSec: positive(mapCfg.clientTimeoutSec, DEFAULTS.clientTimeoutSec),
    };
  } catch (err) {
    if (!isCurrent(gen)) return;
    if (err && err.status === 503) {
      enabled = false;
      status('off', 'The meeting map is switched off on the home server.');
      return;
    }
    status('waiting', `Using default map settings (${short(err)}).`);
  }

  if (!isCurrent(gen)) return;
  status('listening', LISTENING);
  schedule(Math.min(FIRST_TICK_MS, cfg.intervalSec * 1000));
}

const LISTENING = 'Listening — the map appears as topics emerge.';

function busyMessage(err) {
  const detail = String((err && err.message) || '').trim();
  return detail || 'The home server is busy with another meeting — will retry.';
}

async function tick() {
  timer = null;
  const gen = sessionGeneration;
  if (!enabled || !isCurrent(gen)) return;
  const nextDelay = () => {
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
    schedule(nextDelay());
    return;
  }

  // The questions loop may be mid-ask on the same GPU. Skip, don't queue — the
  // unread speech stays behind the high-water mark and goes into the next ask.
  if (!gpuLock.tryAcquire('map')) {
    schedule(nextDelay());
    return;
  }

  inFlight = true;
  busyUntilNextTry = false;
  const digest = buildDigest(cfg.digestChars);
  try {
    status('asking', 'Updating the map…');
    const result = await homeClient.postLiveMap(
      {
        transcriptWindow: fullText
          .slice(Math.max(0, highWaterMark - OVERLAP_CHARS))
          .slice(-cfg.windowChars),
        attendees: liveTranscriber.getAttendees(),
        digest,
      },
      cfg.clientTimeoutSec * 1000
    );
    // Checked BEFORE applying: ops from an abandoned session must never land in
    // the map of the one that replaced it.
    if (!isCurrent(gen)) return;
    consecutiveFailures = 0;
    highWaterMark = fullText.length;
    tickSerial += 1;
    applyOps(result && result.ops);
    status('listening', LISTENING);
  } catch (err) {
    if (!isCurrent(gen)) return;
    if (err && err.status === 503) {
      enabled = false;
      status('off', 'The meeting map is switched off on the home server.');
      return;
    }
    if (err && err.status === 409) {
      busyUntilNextTry = true;
      status('waiting', busyMessage(err));
      return;
    }
    consecutiveFailures += 1;
    status(
      'error',
      consecutiveFailures >= FAILURES_BEFORE_BACKOFF
        ? `The map is paused — ${short(err)}. Retrying every 3 minutes.`
        : `Last map update failed — ${short(err)}. Retrying.`
    );
  } finally {
    gpuLock.release();
    inFlight = false;
    if (isCurrent(gen) && enabled) schedule(nextDelay());
  }
}

module.exports = {
  setEmitter,
  start,
  stop,
  getState,
  // Exported for the unit tests: the op rules and the digest are the parts
  // worth testing directly, and they need no server, window or transcript.
  __test: {
    applyOps,
    buildDigest,
    withRanks,
    reset: () => {
      map = emptyMap();
      digestIds = new Set();
      tickSerial = 0;
    },
    snapshot: () => map,
    setDigestIds: (ids) => {
      digestIds = new Set(ids);
    },
    bumpTick: () => {
      tickSerial += 1;
    },
    caps: { MAX_TOPICS, MAX_NODES_PER_TOPIC, MAX_LINKS },
  },
};
