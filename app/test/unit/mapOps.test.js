'use strict';

// The meeting map's op rules and digest, tested directly.
//
// These are the parts a small local model drives, so they are exactly the parts
// that must not trust it. Behavioural rather than structural: applyOps and
// buildDigest need no server, no window and no transcript, so there is no
// excuse for testing them by reading the source.
//
// Two properties here are load-bearing enough to name:
//   * The id rule. An id WE SENT in the digest means that item; any other id is
//     something new. Without it, a model that emits "n1" every tick — which
//     small models absolutely do — silently overwrites the map it just built.
//   * The digest is bounded by TOPIC COUNT, not meeting length. This is what
//     makes the feature affordable on a home GPU at all: if it were not true,
//     the second hour of a meeting would be the hour it stopped working.

const test = require('node:test');
const assert = require('node:assert/strict');

const liveMap = require('../../src/main/liveMap');
const { applyOps, buildDigest, withRanks, reset, snapshot, setDigestIds, bumpTick, caps } =
  liveMap.__test;

function topic(id, title, rollup = '') {
  return { op: 'topic', id, title, rollup };
}
function node(id, topicId, text, kind = 'point') {
  return { op: 'node', id, topic: topicId, text, kind };
}

test.beforeEach(() => reset());

test('a topic and its nodes land, and keep their arrival order', () => {
  applyOps([
    topic('t1', 'Renewal quote', 'The vendor came back 12% up.'),
    node('n1', 't1', 'Quote is twelve percent up', 'point'),
    node('n2', 't1', 'Hold the signature until renegotiated', 'decision'),
  ]);
  const map = snapshot();
  assert.equal(map.topics.length, 1);
  assert.equal(map.topics[0].title, 'Renewal quote');
  assert.equal(map.topics[0].rollup, 'The vendor came back 12% up.');
  assert.deepEqual(
    map.topics[0].nodes.map((n) => n.id),
    ['n1', 'n2']
  );
  assert.equal(map.topics[0].nodes[1].kind, 'decision');
  assert.equal(map.topics[0].nodes[1].status, 'open');
});

test('an id we SENT in the digest updates that item', () => {
  applyOps([topic('t1', 'Budget', 'First rollup.')]);
  buildDigest(4000); // this is what registers t1 as "shown"
  applyOps([topic('t1', 'Budget and headcount', 'Second rollup.')]);

  const map = snapshot();
  assert.equal(map.topics.length, 1, 'updated in place, not duplicated');
  assert.equal(map.topics[0].title, 'Budget and headcount');
  assert.equal(map.topics[0].rollup, 'Second rollup.');
});

test('an id we did NOT send is something new, even when it collides', () => {
  // The failure this prevents: a small model emits "n1" on every single tick.
  // Without the rule, tick two silently overwrites tick one's node and the map
  // stops growing while appearing to work.
  applyOps([topic('t1', 'Budget'), node('n1', 't1', 'First point')]);
  setDigestIds(['t1']); // t1 was shown; n1 was not (say its topic had collapsed)
  bumpTick();
  applyOps([node('n1', 't1', 'A completely different point')]);

  const nodes = snapshot().topics[0].nodes;
  assert.equal(nodes.length, 2, 'the earlier node survived');
  assert.equal(nodes[0].text, 'First point');
  assert.equal(nodes[1].text, 'A completely different point');
  assert.notEqual(nodes[1].id, 'n1', 'the colliding id was minted fresh');
});

test('a rollup is never blanked by a tick that omits it', () => {
  // A collapsed topic shows its rollup and nothing else. A tick that updates
  // the title alone must not leave it with an empty caption.
  applyOps([topic('t1', 'Budget', 'The rollup that matters.')]);
  buildDigest(4000);
  applyOps([{ op: 'topic', id: 't1', title: 'Budget v2' }]);
  assert.equal(snapshot().topics[0].rollup, 'The rollup that matters.');
});

test('a node naming an unknown topic joins the newest one rather than vanishing', () => {
  // It was said just now, and "just now" is what the newest topic is. Dropping
  // it would lose something the meeting actually contained over an id the model
  // got slightly wrong.
  applyOps([topic('t1', 'Budget'), topic('t2', 'Headcount')]);
  applyOps([node('n9', 'nonexistent', 'Said during headcount')]);

  const map = snapshot();
  assert.equal(map.topics[0].nodes.length, 0);
  assert.equal(map.topics[1].nodes.length, 1);
  assert.equal(map.topics[1].nodes[0].text, 'Said during headcount');
});

test('a node said before any topic exists is dropped, not crashed on', () => {
  const changed = applyOps([node('n1', 't1', 'Orphan')]);
  assert.equal(changed, 0);
  assert.equal(snapshot().topics.length, 0);
});

test('a link needs both ends to exist', () => {
  applyOps([topic('t1', 'Budget'), node('n1', 't1', 'A'), node('n2', 't1', 'B')]);
  applyOps([
    { op: 'link', from: 'n1', to: 'n2', kind: 'answers' },
    { op: 'link', from: 'n1', to: 'ghost', kind: 'answers' }, // to nowhere
    { op: 'link', from: 'n1', to: 'n1' }, // to itself
    { op: 'link', from: 'n1', to: 'n2' }, // duplicate
  ]);
  const links = snapshot().links;
  assert.equal(links.length, 1);
  assert.deepEqual(links[0], { from: 'n1', to: 'n2', kind: 'answers' });
});

