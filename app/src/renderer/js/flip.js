// FLIP (First, Last, Invert, Play) for list reordering.
//
// The cards are a plain flex column, so any reorder or removal is an instant
// jump: the browser reflows and the new positions are simply there. FLIP makes
// that legible — measure where things were, do the mutation, then animate each
// element from its old position to its new one. Nothing about the layout
// changes; only the perception of it.
//
// Reduced motion is honoured by SKIPPING the animation entirely rather than
// shortening it — a 0.01ms transform animation is still a transform.

const DURATION = 200;

function prefersReducedMotion() {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/**
 * Run `mutate` and animate the container's children from their old positions.
 * `skip` (optional) is an element to leave alone — the one the pointer is
 * already carrying during a drag.
 */
export function flip(container, mutate, { skip = null } = {}) {
  if (prefersReducedMotion()) {
    mutate();
    return;
  }

  const before = new Map();
  for (const el of container.children) before.set(el, el.getBoundingClientRect().top);

  mutate();

  for (const el of container.children) {
    if (el === skip) continue;
    const start = before.get(el);
    if (start === undefined) continue; // newly added — it has its own entrance
    const delta = start - el.getBoundingClientRect().top;
    if (!delta) continue;

    el.style.transition = 'none';
    el.style.transform = `translateY(${delta}px)`;
    // Two frames: one to commit the inverted position, one to release it.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        el.style.transition = `transform ${DURATION}ms cubic-bezier(0.2, 0.7, 0.3, 1)`;
        el.style.transform = '';
        setTimeout(() => {
          el.style.transition = '';
        }, DURATION);
      });
    });
  }
}

/**
 * Collapse an element out of the list, then run `after` — used so a deleted
 * card leaves visibly instead of vanishing under the toast that explains it.
 */
export function animateOut(el, after) {
  if (prefersReducedMotion()) {
    after();
    return;
  }
  const height = el.getBoundingClientRect().height;
  el.style.overflow = 'hidden';
  el.style.height = `${height}px`;
  el.getBoundingClientRect(); // force the start value to be committed
  el.style.transition = `height 140ms ease, opacity 140ms ease, margin 140ms ease`;
  el.style.height = '0px';
  el.style.opacity = '0';
  el.style.marginBottom = `-${getComputedStyle(el.parentElement).rowGap || '0px'}`;
  setTimeout(after, 140);
}
