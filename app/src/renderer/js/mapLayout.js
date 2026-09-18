// Turning a meeting map into geometry.
//
// Pure: map in, {width, height, topics[], arcs[], spine} out. No DOM, no
// window, no state — so the layout rules are testable on their own, and the
// renderer below stays a transcription of the result rather than a place where
// arithmetic hides.
//
// The shape is a vertical river. A time spine runs down the left, topics hang
// off it newest-LAST (so the eye lands on the newest at the bottom, where a
// live feed puts it), and cross-topic links arc back UP the left gutter. The
// arcs are the point: a stack of cards is a list, and it is the arc back to
// something said twenty minutes ago that makes it a map.
//
// Everything is laid out top-down in one pass with a running cursor. No force
// simulation and no iteration: a physics layout would settle differently every
// tick, and this is a thing someone WATCHES — nodes that drift between updates
// cost more than an optimal arrangement buys.

// The gutter is where arcs live. Nothing else may enter it, or an arc will
// cross a word and both become unreadable.
export const GUTTER = 46;
const PAD_X = 12;
const PAD_TOP = 10;
const PAD_BOTTOM = 28;

const TOPIC_GAP = 14;
const TOPIC_PAD = 10;
const TITLE_H = 20;
const ROLLUP_LINE_H = 15;
const NODE_H = 22;
const NODE_GAP = 4;
const SEAM_H = 26;

// Rough, deliberately: measuring text means a DOM round trip per node per
// tick. Slight over-estimation just leaves a little air at the bottom of a
// band, which is cheap; the alternative is layout thrash.
const CHAR_W = 6.1;

function wrapCount(text, widthPx, charW = CHAR_W) {
  if (!text) return 0;
  const perLine = Math.max(8, Math.floor(widthPx / charW));
  return Math.max(1, Math.ceil(text.length / perLine));
}

/**
 * @param {{topics: Array, links: Array}} map  ranked map from the main process
 * @param {number} viewWidth                   the window's inner width
 */
export function layout(map, viewWidth) {
  const width = Math.max(280, viewWidth);
  const bandX = GUTTER + PAD_X;
  const bandW = Math.max(160, width - bandX - PAD_X);
  const spineX = GUTTER - 10;

  const topics = [];
  const nodeAnchors = new Map(); // node id -> {x, y} for arc endpoints
  let y = PAD_TOP;

  for (const topic of map.topics || []) {
    const rank = topic.rank || 'seam';
    const detailed = rank === 'live' || rank === 'warm';
    const collapsed = rank === 'cold';

    if (rank === 'seam') {
      topics.push({
        ...topic,
        x: bandX,
        y,
        w: bandW,
        h: SEAM_H,
        rank,
        nodes: [],
        rollupLines: 0,
      });
      y += SEAM_H + TOPIC_GAP;
      continue;
    }

    const rollupLines = collapsed
      ? wrapCount(topic.rollup, bandW - TOPIC_PAD * 2)
      : 0;
    const nodes = detailed ? topic.nodes || [] : [];
    const nodeLines = nodes.map((n) =>
      wrapCount(n.text, bandW - TOPIC_PAD * 2 - 18)
    );
    const nodesH = nodes.reduce(
      (sum, _n, i) => sum + NODE_H + (nodeLines[i] - 1) * 13 + NODE_GAP,
      0
    );
    const h =
      TOPIC_PAD * 2 +
      TITLE_H +
      rollupLines * ROLLUP_LINE_H +
      nodesH;

    const placed = [];
    let ny = y + TOPIC_PAD + TITLE_H;
    nodes.forEach((node, i) => {
      const nh = NODE_H + (nodeLines[i] - 1) * 13;
      placed.push({ ...node, x: bandX + TOPIC_PAD, y: ny, w: bandW - TOPIC_PAD * 2, h: nh });
      // Arcs attach at the node's left edge, mid-height — the side the gutter
      // is on, so an arc never has to cross the band to reach its target.
      nodeAnchors.set(node.id, { x: bandX, y: ny + nh / 2 });
      ny += nh + NODE_GAP;
    });

    topics.push({
      ...topic,
      x: bandX,
      y,
      w: bandW,
      h,
      rank,
      nodes: placed,
      rollupLines,
    });
    y += h + TOPIC_GAP;
  }

  // Arcs, in the gutter. Only links whose BOTH ends are currently drawn get
  // one — a link into a collapsed topic has no anchor to point at, and an arc
  // ending in mid-air is worse than no arc.
  const arcs = [];
  for (const link of map.links || []) {
    const from = nodeAnchors.get(link.from);
    const to = nodeAnchors.get(link.to);
    if (!from || !to) continue;
    // How far left the arc bows, by how far it travels. A long callback leans
    // further out, so two arcs over the same stretch stay distinguishable.
    const span = Math.abs(from.y - to.y);
    const bow = Math.min(GUTTER - 8, 14 + span / 20);
    arcs.push({
      ...link,
      d:
        `M ${from.x} ${from.y} ` +
        `C ${from.x - bow} ${from.y}, ${to.x - bow} ${to.y}, ${to.x} ${to.y}`,
    });
  }

  return {
    width,
    height: Math.max(y + PAD_BOTTOM, 120),
    topics,
    arcs,
    spine: { x: spineX, y1: PAD_TOP, y2: Math.max(y - TOPIC_GAP, PAD_TOP) },
  };
}
