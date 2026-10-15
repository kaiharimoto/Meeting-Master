// Parse a transcript file made OUTSIDE the home server (v0.8.0) — e.g. a
// local whisper run on the laptop — into the same {text, segments} shape the
// server stores, so the rest of the app (PDF, Fix names, Copy AI prompt)
// can't tell the difference. Accepted: plain .txt, whisper "[ts --> ts] text"
// console lines, .srt, .vtt, and whisper JSON (whisper.cpp -oj, or the
// openai/faster-whisper {text, segments} shape this app itself exports).

const MAX_CHARS = 5_000_000; // a 10-hour meeting is ~600k; anything bigger is not a transcript

/** "01:02:03,456" / "02:03.456" / "3.5" -> seconds. */
function toSeconds(stamp) {
  const parts = String(stamp).trim().replace(',', '.').split(':').map(Number);
  if (parts.some((n) => Number.isNaN(n))) return 0;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

function finish(segments, fallbackText) {
  const clean = segments
    .map((s) => ({ start: s.start || 0, end: s.end || 0, text: String(s.text || '').trim() }))
    .filter((s) => s.text);
  const text = clean.length ? clean.map((s) => s.text).join(' ') : String(fallbackText || '').trim();
  return { text, segments: clean };
}

function fromJson(data) {
  if (data && Array.isArray(data.transcription)) {
    // whisper.cpp -oj: offsets in milliseconds.
    return finish(
      data.transcription.map((seg) => ({
        start: Number((seg.offsets || {}).from || 0) / 1000,
        end: Number((seg.offsets || {}).to || 0) / 1000,
        text: seg.text,
      }))
    );
  }
  if (data && (Array.isArray(data.segments) || typeof data.text === 'string')) {
    const segs = Array.isArray(data.segments) ? data.segments : [];
    const parsed = finish(
      segs.map((seg) => ({ start: Number(seg.start) || 0, end: Number(seg.end) || 0, text: seg.text })),
      data.text
    );
    // Prefer the file's own full text when it has one (keeps its punctuation/spacing).
    if (typeof data.text === 'string' && data.text.trim()) parsed.text = data.text.trim();
    return parsed;
  }
  throw new Error('That JSON is not a whisper transcript (expected "transcription" or "text"/"segments").');
}

const CUE_RE =
  /^\s*(\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3}\s*-->\s*(\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3}/;

function fromCues(content) {
  // SRT / WebVTT: blocks of [index] / "a --> b" / text lines.
  const segments = [];
  for (const block of content.split(/\r?\n\s*\r?\n/)) {
    const lines = block.split(/\r?\n/);
    const idx = lines.findIndex((l) => CUE_RE.test(l));
    if (idx === -1) continue;
    const [a, b] = lines[idx].split('-->');
    const text = lines
      .slice(idx + 1)
      .map((l) => l.replace(/<[^>]+>/g, '').trim()) // strip VTT voice/style tags
      .filter(Boolean)
      .join(' ');
    segments.push({ start: toSeconds(a), end: toSeconds(b.trim().split(/\s+/)[0]), text });
  }
  return finish(segments);
}

const CONSOLE_RE = /^\s*\[([\d:.,]+)\s*-->\s*([\d:.,]+)\]\s*(.*)$/;

function fromText(content) {
  const lines = content.split(/\r?\n/);
  const stamped = lines.filter((l) => CONSOLE_RE.test(l));
  if (stamped.length && stamped.length >= lines.filter((l) => l.trim()).length / 2) {
    // whisper console output: "[00:00:00.000 --> 00:00:04.000]  Hello."
    return finish(
      stamped.map((l) => {
        const m = l.match(CONSOLE_RE);
        return { start: toSeconds(m[1]), end: toSeconds(m[2]), text: m[3] };
      })
    );
  }
  // Plain text: one utterance per line is typical — join into running prose
  // like the server's transcript, keeping paragraph breaks.
  const text = content
    .split(/\r?\n\s*\r?\n/)
    .map((p) => p.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join(' '))
    .filter(Boolean)
    .join('\n\n');
  return { text, segments: [] };
}

/**
 * @param {string} fileName used only for its extension
 * @param {string} content  the file's text
 * @returns {{text: string, segments: {start:number,end:number,text:string}[]}}
 */
export function parseTranscriptFile(fileName, content) {
  let body = String(content || '').replace(/^﻿/, '');
  if (body.length > MAX_CHARS) throw new Error('That file is too large to be a transcript.');
  const ext = String(fileName || '').toLowerCase().split('.').pop();
  let result;
  if (ext === 'json' || /^\s*[{[]/.test(body)) {
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      if (ext === 'json') throw new Error('That .json file could not be parsed.');
      data = null;
    }
    result = data ? fromJson(data) : fromText(body);
  } else if (ext === 'srt' || ext === 'vtt' || /^WEBVTT/.test(body) || body.split(/\r?\n/, 3).some((l) => CUE_RE.test(l))) {
    result = fromCues(body.replace(/^WEBVTT[^\n]*\n/, ''));
  } else {
    result = fromText(body);
  }
  if (!result.text) throw new Error('That file has no transcript text in it.');
  return result;
}
