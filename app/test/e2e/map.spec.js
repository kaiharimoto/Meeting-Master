'use strict';

// The meeting map window, driven against the real renderer.
//
// map.html is a standalone page like mini.html, so this spec targets it
// directly rather than index.html, and stubs the two halves of its contract:
// getMap() (the pull, on load) and onMapState (the push, thereafter).

const path = require('path');
const { pathToFileURL } = require('url');
const { test, expect } = require('@playwright/test');

// The real window is a tall portrait panel parked beside a slide deck. Testing
// it at the default landscape viewport would exercise a layout nobody sees.
test.use({ viewport: { width: 440, height: 900 } });

const MAP_URL = pathToFileURL(
  path.resolve(__dirname, '..', '..', 'src', 'renderer', 'map.html')
).href;

function mapWith(topics, links = []) {
  return { map: { topics, links, rev: 1 }, status: null, live: true };
}

const THREE_TOPICS = [
  { id: 't1', title: 'Renewal quote', rollup: 'Vendor came back 12% up.', rank: 'cold', nodes: [] },
  {
    id: 't2',
    title: 'Headcount',
    rollup: 'Hiring frozen until Q4.',
    rank: 'warm',
    nodes: [
      { id: 'n1', kind: 'decision', text: 'Freeze hiring until Q4', status: 'open' },
      { id: 'n2', kind: 'question', text: 'Who signs off?', status: 'open' },
    ],
  },
  {
    id: 't3',
    title: 'Contractor spend',
    rollup: 'Capped pending Q3 close.',
    rank: 'live',
    nodes: [
      { id: 'n3', kind: 'action', text: 'Draft the cap memo', status: 'open' },
      { id: 'n4', kind: 'risk', text: 'Legal position unknown', status: 'open' },
    ],
  },
];

/** A map taller than the window, for the scroll and export cases. */
function tallMap() {
  const topics = [];
  for (let i = 0; i < 12; i += 1) {
    const rank = i === 11 ? 'live' : i >= 9 ? 'warm' : i >= 6 ? 'cold' : 'seam';
    const nodes = [];
    // Only the detailed ranks carry nodes, so that is where the height has to
    // come from.
    if (rank === 'live' || rank === 'warm') {
      for (let j = 0; j < 8; j += 1) {
        nodes.push({
          id: `n${i}_${j}`,
          kind: 'point',
          text: `A reasonably long point number ${j} inside topic ${i}`,
          status: 'open',
        });
      }
    }
    topics.push({
      id: `t${i}`,
      title: `Topic ${i}`,
      rollup: `Rollup ${i}, long enough to wrap onto more than a single line here.`,
      rank,
      nodes,
    });
  }
  return topics;
}

async function boot(page, initial) {
  await page.addInitScript((seed) => {
    window.__mapCbs = [];
    window.api = {
      getMap: async () => seed,
      onMapState: (cb) => {
        window.__mapCbs.push(cb);
        return () => {};
      },
      mapPin: async () => ({ ok: true, pinned: true }),
      mapClose: async () => ({ ok: true }),
      pickSavePath: async () => ({ filePath: null }),
      saveTextFile: async () => ({ ok: true }),
      saveBinaryFile: async () => ({ ok: true }),
    };
  }, initial);
  await page.goto(MAP_URL);
}

function push(page, payload) {
  return page.evaluate((p) => window.__mapCbs.forEach((cb) => cb(p)), payload);
}

test('an empty map says it is listening rather than showing nothing', async ({ page }) => {
  await boot(page, mapWith([]));
  await expect(page.locator('#map-empty')).toBeVisible();
  await expect(page.locator('#map-svg')).toBeHidden();
});

test('the map arrives on load, not only on the next push', async ({ page }) => {
  // The window is opened MID-meeting, after ticks have already landed. Without
  // the pull it would sit blank for up to 90 seconds looking broken.
  await boot(page, mapWith(THREE_TOPICS));
  await expect(page.locator('#map-svg')).toBeVisible();
  await expect(page.locator('.map-topic')).toHaveCount(3);
  await expect(page.locator('#map-empty')).toBeHidden();
});

