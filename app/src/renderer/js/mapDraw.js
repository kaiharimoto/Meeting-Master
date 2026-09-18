// Drawing a laid-out meeting map as SVG.
//
// Split from mapLayout.js so the arithmetic and the markup can be read (and
// tested) apart, and split from map.js so the same drawing serves the live
// window AND the export — the saved file is the same function's output, not a
// second implementation that can drift from what was on screen.
//
// All markup here is literal, from this file. Model text only ever reaches the
// DOM through textContent, never innerHTML — the same rule cardList.js states
// for card content, and it matters more here because every string on this page
// was written by an LLM reading a live microphone.

const SVG_NS = 'http://www.w3.org/2000/svg';

// One glyph per node kind. Shape carries the meaning, not colour: these sit at
// 11px beside a slide deck, sometimes on a projector, sometimes in front of
// someone who cannot tell the status colours apart.
const GLYPHS = {
  decision: '◆',
  action: '▲',
  question: '?',
  risk: '!',
  disagreement: '↯',
  point: '•',
};

function el(name, attrs = {}) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== null && value !== undefined) node.setAttribute(key, String(value));
  }
  return node;
}

/** A <text> that wraps by hand — SVG has no flow, so lines are explicit. */
function wrappedText(text, { x, y, width, lineHeight, className, charW = 6.1 }) {
  const group = el('text', { x, y, class: className });
  const perLine = Math.max(8, Math.floor(width / charW));
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length > perLine && line) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  lines.forEach((text_, i) => {
    const span = el('tspan', { x, dy: i === 0 ? 0 : lineHeight });
    span.textContent = text_; // never innerHTML: this is model output
    group.append(span);
  });
  return group;
}

/**
 * Draw `laid` (from mapLayout.layout) into `svg`, replacing its contents.
 * @param {SVGElement} svg
 * @param {object} laid
 */
export function draw(svg, laid) {
  svg.setAttribute('viewBox', `0 0 ${laid.width} ${laid.height}`);
  svg.setAttribute('width', String(laid.width));
  svg.setAttribute('height', String(laid.height));
  const frag = document.createDocumentFragment();

  // The spine first, so everything else sits over it.
  frag.append(
    el('line', {
      x1: laid.spine.x,
      y1: laid.spine.y1,
      x2: laid.spine.x,
      y2: laid.spine.y2,
      class: 'map-spine',
    })
  );

  // Arcs next — under the bands, so a band always wins a collision.
  for (const arc of laid.arcs) {
    frag.append(el('path', { d: arc.d, class: `map-arc map-arc--${arc.kind}` }));
  }

  for (const topic of laid.topics) {
    const group = el('g', { class: `map-topic map-topic--${topic.rank}` });

    // The tick joining this band to the spine.
    group.append(
      el('line', {
        x1: laid.spine.x,
        y1: topic.y + 14,
        x2: topic.x,
        y2: topic.y + 14,
        class: 'map-tick',
      })
    );

    group.append(
      el('rect', {
        x: topic.x,
        y: topic.y,
        width: topic.w,
        height: topic.h,
        rx: 8,
        class: 'map-band',
      })
    );

    if (topic.rank === 'seam') {
      // A seam is a bar and a name. Its rollup lives in the title attribute —
      // the operator can hover, but it costs no vertical space.
      const title = el('text', {
        x: topic.x + 10,
        y: topic.y + 17,
        class: 'map-seam-title',
      });
      title.textContent = topic.title;
      group.append(title);
      const hover = el('title');
      hover.textContent = topic.rollup || topic.title;
      group.append(hover);
      frag.append(group);
      continue;
    }

    const title = el('text', {
      x: topic.x + 10,
      y: topic.y + 18,
      class: 'map-topic-title',
    });
    title.textContent = topic.title;
    group.append(title);

    if (topic.rank === 'live') {
      // The one moving thing on the page, and only ever one: it says "this is
      // where the meeting is now" without needing to be read.
      group.append(
        el('circle', {
          cx: topic.x + topic.w - 12,
          cy: topic.y + 13,
          r: 4,
          class: 'map-livedot',
        })
      );
    }

    if (topic.rank === 'cold') {
      group.append(
        wrappedText(topic.rollup, {
          x: topic.x + 10,
          y: topic.y + 34,
          width: topic.w - 20,
          lineHeight: 15,
          className: 'map-rollup',
        })
      );
    }

    for (const node of topic.nodes) {
      const nodeGroup = el('g', {
        class:
          `map-node map-node--${node.kind} map-node--${node.status}` +
          (node.isNew ? ' is-new' : ''),
      });
      const glyph = el('text', {
        x: node.x,
        y: node.y + 12,
        class: 'map-glyph',
      });
      glyph.textContent = GLYPHS[node.kind] || GLYPHS.point;
      nodeGroup.append(glyph);
      nodeGroup.append(
        wrappedText(node.text, {
          x: node.x + 16,
          y: node.y + 12,
          width: node.w - 16,
          lineHeight: 13,
          className: 'map-node-text',
        })
      );
      group.append(nodeGroup);
    }

    frag.append(group);
  }

  svg.replaceChildren(frag);
}

// Tokens the exported file needs baked in. Read off the live page at export
// time rather than hardcoded, so a saved map matches the theme it was saved
// from instead of always being the light one.
const EXPORT_TOKENS = [
  '--bg', '--surface', '--surface-2', '--surface-3', '--ink', '--ink-soft',
  '--ink-faint', '--border', '--border-strong', '--accent', '--accent-strong',
  '--danger', '--warn-ink', '--fs-2xs', '--fs-xs', '--fs-sm', '--fw-regular',
  '--fw-medium', '--fw-semibold', '--fw-bold',
];

/**
 * A standalone copy of `svg` with its styles inlined.
 *
 * The live element is styled by app.css + map.css, which a saved file does not
 * get to link. So the rules are copied in and the tokens resolved against the
 * current page — which is also what makes the export honour the operator's
 * theme and text size rather than always saving the default.
 */
export function toStandaloneSvg(svg, mapCssText) {
  const clone = svg.cloneNode(true);
  clone.removeAttribute('hidden');
  clone.setAttribute('xmlns', SVG_NS);

  const computed = getComputedStyle(document.documentElement);
  const vars = EXPORT_TOKENS.map(
    (name) => `  ${name}: ${computed.getPropertyValue(name).trim()};`
  ).join('\n');

  const style = document.createElementNS(SVG_NS, 'style');
  style.textContent = `:root, svg {\n${vars}\n}\n${mapCssText}`;
  clone.prepend(style);

  // An explicit background: an SVG is transparent by default, so a dark-theme
  // map would save as dark text on nothing and look empty in most viewers.
  const bg = document.createElementNS(SVG_NS, 'rect');
  bg.setAttribute('x', '0');
  bg.setAttribute('y', '0');
  bg.setAttribute('width', clone.getAttribute('width') || '0');
  bg.setAttribute('height', clone.getAttribute('height') || '0');
  bg.setAttribute('fill', computed.getPropertyValue('--bg').trim() || '#ffffff');
  clone.insertBefore(bg, clone.firstChild.nextSibling);

  return `<?xml version="1.0" encoding="UTF-8"?>\n${clone.outerHTML}`;
}
