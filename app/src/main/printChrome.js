'use strict';

// Page geometry for the on-screen PDF preview.
//
// print.html carries NO page geometry of its own: printToPDF supplies the paper
// size and the margins, so the template is just a column of content. On screen
// there is no printToPDF, so the preview has to draw the page itself — and it
// has to draw the same page, or it is showing something the operator will never
// receive.
//
// Kept in its own module (no electron import) so the numbers can be asserted
// against the real printToPDF margins in a test instead of trusted.

// Inches, matching the margins src/main/pdf.js passes to printToPDF.
const MARGIN_IN = { top: 0.6, bottom: 0.7, left: 0.6, right: 0.6 };

const PAPER_IN = {
  Letter: { width: 8.5, height: 11 },
  A4: { width: 8.27, height: 11.69 },
};

/** The CSS to insert into a preview window for a given page size. */
function pageChromeCss(pageSize) {
  const paper = PAPER_IN[pageSize === 'A4' ? 'A4' : 'Letter'];
  return `
    html { background: #55595f; padding: 24px 0 48px; }
    body {
      width: ${paper.width}in;
      min-height: ${paper.height}in;
      margin: 0 auto;
      padding: ${MARGIN_IN.top}in ${MARGIN_IN.right}in ${MARGIN_IN.bottom}in ${MARGIN_IN.left}in;
      background: #ffffff;
      box-shadow: 0 6px 28px rgba(0, 0, 0, 0.45);
    }
  `;
}

module.exports = { pageChromeCss, MARGIN_IN, PAPER_IN };
