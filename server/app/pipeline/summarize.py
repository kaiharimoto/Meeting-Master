"""Stage 3a: summarize the transcript into a structured, presentation-style
summary with an Ollama model.

Output is a MeetingSummary with three bulleted sections — Key Takeaways,
Follow-Up Points, Topics Discussed — rendered as a "deck" in the PDF rather
than prose. See _ollama.py for the shared chat/token helpers and the reason
these calls use the native /api/chat endpoint.
"""

import logging

import httpx

from ..config import Settings
from ..models import MeetingMeta, MeetingSummary
from . import _ollama

log = logging.getLogger(__name__)

# Keep the printed summary tight and slide-like — hard caps so a chatty model
# can't blow out the PDF layout.
_MAX_TAKEAWAYS = 8
_MAX_FOLLOWUPS = 8
_MAX_TOPICS = 12

_SCHEMA_HINT = (
    'Respond with ONLY a JSON object of this exact shape:\n'
    '{\n'
    '  "keyTakeaways": ["short bullet", ...],\n'
    '  "followUps": ["short bullet", ...],\n'
    '  "topics": ["short topic phrase", ...]\n'
    '}'
)

SYSTEM_PROMPT = (
    "You are a precise meeting-notes assistant. You read a meeting transcript "
    "and produce a STRUCTURED summary as JSON, suitable for a one-page "
    "presentation-style handout. Use ONLY information present in the transcript "
    "— never invent names, numbers, decisions, dates, or owners.\n\n"
    "Populate three sections:\n"
    "- keyTakeaways: the most important decisions, outcomes, and conclusions. "
    "Each a single crisp sentence.\n"
    "- followUps: concrete action items, open questions, and next steps. Name "
    "the owner and any deadline when the transcript states them.\n"
    "- topics: the subjects that were discussed, as short noun phrases (2-5 "
    "words each), not sentences.\n\n"
    "Each array element is a plain string with no leading bullet character. "
    "Omit a section's items (empty array) only if the transcript truly has "
    "none. " + _SCHEMA_HINT
)

# A single low-token-cost consolidation of per-chunk partials for long
# transcripts (see run() below).
_MERGE_SYSTEM_PROMPT = (
    "You merge several partial structured summaries of ONE meeting into a "
    "single structured summary. Deduplicate overlapping points, keep the most "
    "specific wording, and preserve every distinct decision, action item, and "
    "topic. Invent nothing. " + _SCHEMA_HINT
)


def _coerce(parsed) -> MeetingSummary:
    """Turn the model's JSON into a MeetingSummary, defensively."""
    data = parsed if isinstance(parsed, dict) else {}

    def _list(key: str, *aliases: str, limit: int) -> list[str]:
        raw = data.get(key)
        for alias in aliases:
            if not raw:
                raw = data.get(alias)
        if not isinstance(raw, list):
            return []
        cleaned = [_ollama.clean_bullet(item) for item in raw]
        return [b for b in cleaned if b][:limit]

    return MeetingSummary(
        keyTakeaways=_list("keyTakeaways", "key_takeaways", limit=_MAX_TAKEAWAYS),
        followUps=_list("followUps", "follow_ups", "followups", limit=_MAX_FOLLOWUPS),
        topics=_list("topics", "topicsDiscussed", limit=_MAX_TOPICS),
    )


def _merge(summaries: list[MeetingSummary]) -> MeetingSummary:
    """Concatenate section lists across partials, de-duplicating case-folded."""
    merged = MeetingSummary()
    for field, limit in (
        ("keyTakeaways", _MAX_TAKEAWAYS),
        ("followUps", _MAX_FOLLOWUPS),
        ("topics", _MAX_TOPICS),
    ):
        seen: set[str] = set()
        out: list[str] = []
        for s in summaries:
            for item in getattr(s, field):
                key = item.casefold()
                if key in seen:
                    continue
                seen.add(key)
                out.append(item)
        setattr(merged, field, out[:limit])
    return merged


async def run(
    transcript_text: str, meeting: MeetingMeta, settings: Settings
) -> MeetingSummary:
    context = _ollama.meeting_context(meeting)
    num_predict = settings.SUMMARY_NUM_PREDICT
    temperature = settings.SUMMARY_TEMPERATURE
    budget_tokens = _ollama.input_budget_tokens(settings, num_predict)

    async with httpx.AsyncClient(timeout=_ollama.DEFAULT_TIMEOUT) as client:
        if _ollama.estimate_tokens(transcript_text) <= budget_tokens:
            user_prompt = (
                f"{context}\n"
                "Summarize the following meeting transcript into the JSON "
                "sections described:\n\n"
                f"{transcript_text}"
            )
            parsed = await _ollama.chat_json(
                client, settings, SYSTEM_PROMPT, user_prompt,
                num_predict=num_predict, temperature=temperature,
            )
            return _coerce(parsed)

        # CHUNKING SAFEGUARD: the transcript exceeds the context window.
        # Structure each chunk, then merge the partial summaries.
        chunks = _ollama.split_by_token_budget(transcript_text, max(budget_tokens, 1))
        log.info(
            "Transcript ~%d tokens exceeds budget of %d — summarizing in %d parts",
            _ollama.estimate_tokens(transcript_text), budget_tokens, len(chunks),
        )
        partials: list[MeetingSummary] = []
        for index, chunk in enumerate(chunks, start=1):
            prompt = (
                f"{context}\n"
                f"Summarize PORTION {index} of {len(chunks)} of a longer meeting "
                "transcript into the JSON sections described. Capture every "
                "substantive point in this portion:\n\n"
                f"{chunk}"
            )
            parsed = await _ollama.chat_json(
                client, settings, SYSTEM_PROMPT, prompt,
                num_predict=num_predict, temperature=temperature,
            )
            partials.append(_coerce(parsed))

        merged = _merge(partials)
        # One consolidation pass to dedupe/prioritize across the whole meeting.
        try:
            merge_prompt = (
                f"{context}\n"
                "Merge these partial structured summaries into one:\n\n"
                + merged.model_dump_json(indent=2)
            )
            parsed = await _ollama.chat_json(
                client, settings, _MERGE_SYSTEM_PROMPT, merge_prompt,
                num_predict=num_predict, temperature=temperature,
            )
            consolidated = _coerce(parsed)
            # Guard against the merge pass hallucinating everything away.
            if consolidated.keyTakeaways or consolidated.topics:
                return consolidated
        except Exception:
            # The consolidation pass is a best-effort refinement; ANY failure
            # (HTTP, bad JSON, an unexpected 200 envelope -> KeyError, ...) must
            # fall through to the already-computed merged partials, never
            # discard them.
            log.warning("Summary consolidation pass failed — using merged partials",
                        exc_info=True)
        return merged