test('an unknown op, a junk kind and a junk status all cost one op, not the tick', () => {
  const changed = applyOps([
    topic('t1', 'Budget'),
    { op: 'nonsense', id: 'x' },
    node('n1', 't1', 'Real point', 'not-a-kind'),
    { op: 'status', id: 'n1', status: 'not-a-status' },
    { op: 'status', id: 'ghost', status: 'resolved' },
    null,
    'not an object',
    { op: 'status', id: 'n1', status: 'resolved' },
  ]);
  assert.equal(changed, 3, 'topic + node + the one valid status');
  const node1 = snapshot().topics[0].nodes[0];
  assert.equal(node1.kind, 'point', 'an unrecognized kind falls back');
  assert.equal(node1.status, 'resolved');
});

test('the caps hold, dropping the oldest', () => {
  const ops = [];
  for (let i = 0; i < caps.MAX_TOPICS + 6; i += 1) {
    ops.push(topic(`t${i}`, `Topic ${i}`, `Rollup ${i}`));
  }
  applyOps(ops);
  const topics = snapshot().topics;
  assert.equal(topics.length, caps.MAX_TOPICS);
  assert.equal(topics.at(-1).title, `Topic ${caps.MAX_TOPICS + 5}`, 'newest kept');
  assert.equal(topics[0].title, 'Topic 6', 'oldest dropped');
});

test('a link is dropped when the node it pointed at falls off the end', () => {
  applyOps([topic('t1', 'One'), node('n1', 't1', 'A'), node('n2', 't1', 'B')]);
  applyOps([{ op: 'link', from: 'n1', to: 'n2' }]);
  assert.equal(snapshot().links.length, 1);

  // Push t1 off the end entirely.
  const ops = [];
  for (let i = 0; i < caps.MAX_TOPICS + 2; i += 1) ops.push(topic(`x${i}`, `X ${i}`));
  applyOps(ops);
  assert.equal(snapshot().links.length, 0, 'no arc is left pointing at nothing');
});

test('topics rank live -> warm -> cold -> seam, newest first', () => {
  const ops = [];
  for (let i = 0; i < 10; i += 1) ops.push(topic(`t${i}`, `Topic ${i}`));
  applyOps(ops);
  const ranks = withRanks(snapshot()).topics.map((t) => t.rank);
  assert.equal(ranks.at(-1), 'live', 'the newest topic is the live one');
  assert.deepEqual(ranks.slice(-3, -1), ['warm', 'warm']);
  assert.deepEqual(ranks.slice(-6, -3), ['cold', 'cold', 'cold']);
  assert.ok(ranks.slice(0, -6).every((r) => r === 'seam'));
});

test('the digest spells out the current topics and collapses the rest', () => {
  applyOps([
    topic('t1', 'Old thing', 'What the old thing came to.'),
    node('n1', 't1', 'A point in the old thing'),
    topic('t2', 'A'),
    topic('t3', 'B'),
    topic('t4', 'Current', 'Where we are now.'),
    node('n4', 't4', 'A point in the current thing'),
  ]);
  const digest = buildDigest(4000);

  assert.match(digest, /t4 "Current" — Where we are now\./);
  assert.match(digest, /n4 point open {2}A point in the current thing/);
  // The oldest topic is past the detailed window: one line, no nodes.
  assert.match(digest, /t1 "Old thing" \(collapsed\)/);
  assert.doesNotMatch(digest, /A point in the old thing/);
});

test('the digest is bounded by TOPIC COUNT, not by meeting length', () => {
  // The property the whole feature's affordability rests on: a two-hour meeting
  // must cost no more per tick than a ten-minute one.
  const short = [];
  for (let i = 0; i < 3; i += 1) {
    short.push(topic(`t${i}`, `Topic ${i}`, 'A rollup sentence of some length.'));
    short.push(node(`n${i}`, `t${i}`, 'A node of a fairly typical length here'));
  }
  applyOps(short);
  const shortDigest = buildDigest(3000);

  reset();
  const long = [];
  for (let i = 0; i < 200; i += 1) {
    long.push(topic(`t${i}`, `Topic ${i}`, 'A rollup sentence of some length.'));
    for (let j = 0; j < 8; j += 1) {
      long.push(node(`n${i}_${j}`, `t${i}`, 'A node of a fairly typical length here'));
    }
  }
  applyOps(long);
  const longDigest = buildDigest(3000);

  assert.ok(longDigest.length <= 3000, 'the cap holds');
  assert.ok(
    longDigest.length < shortDigest.length * 12,
    `a 200-topic meeting must not cost proportionally more (${shortDigest.length} -> ${longDigest.length})`
  );
  // And what survives the trim is the NEWEST, which is what is being talked
  // about right now.
  assert.match(longDigest, /Topic 199/);
  assert.doesNotMatch(longDigest, /"Topic 0"/);
});

test('buildDigest records exactly the ids it showed', () => {
  // The id rule depends on this being accurate: anything the digest did NOT
  // name must be treated as new on the way back in.
  applyOps([
    topic('t1', 'Older', 'Rollup.'),
    node('n1', 't1', 'Hidden once collapsed'),
    topic('t2', 'B'),
    topic('t3', 'C'),
    topic('t4', 'Current'),
    node('n4', 't4', 'Visible'),
  ]);
  buildDigest(4000);
  bumpTick();

  // n1's topic is collapsed, so n1 was not shown — reusing it means "new".
  applyOps([{ op: 'node', id: 'n1', topic: 't4', text: 'Something else entirely' }]);
  const t1nodes = snapshot().topics[0].nodes;
  assert.equal(t1nodes[0].text, 'Hidden once collapsed', 'the unshown node is intact');
});
