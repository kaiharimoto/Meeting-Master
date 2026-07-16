'use strict';

// THE QUALITY-CRITICAL PATH: renders the meeting notes PDF in a hidden
// BrowserWindow using src/renderer/print/print.html + print.css.
//
// The brand font (@font-face) is injected HERE at runtime, not written in
// print.css, because the font directory differs between dev and packaged
// builds — insertCSS with absolute file:// URLs works in both.

const path = require('path');
const fsp = require('fs/promises');
const { pathToFileURL } = require('url');
const { app, BrowserWindow } = require('electron');
const paths = require('./paths');

const FONT_FAMILY = 'Neue Haas Grotesk';

const FORMAT_BY_EXT = {
  '.woff2': 'woff2',
  '.otf': 'opentype',
  '.ttf': 'truetype',
};

function fontFaceRule(filePath, weight) {
  const format = FORMAT_BY_EXT[path.extname(filePath).toLowerCase()] || 'truetype';
  // pathToFileURL handles Windows drive letters and special characters.
  const href = pathToFileURL(filePath).href;
  return (
    `@font-face { font-family: '${FONT_FAMILY}'; ` +
    `src: url('${href}') format('${format}'); ` +
    `font-weight: ${weight}; font-style: normal; }`
  );
}

// Strip characters Windows forbids in filenames, collapse whitespace.
function sanitizeFileBase(name) {
  const cleaned = String(name || '')
    .replace(/[<>:"\/\\|?*\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || 'meeting-notes';
}

// First free path: base.pdf, base-2.pdf, base-3.pdf, ...
async function uniquePdfPath(dir, base) {
  let candidate = path.join(dir, `${base}.pdf`);
  for (let n = 2; ; n += 1) {
    try {
      await fsp.access(candidate); // exists -> try the next suffix
    } catch {
      return candidate;
    }
    candidate = path.join(dir, `${base}-${n}.pdf`);
  }
}

/**
 * Render the meeting PDF.
 * @param {object} args {meeting, transcript, summary, pageSize ('Letter'|'A4')}
 * @returns {Promise<{pdfPath: string, fontUsed: boolean, warning: string|null}>}
 */
async function renderMeetingPdf({ meeting, transcript, summary, pageSize }) {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  try {
    await win.loadFile(paths.printHtmlPath());

    // ---- Font injection --------------------------------------------------
    let fontUsed = false;
    let warning = null;
    const roman = paths.findFont('NeueHaasGrotesk-Roman');
    const bold = paths.findFont('NeueHaasGrotesk-Bold');

    if (roman || bold) {
      const rules = [];
      if (roman) rules.push(fontFaceRule(roman, 400));
      if (bold) rules.push(fontFaceRule(bold, 700));
      await win.webContents.insertCSS(rules.join('\n'));
      fontUsed = true;
      if (!roman || !bold) {
        const missing = roman ? 'Bold' : 'Roman';
        warning =
          `Only one Neue Haas Grotesk weight was found — the ${missing} weight ` +
          'is missing, so that weight is synthesized/substituted. ' +
          'See assets/fonts/README.md.';
      }
    } else {
      // No brand fonts: skip injection so print.css falls back to Arial.
      warning =
        'Neue Haas Grotesk font files were not found — the PDF uses the Arial ' +
        `fallback. Drop the font files into ${paths.fontsDir()} ` +
        '(see assets/fonts/README.md).';
    }

    // ---- Inject the data -------------------------------------------------
    // JSON is not quite a subset of JS source: U+2028/U+2029 are valid in
    // JSON strings but are line terminators in JS, so escape them or the
    // executeJavaScript call would throw a SyntaxError.
    const data = Object.assign({}, meeting, {
      transcript: transcript || null,
      summary: summary || null,
    });
    const payload = JSON.stringify(data)
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029');
    await win.webContents.executeJavaScript(`window.renderMeeting(${payload})`);

    // ---- Wait for fonts (gotcha #1) ---------------------------------------
    // printToPDF before document.fonts.ready produces wrong-font PDFs.
    // The explicit fonts.load() calls kick off the fetch even if layout has
    // not flushed yet; both resolve harmlessly when no @font-face exists.
    await win.webContents.executeJavaScript(
      `Promise.all([
         document.fonts.load("400 24pt '${FONT_FAMILY}'"),
         document.fonts.load("700 24pt '${FONT_FAMILY}'"),
       ]).catch(() => {}).then(() => document.fonts.ready).then(() => true)`
    );

    // ---- Print (gotcha #2) -------------------------------------------------
    // printBackground:true or the color fills silently drop;
    // preferCSSPageSize:true keeps the @page margins from print.css while the
    // pageSize option controls the paper size (print.css sets no @page size).
    const pdfBuffer = await win.webContents.printToPDF({
      printBackground: true,
      preferCSSPageSize: true,
      pageSize: pageSize === 'A4' ? 'A4' : 'Letter',
    });

    // ---- Save --------------------------------------------------------------
    const outDir = path.join(app.getPath('documents'), 'MeetingMaster');
    await fsp.mkdir(outDir, { recursive: true });

    const details = (meeting && meeting.details) || {};
    const titlePart = sanitizeFileBase(details.title);
    // The date is YYYY-MM-DD (filename-safe); skip it when absent.
    const base = details.date ? `${titlePart}-${details.date}` : titlePart;
    const pdfPath = await uniquePdfPath(outDir, base);
    await fsp.writeFile(pdfPath, pdfBuffer);

    return { pdfPath, fontUsed, warning };
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

module.exports = { renderMeetingPdf };
