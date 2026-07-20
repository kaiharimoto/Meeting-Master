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
const FONT_EXTS = ['.woff2', '.otf', '.ttf'];

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

/**
 * Find a font file by base name: the user dir wins, the bundled dir is the
 * fallback. Returns an absolute path or null.
 */
function findFont(base) {
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

module.exports = { fontsDir, userFontsDir, bundledFontsDir, printHtmlPath, findFont, migrateFonts };
