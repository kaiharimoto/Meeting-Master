"""Stage 3a: summarize the transcript into a structured, presentation-style
summary with an Ollama model.

Output is a MeetingSummary rendered as a "deck" in the PDF:
  Key Takeaways · Decisions · Action Items (owner/due/priority) · Key Figures · Topics
See _ollama.py for the shared chat/token helpers and the reason these calls use
the native /api/chat endpoint.
"""

import logging

import httpx

from ..config import Settings
from ..models import ActionItem, MeetingMeta, MeetingSummary
from . import _ollama

log = logging.getLogger(__name__)

# Keep the printed deck tight and slide-like — hard caps so a chatty model
# can't blow out the PDF layout.
_MAX_TAKEAWAYS = 8
_MAX_DECISIONS = 8
_MAX_ACTIONS = 10
_MAX_FIGURES = 8
_MAX_TOPICS = 12

_VALID_PRIORITY = {"high", "normal", "low"}

_SCHEMA_HINT = (
    'Respond with ONLY a JSON object of this exact shape:\n'
    '{\n'
    '  "keyTakeaways": ["short bullet", ...],\n'
    '  "decisions": ["a decision that was made", ...],\n'
    '  "actionItems": [\n'
    '    {"task": "what to do", "owner": "name or empty", '
    '"due": "when as stated or empty", "priority": "high|normal|low"}\n'
    '  ],\n'
    '  "keyFigures": ["a notable number/date/amount with its context", ...],\n'
    '  "topics": ["short topic phrase", ...]\n'
    '}'
)

SYSTEM_PROMPT = (
    "You are a precise meeting-notes assistant. You read a meeting transcript "
    "and produce a STRUCTURED summary as JSON, suitable for a one-page "
    "presentation-style handout. Use ONLY information present in the transcript "
    "— never invent names, numbers, decisions, dates, or owners.\n\n"
    "Populate these sections:\n"
    "- keyTakeaways: the most important outcomes and conclusions, each a single "
    "crisp sentence.\n"
    "- decisions: concrete decisions the group actually made (agreements, "
    "approvals, choices). One decision per string. Empty array if none.\n"
    "- actionItems: things someone must DO after the meeting. For each, give the "
    "task, the owner (the person responsible, or empty string if unstated), the "
    "due date/timeframe exactly as stated (e.g. 'Nov 15', 'next sprint', or "
    "empty string), and a priority of 'high', 'normal', or 'low'.\n"
    "- keyFigures: notable numbers, dates, amounts, or percentages mentioned, "
    "each with a few words of context (e.g. '12% price increase, locked 24 "
    "months').\n"
    "- topics: the subjects discussed, as short noun phrases (2-5 words), not "
    "sentences.\n\n"
    "String array elements carry no leading bullet character. Omit a section "
    "(empty array) only if the transcript truly has none. " + _SCHEMA_HINT
)

# A single low-token-cost consolidation of per-chunk partials for long
# transcripts (see run() below).
_MERGE_SYSTEM_PROMPT = (
    "You merge several partial structured summaries of ONE meeting into a "
    "single structured summary. Deduplicate overlapping points, keep the most "
    "specific wording, and preserve every distinct takeaway, decision, action "
    "item, figure, and topic. Invent nothing. " + _SCHEMA_HINT
)


def external_prompt(transcript_text: str, meeting: MeetingMeta) -> str:
    """The exact prompt harness this server sends to its local model, packaged
    for pasting into ANY external chatbot (Claude, ChatGPT, …). Kept as the
    single source of truth: it embeds the real summarize AND extract system
    prompts, so the external model produces one combined JSON that the app's
    "Import AI output" button round-trips — summary sections into the editor,
    Q&A candidates into the same review-and-approve flow the local model
    feeds. Served by GET /jobs/{id}/prompt and the dashboard's per-job link."""
    from . import extract  # sibling stage — its rules travel with the prompt

    context = _ollama.meeting_context(meeting)
    return (
        "=== INSTRUCTIONS (system prompt) "
        "==========================================\n\n"
        "You will produce BOTH a structured meeting summary AND the meeting's "
        "question-and-answer pairs, as ONE JSON object of this exact shape:\n"
        "{\n"
        '  "summary": { …the summary sections described in PART 1… },\n'
        '  "questions": [ …the Q&A objects described in PART 2… ]\n'
        "}\n\n"
        "--- PART 1: rules for the \"summary\" object ---\n\n"
        f"{SYSTEM_PROMPT}\n\n"
        "--- PART 2: rules for the \"questions\" array ---\n\n"
        f"{extract.SYSTEM_PROMPT}\n\n"
        "IMPORTANT: ignore the per-part instructions to respond with only that "
        "part's object — nest the summary sections under the top-level "
        '"summary" key and the Q&A array under the top-level "questions" key, '
        "and respond with ONLY that one combined JSON object.\n\n"
        "=== TASK "
        "==================================================================\n\n"
        f"{context}\n"
        "Produce the combined JSON for the following meeting transcript:\n\n"
        f"{transcript_text}\n\n"
        "=== WHAT TO DO WITH THE REPLY "
        "=============================================\n\n"
        "Copy the model's JSON reply. In Meeting Master, open Edit summary → "
        "Import AI output, paste it, click Apply import, then Save. Detected "
        "questions appear in the Q&A panel's review prompt for approval, and "
        "the PDF generates as usual."
    )


