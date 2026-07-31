'use strict';

// WCAG contrast guard for the design tokens.
//
// The v0.11.0 audit found --ink-faint failing AA on every surface in BOTH
// themes (2.91-4.17:1) while carrying real content, dark --border sitting at
// ~1.4:1 (invisible panel/card/input edges), and a non-theme-aware modal
// scrim. These assertions pin the fixes so a future palette tweak can't
// silently undo them.
//
// Ratios are computed from the actual token values parsed out of app.css, so
// the test fails if the stylesheet drifts from the intent.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const CSS = fs.readFileSync(
  path.join(__dirname, '..', '..', 'src', 'renderer', 'styles', 'app.css'),
  'utf8'
);

/** Pull one `:root`-ish block's custom properties into a map. */
function tokenBlock(selector) {
  const start = CSS.indexOf(selector);
  assert.ok(start !== -1, `${selector} block not found in app.css`);
  const open = CSS.indexOf('{', start);
  const close = CSS.indexOf('}', open);
  const body = CSS.slice(open + 1, close);
  const out = {};
  for (const line of body.split('\n')) {
    const m = line.match(/^\s*(--[\w-]+)\s*:\s*([^;]+);/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

const LIGHT = tokenBlock(':root {');
const DARK = tokenBlock(':root[data-theme="dark"] {');

function parseHex(value) {
  const m = String(value).trim().match(/^#([0-9a-f]{6})$/i);
  assert.ok(m, `expected an opaque hex colour, got "${value}"`);
  const int = parseInt(m[1], 16);
  return [(int >> 16) & 255, (int >> 8) & 255, int & 255];
}

function luminance(rgb) {
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(fg, bg) {
  const a = luminance(parseHex(fg));
  const b = luminance(parseHex(bg));
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

const SURFACES = ['--bg', '--bg-sidebar', '--surface', '--surface-2', '--surface-3'];

for (const [themeName, tokens] of [['light', LIGHT], ['dark', DARK]]) {
  test(`${themeName}: --ink-faint clears AA (4.5:1) on every surface`, () => {
    for (const surface of SURFACES) {
      const ratio = contrast(tokens['--ink-faint'], tokens[surface]);
      assert.ok(
        ratio >= 4.5,
        `--ink-faint on ${surface} is ${ratio.toFixed(2)}:1 (needs >= 4.5)`
      );
    }
  });

  test(`${themeName}: --ink and --ink-soft clear AA on every surface`, () => {
    for (const ink of ['--ink', '--ink-soft']) {
      for (const surface of SURFACES) {
        const ratio = contrast(tokens[ink], tokens[surface]);
        assert.ok(
          ratio >= 4.5,
          `${ink} on ${surface} is ${ratio.toFixed(2)}:1 (needs >= 4.5)`
        );
      }
    }
  });

  test(`${themeName}: --border-control clears 3:1 against panel and field fills`, () => {
    // WCAG 1.4.11: a control's boundary is non-text content that identifies it.
    for (const surface of ['--surface', '--field-bg']) {
      const ratio = contrast(tokens['--border-control'], tokens[surface]);
      assert.ok(
        ratio >= 3,
        `--border-control on ${surface} is ${ratio.toFixed(2)}:1 (needs >= 3)`
      );
    }
  });

  test(`${themeName}: --border is visibly separated from --surface`, () => {
    // Decorative structure, so not held to 3:1 — but 1.4:1 (the old dark
    // value) reads as no border at all.
    const ratio = contrast(tokens['--border'], tokens['--surface']);
    assert.ok(ratio >= 1.5, `--border on --surface is ${ratio.toFixed(2)}:1 (needs >= 1.5)`);
  });

  test(`${themeName}: --on-accent is legible on --accent`, () => {
    const ratio = contrast(tokens['--on-accent'], tokens['--accent']);
    assert.ok(ratio >= 4.5, `--on-accent on --accent is ${ratio.toFixed(2)}:1 (needs >= 4.5)`);
  });

  test(`${themeName}: status inks are legible on their own soft fills`, () => {
    for (const [ink, fill] of [
      ['--success', '--success-soft'],
      ['--danger', '--danger-soft'],
      ['--warn-ink', '--warn-bg'],
      ['--accent', '--accent-soft'],
    ]) {
      const ratio = contrast(tokens[ink], tokens[fill]);
      assert.ok(ratio >= 4.5, `${ink} on ${fill} is ${ratio.toFixed(2)}:1 (needs >= 4.5)`);
    }
  });
}

test('dark soft fills are opaque, not alpha', () => {
  // As alpha they composited differently on every ancestor, so one rule
  // produced three different contrast ratios.
  for (const token of ['--accent-soft', '--accent-ghost', '--success-soft', '--danger-soft', '--warn-bg', '--warn-border']) {
    assert.match(
      DARK[token],
      /^#[0-9a-f]{6}$/i,
      `dark ${token} should be an opaque hex, got "${DARK[token]}"`
    );
  }
});

test('the modal scrim is theme-aware', () => {
  assert.ok(LIGHT['--scrim'], 'light --scrim missing');
  assert.ok(DARK['--scrim'], 'dark --scrim missing');
  assert.notEqual(
    LIGHT['--scrim'],
    DARK['--scrim'],
    'the scrim must differ per theme — a 50% near-black over a dark app separates nothing'
  );
});

test('the type, weight and spacing scales are defined', () => {
  // Every step routes through --fs-scale, or the Settings "Text size" control
  // would move some of the type and leave the rest behind.
  assert.equal(LIGHT['--fs-scale'], '1', '--fs-scale must default to 1');
  for (const token of ['--fs-2xs', '--fs-xs', '--fs-sm', '--fs-base', '--fs-md', '--fs-lg']) {
    assert.match(
      LIGHT[token],
      /^calc\(\d+(\.\d+)?px \* var\(--fs-scale\)\)$/,
      `${token} missing or not scaled`
    );
  }
  for (const token of ['--lh-tight', '--lh-snug', '--lh-base', '--lh-loose']) {
    assert.ok(LIGHT[token], `${token} missing`);
  }
  for (const token of ['--fw-regular', '--fw-medium', '--fw-semibold', '--fw-bold']) {
    assert.ok(LIGHT[token], `${token} missing`);
  }
  // 4px grid.
  const spacing = ['--sp-1', '--sp-2', '--sp-3', '--sp-4', '--sp-5', '--sp-6'];
  spacing.forEach((token, i) => {
    assert.equal(LIGHT[token], `${(i + 1) * 4}px`, `${token} should be ${(i + 1) * 4}px`);
  });
  assert.equal(LIGHT['--r-pill'], '999px');
  assert.equal(LIGHT['--r-xs'], '4px');
});

// ---- High contrast --------------------------------------------------------
//
// data-contrast="high" composes with both themes, so both combinations get
// checked. The bar is higher than AA on purpose: the mode exists for people for
// whom AA is not enough, and shipping it at the same ratios as the default
// theme would be a label rather than a feature.

const HC_LIGHT = { ...LIGHT, ...tokenBlock(':root[data-contrast="high"] {') };
const HC_DARK = {
  ...DARK,
  ...tokenBlock(':root[data-contrast="high"] {'),
  ...tokenBlock(':root[data-theme="dark"][data-contrast="high"] {'),
};

for (const [name, tokens] of [['light', HC_LIGHT], ['dark', HC_DARK]]) {
  test(`high contrast (${name}): body ink reaches AAA (7:1) and then some`, () => {
    for (const surface of SURFACES) {
      const ratio = contrast(tokens['--ink'], tokens[surface]);
      assert.ok(
        ratio >= 15,
        `--ink on ${surface} is ${ratio.toFixed(2)}:1, want >= 15:1`
      );
    }
  });

  test(`high contrast (${name}): secondary inks clear AAA (7:1)`, () => {
    for (const ink of ['--ink-soft', '--ink-faint']) {
      for (const surface of SURFACES) {
        const ratio = contrast(tokens[ink], tokens[surface]);
        assert.ok(
          ratio >= 7,
          `${ink} on ${surface} is ${ratio.toFixed(2)}:1, want >= 7:1`
        );
      }
    }
  });

  test(`high contrast (${name}): borders clear 4.5:1, not merely 3:1`, () => {
    for (const border of ['--border', '--border-strong', '--border-control']) {
      for (const surface of ['--bg', '--surface', '--surface-2']) {
        const ratio = contrast(tokens[border], tokens[surface]);
        assert.ok(
          ratio >= 4.5,
          `${border} on ${surface} is ${ratio.toFixed(2)}:1, want >= 4.5:1`
        );
      }
    }
  });

  test(`high contrast (${name}): the accent stays legible as text`, () => {
    for (const surface of ['--surface', '--surface-2', '--accent-soft']) {
      const ratio = contrast(tokens['--accent'], tokens[surface]);
      assert.ok(
        ratio >= 4.5,
        `--accent on ${surface} is ${ratio.toFixed(2)}:1, want >= 4.5:1`
      );
    }
  });

  test(`high contrast (${name}): status inks clear AA on their own fills`, () => {
    for (const [ink, fill] of [
      ['--success', '--success-soft'],
      ['--danger', '--danger-soft'],
      ['--warn-ink', '--warn-bg'],
    ]) {
      const ratio = contrast(tokens[ink], tokens[fill]);
      assert.ok(
        ratio >= 4.5,
        `${ink} on ${fill} is ${ratio.toFixed(2)}:1, want >= 4.5:1`
      );
    }
  });
}

test('high contrast only overrides — it never redefines the whole palette', () => {
  const overrides = Object.keys(tokenBlock(':root[data-contrast="high"] {'));
  // Separation tokens only. If this list grows to include layout or geometry,
  // high contrast has quietly become a second theme.
  for (const token of overrides) {
    assert.match(
      token,
      /^--(ink|accent|border|scrim|success|danger|warn)/,
      `${token} is not a separation token — high contrast should not set it`
    );
  }
});
