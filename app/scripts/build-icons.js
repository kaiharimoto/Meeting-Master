'use strict';

// Regenerates the committed icon binaries from assets/icon/icon.svg:
//   app/build/icon.png        512px master (BrowserWindow icon on Linux/dev)
//   app/build/icon.ico        multi-size (electron-builder win icon)
//   installer/server/icon.ico copy for the server's Inno Setup installer
//
// Run manually after editing the SVG (never a CI step — CI ships only what is
// committed):  node scripts/build-icons.js

const fs = require('fs');
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');
const png2icons = require('png2icons');

const ROOT = path.resolve(__dirname, '..');
const SVG_PATH = path.join(ROOT, 'assets', 'icon', 'icon.svg');
const BUILD_DIR = path.join(ROOT, 'build');
const SERVER_ICO = path.resolve(ROOT, '..', 'installer', 'server', 'icon.ico');

function renderPng(svg, size) {
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: size },
  });
  return resvg.render().asPng();
}

function main() {
  const svg = fs.readFileSync(SVG_PATH, 'utf8');
  fs.mkdirSync(BUILD_DIR, { recursive: true });

  const master = renderPng(svg, 512);
  fs.writeFileSync(path.join(BUILD_DIR, 'icon.png'), master);

  // BICUBIC keeps small sizes (16/24/32) crisp; png2icons embeds the standard
  // Windows size set from the 512px master.
  const ico = png2icons.createICO(master, png2icons.BICUBIC, 0, true);
  if (!ico) throw new Error('png2icons failed to produce an ICO');
  fs.writeFileSync(path.join(BUILD_DIR, 'icon.ico'), ico);
  fs.writeFileSync(SERVER_ICO, ico);

  console.log('Wrote:');
  console.log('  build/icon.png (%d bytes)', master.length);
  console.log('  build/icon.ico (%d bytes)', ico.length);
  console.log('  ../installer/server/icon.ico');
}

main();