def _string_list(data: dict, key: str, *aliases: str, limit: int) -> list[str]:
    raw = data.get(key)
    for alias in aliases:
        if not raw:
            raw = data.get(alias)
    if not isinstance(raw, list):
        return []
    cleaned = [_ollama.clean_bullet(item) for item in raw]
    return [b for b in cleaned if b][:limit]


def _action_items(data: dict) -> list[ActionItem]:
    raw = data.get("actionItems")
    if not raw:
        raw = data.get("action_items")
    if not isinstance(raw, list):
        return []
    out: list[ActionItem] = []
    for item in raw:
        if len(out) >= _MAX_ACTIONS:  # cap applies to BOTH branches below
            break
        if isinstance(item, str):
            # Some models emit a bare string; treat it as an ownerless task.
            task = _ollama.clean_bullet(item)
            if task:
                out.append(ActionItem(task=task))
            continue
        if not isinstance(item, dict):
            continue
        task = _ollama.clean_bullet(item.get("task") or item.get("action") or "")
        if not task:
            continue
        priority = str(item.get("priority") or "normal").strip().lower()
        if priority not in _VALID_PRIORITY:
            priority = "normal"
        out.append(
            ActionItem(
                task=task,
                owner=str(item.get("owner") or item.get("assignee") or "").strip(),
                due=str(item.get("due") or item.get("dueDate") or item.get("when") or "").strip(),
                priority=priority,
            )
        )
    return out


def _coerce(parsed) -> MeetingSummary:
    """Turn the model's JSON into a MeetingSummary, defensively."""
    data = parsed if isinstance(parsed, dict) else {}
    return MeetingSummary(
        keyTakeaways=_string_list(data, "keyTakeaways", "key_takeaways", limit=_MAX_TAKEAWAYS),
        decisions=_string_list(data, "decisions", "decisionsMade", limit=_MAX_DECISIONS),
        actionItems=_action_items(data),
        keyFigures=_string_list(data, "keyFigures", "key_figures", "figures", limit=_MAX_FIGURES),
        topics=_string_list(data, "topics", "topicsDiscussed", limit=_MAX_TOPICS),
    )


def _merge(summaries: list[MeetingSummary]) -> MeetingSummary:
    """Concatenate section lists across partials, de-duplicating case-folded."""
    merged = MeetingSummary()
    # String sections.
    for field, limit in (
        ("keyTakeaways", _MAX_TAKEAWAYS),
        ("decisions", _MAX_DECISIONS),
        ("keyFigures", _MAX_FIGURES),
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
    # Action items, de-duplicated by task text.
    seen_tasks: set[str] = set()
    actions: list[ActionItem] = []
    for s in summaries:
        for ai in s.actionItems:
            key = ai.task.casefold()
            if key in seen_tasks:
                continue
            seen_tasks.add(key)
            actions.append(ai)
    merged.actionItems = actions[:_MAX_ACTIONS]
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
            if consolidated.keyTakeaways or consolidated.topics or consolidated.actionItems:
                return consolidated
        except Exception:
            # The consolidation pass is a best-effort refinement; ANY failure
            # (HTTP, bad JSON, an unexpected 200 envelope -> KeyError, ...) must
            # fall through to the already-computed merged partials, never
            # discard them.
            log.warning("Summary consolidation pass failed — using merged partials",
                        exc_info=True)
        return merged
