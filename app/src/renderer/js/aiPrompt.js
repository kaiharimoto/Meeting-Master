// The external-AI prompt, built LOCALLY so Copy/Save AI prompt work with no
// home server — e.g. a transcript loaded from a file while away from home.
// The text is the server's own summarize.external_prompt(), exported into
// aiPromptText.js by `python -m app.tools.export_ai_prompt`; only the meeting
// context (a mirror of _ollama.meeting_context) is filled in here.
// server/tests/test_prompt_parity.py runs this under Node against the server.

import { CONTEXT_TOKEN, TRANSCRIPT_TOKEN, PROMPT_TEMPLATE } from './aiPromptText.js';

function meetingContext(details) {
  const d = details || {};
  const attendees =
    Array.isArray(d.attendees) && d.attendees.length ? d.attendees.join(', ') : '(not listed)';
  return (
    `Meeting title: ${d.title || ''}\n` +
    `Date: ${d.date || ''} ${d.time || ''}\n` +
    `Attendees: ${attendees}\n`
  );
}

/** The full paste-ready prompt for an external model (Claude, ChatGPT, …). */
export function buildExternalPrompt(transcriptText, details) {
  // split/join, not String.replace: a transcript containing "$&" must stay literal.
  return PROMPT_TEMPLATE.split(CONTEXT_TOKEN)
    .join(meetingContext(details))
    .split(TRANSCRIPT_TOKEN)
    .join(String(transcriptText));
}