test('a push updates the map', async ({ page }) => {
  await boot(page, mapWith([]));
  await push(page, mapWith(THREE_TOPICS));
  await expect(page.locator('.map-topic')).toHaveCount(3);
  await expect(page.locator('.map-node')).toHaveCount(4);
});

test('the newest topic is lowest, and it is the live one', async ({ page }) => {
  // The whole reading order: time runs downward, so the eye lands on now.
  await boot(page, mapWith(THREE_TOPICS));
  const bands = page.locator('.map-topic');
  const boxes = [];
  for (let i = 0; i < 3; i += 1) boxes.push(await bands.nth(i).boundingBox());
  expect(boxes[0].y).toBeLessThan(boxes[1].y);
  expect(boxes[1].y).toBeLessThan(boxes[2].y);
  await expect(bands.nth(2)).toHaveClass(/map-topic--live/);
  await expect(page.locator('.map-livedot')).toHaveCount(1);
});

test('a collapsed topic shows its rollup instead of its nodes', async ({ page }) => {
  // The compression that keeps a two-hour meeting readable: the sentence the
  // model keeps current stands in for everything underneath it.
  await boot(page, mapWith(THREE_TOPICS));
  const cold = page.locator('.map-topic--cold');
  await expect(cold).toHaveCount(1);
  await expect(cold.locator('.map-rollup')).toContainText('Vendor came back 12% up.');
  await expect(cold.locator('.map-node')).toHaveCount(0);
  // …while the current topics still show theirs.
  await expect(page.locator('.map-topic--live .map-node')).toHaveCount(2);
});

test('a seam is a bar with its rollup on hover, costing no vertical space', async ({ page }) => {
  const many = [];
  for (let i = 0; i < 9; i += 1) {
    many.push({
      id: `t${i}`,
      title: `Topic ${i}`,
      rollup: `Rollup ${i}.`,
      rank: i === 8 ? 'live' : i >= 6 ? 'warm' : i >= 3 ? 'cold' : 'seam',
      nodes: [],
    });
  }
  await boot(page, mapWith(many));
  const seams = page.locator('.map-topic--seam');
  await expect(seams).toHaveCount(3);
  await expect(seams.first().locator('title')).toHaveText('Rollup 0.');

  const seamBox = await seams.first().boundingBox();
  const liveBox = await page.locator('.map-topic--live').boundingBox();
  expect(seamBox.height).toBeLessThan(liveBox.height);
});

test('a callback arc is drawn between two visible nodes', async ({ page }) => {
  // The arc is what makes this a map rather than a feed.
  await boot(page, mapWith(THREE_TOPICS, [{ from: 'n3', to: 'n1', kind: 'answers' }]));
  const arc = page.locator('.map-arc');
  await expect(arc).toHaveCount(1);
  await expect(arc).toHaveClass(/map-arc--answers/);

  // It runs in the LEFT GUTTER, clear of the bands, or it would cross the text.
  const arcBox = await arc.boundingBox();
  const bandBox = await page.locator('.map-band').first().boundingBox();
  expect(arcBox.x).toBeLessThan(bandBox.x);
});

test('an arc to a node that is not drawn is dropped, not left dangling', async ({ page }) => {
  await boot(page, mapWith(THREE_TOPICS, [{ from: 'n3', to: 'ghost', kind: 'answers' }]));
  await expect(page.locator('.map-arc')).toHaveCount(0);
});

test('node kind and status read without relying on colour', async ({ page }) => {
  const topics = [
    {
      id: 't1',
      title: 'Kinds',
      rollup: '',
      rank: 'live',
      nodes: [
        { id: 'n1', kind: 'decision', text: 'A decision', status: 'open' },
        { id: 'n2', kind: 'risk', text: 'A risk', status: 'resolved' },
        { id: 'n3', kind: 'action', text: 'An action', status: 'parked' },
      ],
    },
  ];
  await boot(page, mapWith(topics));
  // A distinct glyph per kind — shape, not hue.
  const glyphs = await page.locator('.map-glyph').allTextContents();
  expect(new Set(glyphs).size).toBe(3);
  // Resolved is struck through; parked is faded. Both survive a projector.
  await expect(page.locator('.map-node--resolved .map-node-text')).toHaveCSS(
    'text-decoration-line',
    'line-through'
  );
  const parkedOpacity = await page
    .locator('.map-node--parked')
    .evaluate((el) => getComputedStyle(el.querySelector('.map-node-text')).opacity);
  expect(Number(parkedOpacity)).toBeLessThan(1);
});

