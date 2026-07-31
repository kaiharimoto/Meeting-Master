// Drag a card to a new position in the list.
//
// Pointer events rather than HTML5 drag-and-drop: no browser-drawn ghost image
// to fight, no dragover/dragenter dance, and it coexists with the sticky
// suggestions rail instead of dropping onto it. The drag runs entirely in the
// DOM — the state array is spliced ONCE, on drop — so an abandoned drag costs
// nothing and the undo toast has a single, clean thing to reverse.
//
// A dedicated grip starts the drag. Now that clicking a card's text opens an
// inline editor, "press anywhere and move" would be ambiguous with "click to
// edit"; a handle is unambiguous, and it's the affordance a pointer user looks
// for anyway.

import { flip } from './flip.js';

let container = null;
let onReorder = null;
let drag = null; // {el, pointerId, originY, startIndex} while live

export function initCardDrag(opts) {
  container = opts.container;
  onReorder = opts.onReorder;
}

/** Wire a card's grip. Called once per card element, at build time. */
export function bindDragHandle(handle, cardEl) {
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault(); // no text selection while dragging
    start(e, cardEl);
  });
}

function start(e, el) {
  drag = {
    el,
    pointerId: e.pointerId,
    // The pointer Y that corresponds to "no offset". Shifts whenever the DOM
    // moves the card out from under the cursor.
    originY: e.clientY,
    startIndex: indexOf(el),
  };
  el.classList.add('is-dragging');
  container.classList.add('is-reordering');

  // Listen on the WINDOW, not on the handle with setPointerCapture. The drag
  // reparents the card on every swap, and re-inserting an element releases its
  // pointer capture — so a captured drag delivers exactly one swap and then
  // goes silent. (That is precisely how this was first written.)
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
}

function indexOf(el) {
  return Array.prototype.indexOf.call(container.children, el);
}

// Where the element would sit with no drag offset applied.
function restingTop(el) {
  const transform = el.style.transform;
  el.style.transform = 'none';
  const top = el.getBoundingClientRect().top;
  el.style.transform = transform;
  return top;
}

function onMove(e) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  drag.el.style.transform = `translateY(${e.clientY - drag.originY}px)`;

  const rect = drag.el.getBoundingClientRect();
  const centre = rect.top + rect.height / 2;

  for (const sibling of Array.from(container.children)) {
    if (sibling === drag.el) continue;
    const sib = sibling.getBoundingClientRect();
    const draggedIsBefore = Boolean(
      sibling.compareDocumentPosition(drag.el) & Node.DOCUMENT_POSITION_PRECEDING
    );
    // Swap when the centre crosses the neighbour's MIDPOINT, not its edge —
    // edge-crossing makes cards of different heights flicker back and forth.
    const crossed = draggedIsBefore
      ? centre > sib.top + sib.height / 2
      : centre < sib.top + sib.height / 2;
    if (!crossed) continue;

    const before = restingTop(drag.el);
    flip(
      container,
      () => {
        if (draggedIsBefore) sibling.after(drag.el);
        else sibling.before(drag.el);
      },
      { skip: drag.el }
    );
    // The card just moved under the pointer; shift the origin by the same
    // amount so the visual position stays continuous instead of jumping.
    drag.originY += restingTop(drag.el) - before;
    drag.el.style.transform = `translateY(${e.clientY - drag.originY}px)`;
    break;
  }
}

function onUp(e) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  const { el, startIndex } = drag;
  window.removeEventListener('pointermove', onMove);
  window.removeEventListener('pointerup', onUp);
  window.removeEventListener('pointercancel', onUp);

  const endIndex = indexOf(el);
  el.style.transform = '';
  el.classList.remove('is-dragging');
  container.classList.remove('is-reordering');
  drag = null;

  if (endIndex !== startIndex && endIndex !== -1) onReorder(el.dataset.cardId, endIndex);
}
