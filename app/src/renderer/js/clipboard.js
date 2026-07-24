// One way to put text on the clipboard, used by every Copy button.
//
// navigator.clipboard is the right API, but it can reject for reasons that
// have nothing to do with the text: a denied clipboard permission (see the
// permission handler in src/main/main.js — granting only `media` there broke
// every Copy button in v0.8.0) or a transiently unfocused document. Falling
// back to the legacy execCommand path keeps copying working in those cases;
// it is deprecated but fully supported in Chromium and needs no permission.

export async function copyText(text) {
  const value = String(text ?? '');
  if (!value) return false;

  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // Permission denied / document not focused — try the fallback below.
  }

  return legacyCopy(value);
}

function legacyCopy(value) {
  const area = document.createElement('textarea');
  area.value = value;
  // Off-screen but focusable: execCommand('copy') needs a real selection, and
  // display:none / hidden elements cannot hold one.
  area.setAttribute('aria-hidden', 'true');
  area.style.position = 'fixed';
  area.style.top = '-1000px';
  area.style.opacity = '0';
  document.body.append(area);
  const previous = document.activeElement;
  try {
    area.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
    if (previous && typeof previous.focus === 'function') previous.focus();
  }
}
