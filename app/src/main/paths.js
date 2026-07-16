'use strict';

// Dev vs packaged path resolution.
//
// Packaged (electron-builder): assets/fonts and src/renderer/print are copied
// by extraResources to <resources>/fonts and <resources>/print, OUTSIDE the
// asar, so they resolve via process.resourcesPath.
// Dev: they live in the repo under app/.

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

// In dev, app.getAppPath() is the directory containing package.json (app/).
const appRoot = app.getAppPath();

function fontsDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'fonts')
    : path.join(appRoot, 'assets', 'fonts');
}

function printHtmlPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'print', 'print.html')
    : path.join(appRoot, 'src', 'renderer', 'print', 'print.html');
}

/**
 * Find a font file by base name, trying extensions in preference order.
 * Bases used by pdf.js: 'NeueHaasGrotesk-Roman', 'NeueHaasGrotesk-Bold'
 * (see assets/fonts/README.md). Returns an absolute path or null.
 */
function findFont(base) {
  for (const ext of ['.woff2', '.otf', '.ttf']) {
    const candidate = path.join(fontsDir(), base + ext);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

module.exports = { fontsDir, printHtmlPath, findFont };
