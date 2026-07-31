'use strict';

// THE QUALITY-CRITICAL PATH: renders the meeting notes PDF in a BrowserWindow
// using src/renderer/print/print.html + print.css.
//
// TWO consumers, ONE render: renderMeetingPdf() prints a hidden window to
// disk, openPdfPreview() shows the same window on screen. Both go through
// renderIntoWindow(), because a preview that resolves a different HTML path or
// injects different fonts is a preview that lies.
//
// The brand font (@font-face) is injected HERE at runtime, not written in
// print.css, because the font directory differs between dev and packaged
// builds — insertCSS with absolute file:// URLs works in both.

const path = require('path');
const fsp = require('fs/promises');
const { pathToFileURL } = require('url');
const { app, BrowserWindow } = require('electron');
const paths = require('./paths');
const { pageChromeCss, MARGIN_IN } = require('./printChrome');

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
  if (!cleaned) return 'meeting-notes';
  // Windows reserves device names (CON, PRN, AUX, NUL, COM1-9, LPT1-9) as
  // bare base names — "CON.pdf" cannot be created.
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(cleaned)) {
    return `${cleaned}-notes`;
  }
  return cleaned;
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

// Load print.html into `win`, inject the brand fonts, render the meeting into
// it and wait for the fonts to settle. Shared by the PDF and the preview.
// Returns {fontUsed, warning}.
async function renderIntoWindow(win, { meeting, summary }) {
  await win.loadFile(paths.printHtmlPath());

  // ---- Font injection ----------------------------------------------------
  let fontUsed = false;
  let warning = null;
  const roman = paths.findFont('NeueHaasGrotesk-Roman');
  const bold = paths.findFont('NeueHaasGrotesk-Bold');
  // Optional: the template's uppercase micro-labels ask for weight 500 and
  // fall back to Roman/Bold synthesis when no Medium file is present.
  const medium = paths.findFont('NeueHaasGrotesk-Medium');

  if (roman || bold) {
    const rules = [];
    if (roman) rules.push(fontFaceRule(roman, 400));
    if (bold) rules.push(fontFaceRule(bold, 700));
    if (medium) rules.push(fontFaceRule(medium, 500));
    await win.webContents.insertCSS(rules.join('\n'));
    fontUsed = true;
    if (!roman || !bold) {
      const missing = roman ? 'bold' : 'roman';
      warning =
        `Only one Neue Haas Grotesk weight was found — drop the missing one ` +
        `into the "${missing}" folder (Settings → Open fonts folder; any ` +
        'file name works) so it is not synthesized/substituted.';
    }
  } else {
    // No brand fonts: skip injection so print.css falls back to Arial.
    warning =
      'Neue Haas Grotesk font files were not found — the PDF uses the Arial ' +
      'fallback. Drop each weight into its folder ("roman" and "bold", any ' +
      `file name) under ${paths.fontsDir()} — Settings → Open fonts folder. ` +
      'That folder survives app updates.';
  }

  // ---- Inject the data ---------------------------------------------------
  // NOTE ON THE TRANSCRIPT: it is deliberately NOT part of the printed
  // document — a full transcript would swamp a notes PDF, and the app offers
  // Copy transcript / Save transcript for the raw text. It used to be passed
  // in here and silently ignored by print.html; the argument is gone rather
  // than left looking meaningful.
  //
  // JSON is not quite a subset of JS source: U+2028/U+2029 are valid in JSON
  // strings but are line terminators in JS, so escape them or the
  // executeJavaScript call would throw a SyntaxError.
  const data = Object.assign({}, meeting, { summary: summary || null });
  const payload = JSON.stringify(data)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  await win.webContents.executeJavaScript(`window.renderMeeting(${payload})`);

  // ---- Wait for fonts (gotcha #1) ----------------------------------------
  // printToPDF before document.fonts.ready produces wrong-font PDFs.
  // The explicit fonts.load() calls kick off the fetch even if layout has
  // not flushed yet; all resolve harmlessly when no @font-face exists.
  await win.webContents.executeJavaScript(
    `Promise.all([
       document.fonts.load("400 24pt '${FONT_FAMILY}'"),
       document.fonts.load("500 9pt '${FONT_FAMILY}'"),
       document.fonts.load("700 24pt '${FONT_FAMILY}'"),
     ]).catch(() => {}).then(() => document.fonts.ready).then(() => true)`
  );

  return { fontUsed, warning };
}

/**
 * Render the meeting PDF.
 * @param {object} args {meeting, summary, pageSize ('Letter'|'A4')}
 * @returns {Promise<{pdfPath: string, fontUsed: boolean, warning: string|null}>}
 */
async function renderMeetingPdf({ meeting, summary, pageSize }) {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  try {
    const { fontUsed, warning } = await renderIntoWindow(win, { meeting, summary });

    // ---- Print (gotcha #2) -------------------------------------------------
    // printBackground:true or the accent rules (background-color divs) drop.
    // The design's footer is an in-document colophon, so no running
    // header/footer templates here; margins are set explicitly (not via @page).
    const pdfBuffer = await win.webContents.printToPDF({
      printBackground: true,
      pageSize: pageSize === 'A4' ? 'A4' : 'Letter',
      margins: MARGIN_IN, // inches — shared with the preview's page chrome
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

// ---- Live preview ------------------------------------------------------------

// Exactly one preview window, reused. Re-rendering into the window the
// operator already has open is the whole point — a preview that piles up
// windows is a preview nobody opens twice.
let previewWin = null;

/**
 * Show (or refresh) the on-screen preview of the printed document.
 * @param {object} args {meeting, summary, pageSize, parent}
 * @returns {Promise<{ok: true, fontUsed: boolean, warning: string|null}>}
 */
async function openPdfPreview({ meeting, summary, pageSize, parent }) {
  if (!previewWin || previewWin.isDestroyed()) {
    previewWin = new BrowserWindow({
      width: 900,
      height: 1000,
      show: false,
      title: 'PDF preview',
      // A child window closes with its parent — otherwise closing the app's
      // main window would leave the preview running and the app alive.
      parent: parent && !parent.isDestroyed() ? parent : undefined,
      backgroundColor: '#55595f',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    previewWin.setMenuBarVisibility(false);
    previewWin.on('closed', () => {
      previewWin = null;
    });
  }

  const win = previewWin;
  const { fontUsed, warning } = await renderIntoWindow(win, { meeting, summary });
  await win.webContents.insertCSS(pageChromeCss(pageSize));

  if (win.isDestroyed()) return { ok: true, fontUsed, warning };
  win.show();
  win.focus();
  return { ok: true, fontUsed, warning };
}

module.exports = { renderMeetingPdf, openPdfPreview };
