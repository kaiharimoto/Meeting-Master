'use strict';

// Which web permissions OUR pages may use.
//
// Registering ANY permission handler switches Electron from "allow by
// default" to "this handler decides", so this list must name every
// permission the app relies on. v0.8.0 granted only `media` and silently
// broke every Copy button ("Failed to execute 'writeText' on 'Clipboard':
// Write permission denied") — hence this module and its unit test.
//
// Scope: file:// pages only. The server-mode window navigates to the
// http://127.0.0.1 dashboard with the same session, and remote content must
// never get the microphone or the clipboard.

const ALLOWED_PERMISSIONS = Object.freeze([
  'media', // getUserMedia — in-app recording
  'clipboard-sanitized-write', // Copy transcript / AI prompt / email text
  'clipboard-read', // paste helpers in the renderer
  'display-capture', // getDisplayMedia — Windows loopback audio
]);

const ALLOWED = new Set(ALLOWED_PERMISSIONS);

/**
 * file:// pages report their origin as "file://" — or, in some Chromium
 * paths, as an opaque "null". Fall back to the sender's URL so a null origin
 * can't silently deny the mic or the clipboard.
 */
function isLocalPage({ url = '', origin = '' } = {}) {
  const o = String(origin || '');
  if (o.startsWith('file:')) return true;
  if (o && o !== 'null') return false; // a real remote origin (the dashboard)
  return String(url || '').startsWith('file:');
}

/** The single decision both Electron permission handlers delegate to. */
function isAllowed(permission, context) {
  return ALLOWED.has(permission) && isLocalPage(context);
}

module.exports = { ALLOWED_PERMISSIONS, isAllowed, isLocalPage };
