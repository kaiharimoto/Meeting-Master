// One way to render an offset into a recording, used everywhere a timestamp
// appears: the immersive reader, the saved .txt, and the PDF appendix.
//
// Meetings are usually under an hour, so the common form is m:ss and the hour
// field only appears when it is real — a wall of "0:04:12" reads worse than
// "4:12" and buys nothing. Minutes are NOT zero-padded in the short form for
// the same reason; seconds always are, because "4:7" is unreadable.

/**
 * Seconds -> "m:ss", widening to "h:mm:ss" at and past one hour.
 * Negative and non-finite inputs clamp to 0:00 rather than printing "NaN:aN" —
 * a bad timestamp should never be the reason a transcript won't render.
 */
export function formatTimecode(seconds) {
  const value = Number(seconds);
  // Number.isFinite, not `|| 0`: that catches NaN but passes Infinity straight
  // through, which renders as "Infinity:NaN:NaN".
  const total = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const ss = String(secs).padStart(2, '0');
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${ss}`;
  return `${minutes}:${ss}`;
}

/** Milliseconds -> the same format. The live path counts in ms. */
export function formatTimecodeMs(ms) {
  const value = Number(ms);
  return formatTimecode(Number.isFinite(value) ? value / 1000 : 0);
}

/**
 * Transcript segments -> "[m:ss] text" lines, one per segment.
 *
 * Returns null when there are no usable segments, so callers can fall back to
 * the flat `transcript.text` rather than writing out an empty file. Segments
 * whose text is empty are dropped: whisper emits them for silence, and they
 * would otherwise become a page of bare timestamps.
 */
export function segmentsToTimestampedText(segments) {
  if (!Array.isArray(segments) || segments.length === 0) return null;
  const lines = [];
  for (const seg of segments) {
    const text = seg && typeof seg.text === 'string' ? seg.text.trim() : '';
    if (!text) continue;
    lines.push(`[${formatTimecode(seg.start)}] ${text}`);
  }
  return lines.length > 0 ? lines.join('\n') : null;
}
