'use strict';

// Dev vs packaged path resolution.
//
// Packaged (electron-builder): assets/fonts and src/renderer/print are copied
// by extraResources to <resources>/fonts and <resources>/print, OUTSIDE the
// asar, so they resolve via process.resourcesPath.
// Dev: they live in the repo under app/.
//
// FONTS live in TWO places, checked in order:
//   1. The USER fonts dir — <userData>/fonts. Survives app updates (the NSIS
//      upgrade replaces the whole install dir, so anything the user drops in
//      <resources>/fonts would be lost on every update). This is where users
//      are told to put their licensed Neue Haas Grotesk files.
//   2. The BUNDLED dir — <resources>/fonts (or app/assets/fonts in dev) — for
//      fonts baked in at build time.
// migrateFonts() copies any bundled/legacy files up into the user dir once so
// pre-0.2.1 installs keep their fonts across the next update.

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

// In dev, app.getAppPath() is the directory containing package.json (app/).
const appRoot = app.getAppPath();

const FONT_BASES = [
  'NeueHaasGrotesk-Roman',
  'NeueHaasGrotesk-Bold',
  'NeueHaasGrotesk-Medium',
];
const FONT_EXTS = ['.woff2', '.woff', '.otf', '.ttf'];

// Weight subfolders inside the user fonts dir. ANY font file dropped in the
// right folder is used regardless of its file name — exact-name matching kept
// tripping people up (v0.3.0 field report), foundry downloads never match.
const WEIGHT_DIRS = Object.freeze({
  'NeueHaasGrotesk-Roman': 'roman',
  'NeueHaasGrotesk-Bold': 'bold',
  'NeueHaasGrotesk-Medium': 'medium',
});

/** Where in-app recordings live (created on demand). Never wiped by updates. */
function recordingsDir() {
  const dir = path.join(app.getPath('userData'), 'recordings');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // Recording start will surface the real error when it tries to write.
  }
  return dir;
}

/** Update-proof, user-writable font location (created on demand). */
function userFontsDir() {
  const dir = path.join(app.getPath('userData'), 'fonts');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // Creation failure just means lookups fall through to the bundled dir.
  }
  return dir;
}

/** Build-time font location (wiped/replaced by every update). */
function bundledFontsDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'fonts')
    : path.join(appRoot, 'assets', 'fonts');
}

// The advertised drop-in location (used in user-facing messages).
function fontsDir() {
  return userFontsDir();
}

function printHtmlPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'print', 'print.html')
    : path.join(appRoot, 'src', 'renderer', 'print', 'print.html');
}

/** First font file inside a directory (best format first, then name), or null. */
function firstFontIn(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir).filter((f) => FONT_EXTS.includes(path.extname(f).toLowerCase()));
  } catch {
    return null;
  }
  if (entries.length === 0) return null;
  entries.sort(
    (a, b) =>
      FONT_EXTS.indexOf(path.extname(a).toLowerCase()) -
        FONT_EXTS.indexOf(path.extname(b).toLowerCase()) || a.localeCompare(b)
  );
  return path.join(dir, entries[0]);
}

/**
 * Find a font file for a weight. Checked in order:
 *   1. The weight subfolder (<userData>/fonts/roman|bold|medium) — any file
 *      name counts; this is the advertised drop-in location.
 *   2. Exact base-name files in the user dir, then the bundled dir (legacy).
 * Returns an absolute path or null.
 */
function findFont(base) {
  const sub = WEIGHT_DIRS[base];
  if (sub) {
    const hit = firstFontIn(path.join(userFontsDir(), sub));
    if (hit) return hit;
  }
  for (const dir of [userFontsDir(), bundledFontsDir()]) {
    for (const ext of FONT_EXTS) {
      const candidate = path.join(dir, base + ext);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * One-time move of fonts into the update-proof user dir. Copies any known
 * font file found in the bundled dir that the user dir doesn't already have —
 * so an existing install's fonts survive the NEXT update even though the
 * updater replaces <resources>/fonts. Never overwrites, never throws.
 */
function migrateFonts() {
  const target = userFontsDir();
  const source = bundledFontsDir();
  // Make the weight drop-folders exist so "Open fonts folder" shows them.
  for (const sub of Object.values(WEIGHT_DIRS)) {
    try {
      fs.mkdirSync(path.join(target, sub), { recursive: true });
    } catch {
      // Best effort.
    }
  }
  for (const base of FONT_BASES) {
    for (const ext of FONT_EXTS) {
      const from = path.join(source, base + ext);
      const to = path.join(target, base + ext);
      try {
        if (fs.existsSync(from) && !fs.existsSync(to)) {
          fs.copyFileSync(from, to);
        }
      } catch {
        // Best effort — a failed copy just leaves the bundled fallback in use.
      }
    }
  }
}

module.exports = {
  fontsDir,
  userFontsDir,
  bundledFontsDir,
  recordingsDir,
  printHtmlPath,
  findFont,
  migrateFonts,
};
