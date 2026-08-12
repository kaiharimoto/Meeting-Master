// Makes the licensed brand font available to the app UI.
//
// Until now Neue Haas Grotesk existed only in the PDF: src/main/pdf.js injects
// @font-face into the hidden print window at render time, and the app itself
// has always used the system stack. The immersive transcript reader is the
// first place where the operator READS at length on screen, and it should look
// like the document it will become — so the font has to reach the renderer.
//
// The bytes arrive as data: URIs from the main process (see FONTS_FACES in
// src/main/ipc.js) rather than file:// paths: the fonts live in
// <userData>/fonts, outside the app origin the CSP is scoped to, and that
// directory moves between dev and packaged builds.
//
// Licensed fonts are git-ignored and may simply not be installed (docs/FONTS.md
// treats Medium as optional even when the others are present). That is not an
// error condition: everything here degrades to the fallback stack in silence.

let loaded = null; // in-flight or settled promise — load at most once

/**
 * Inject @font-face rules for the brand font, once per session.
 * Resolves true when at least one weight is now available, false otherwise.
 */
export function ensureBrandFont(api) {
  if (loaded) return loaded;
  loaded = injectOnce(api).catch(() => false);
  return loaded;
}

async function injectOnce(api) {
  if (!api || typeof api.getFontFaces !== 'function') return false;

  const { faces } = (await api.getFontFaces()) || {};
  if (!Array.isArray(faces) || faces.length === 0) return false;

  const rules = faces.map(
    (face) =>
      `@font-face { font-family: '${face.family}'; ` +
      `src: url('${face.dataUrl}'); ` +
      `font-weight: ${face.weight}; font-style: normal; font-display: swap; }`
  );

  const style = document.createElement('style');
  style.id = 'brand-font-faces';
  style.textContent = rules.join('\n');
  document.head.append(style);

  // Mark the document so CSS can opt in only once the font can actually
  // render — switching font-family on a fallback would reflow mid-read.
  document.documentElement.dataset.brandFont = 'on';
  return true;
}