test('the status line only interrupts when something is actually wrong', async ({ page }) => {
  // This sits beside a live meeting: a screen reader narrating every tick
  // would talk over the room.
  await boot(page, mapWith(THREE_TOPICS));
  const status = page.locator('#map-status');

  await push(page, {
    ...mapWith(THREE_TOPICS),
    status: { state: 'asking', message: 'Updating the map…' },
  });
  await expect(status).toHaveAttribute('aria-live', 'off');

  await push(page, {
    ...mapWith(THREE_TOPICS),
    status: { state: 'error', message: 'The home server is not answering.' },
  });
  await expect(status).toBeVisible();
  await expect(status).toHaveText('The home server is not answering.');
  await expect(status).toHaveAttribute('aria-live', 'polite');
});

test('scrolling up stops the auto-follow and offers a way back', async ({ page }) => {
  // Deliberately taller than the window: with nothing to scroll there is
  // nothing to jump back to, and the pill correctly never appears.
  await boot(page, mapWith(tallMap()));
  await expect(page.locator('#map-jump')).toBeHidden();

  await page.locator('#map-scroll').evaluate((el) => {
    el.scrollTop = 0;
    el.dispatchEvent(new Event('scroll'));
  });
  await expect(page.locator('#map-jump')).toBeVisible();

  await page.locator('#map-jump').click();
  await expect(page.locator('#map-jump')).toBeHidden();
});

test('the pin toggles and reports itself to the main process', async ({ page }) => {
  await boot(page, mapWith(THREE_TOPICS));
  await page.evaluate(() => {
    window.__pins = [];
    window.api.mapPin = async (on) => {
      window.__pins.push(on);
      return { ok: true, pinned: on };
    };
  });
  const pin = page.locator('#map-pin');
  await expect(pin).toHaveAttribute('aria-pressed', 'true');
  await pin.click();
  await expect(pin).toHaveAttribute('aria-pressed', 'false');
  await pin.click();
  await expect(pin).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => window.__pins)).toEqual([false, true]);
});

test('Save offers both formats and exports the WHOLE map, not the visible part', async ({
  page,
}) => {
  await boot(page, mapWith(tallMap()));
  await page.evaluate(() => {
    window.__saved = null;
    window.api.pickSavePath = async (name) => ({ filePath: `/tmp/${name}` });
    window.api.saveTextFile = async (filePath, text) => {
      window.__saved = { filePath, text };
      return { ok: true };
    };
  });

  await page.locator('#map-save').click();
  await expect(page.locator('#map-save-menu')).toBeVisible();
  await page.locator('#map-save-menu button[data-format="svg"]').click();

  const saved = await page.evaluate(() => window.__saved);
  expect(saved.filePath).toMatch(/meeting-map-\d{4}-\d{2}-\d{2}\.svg$/);
  // Self-contained: styles inlined and an explicit background, because an SVG
  // is transparent by default and a dark-theme map would look empty.
  expect(saved.text).toContain('<?xml version="1.0"');
  expect(saved.text).toContain('<style>');
  expect(saved.text).toContain('--ink:');
  // Every topic is in the file, including ones scrolled out of view.
  expect(saved.text).toContain('Topic 0');
  expect(saved.text).toContain('Topic 11');
});

test('the text scale setting reaches this window', async ({ page }) => {
  // map.css has no literal font-size (mapWiring.test.js pins that); this is the
  // other half — that the tokens actually respond here, on a page the operator
  // reads from across a desk.
  await boot(page, mapWith(THREE_TOPICS));
  const before = await page
    .locator('.map-topic-title')
    .first()
    .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));

  await page.evaluate(() =>
    document.documentElement.style.setProperty('--fs-scale', '1.5')
  );
  const after = await page
    .locator('.map-topic-title')
    .first()
    .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));

  expect(after).toBeGreaterThan(before * 1.4);
});
