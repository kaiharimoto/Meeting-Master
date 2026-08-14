"""Stage 3b: extract candidate Q&A pairs from the transcript with an Ollama
model.

These are CANDIDATES only — the laptop presents them for the operator to
approve (or cull) before any become meeting cards. For each detected question
the model guesses ``answerer`` (who actually answered — the field that matters,
since it becomes the card's participant) and ``directedTo`` (who the question
seemed aimed at / who could answer — a softer culling aid).

See _ollama.py for the shared chat/token helpers.
"""

import asyncio
import logging

import httpx

from ..config import Settings
from ..models import (
    AnsweredQuestion,
    ExtractedQuestion,
    LiveSuggestions,
    MeetingMeta,
)
from . import _ollama, _provider

log = logging.getLogger(__name__)

# Keep the approval list reviewable; a real meeting rarely has more real Q&A.
_MAX_QUESTIONS = 30

# A live tick offers a handful of insights at most — the rail is peripheral,
# glanced at between questions, and a long list there is a list nobody reads.
_MAX_LIVE_INSIGHTS = 4

# Answer-drafting runs after the meeting with the operator waiting on it, so
# it can afford longer than the live path but not the full summarize budget.
ANSWER_TIMEOUT = httpx.Timeout(180.0, connect=5.0)

# One question at a time, but several in flight — each has its own transcript
# window, so batching them into one prompt would just invite cross-talk.
_ANSWER_CONCURRENCY = 3

_ANSWER_SYSTEM_PROMPT = (
    "You are a meeting-analysis assistant. You are given ONE question that a "
    "note-taker wrote down during a meeting, and the part of the transcript "
    "around the moment they wrote it. Find the answer that was actually given "
    "in that excerpt.\n\n"
    "Output:\n"
    "- answer: the answer as it was given, concise but complete. If the "
    "excerpt does not contain an answer, use an empty string.\n"
    "- answerer: the name of the person who gave the answer, chosen from the "
    "listed attendees when the transcript makes it clear who spoke; otherwise "
    "an empty string. Never guess a name the transcript does not support.\n"
    "- confidence: 'high' only if the excerpt plainly contains the answer, "
    "otherwise 'low'.\n\n"
    "Use ONLY what is in the excerpt. NEVER invent an answer — an empty answer "
    "is a correct and useful result when the excerpt does not contain one.\n"
    'Respond with ONLY a JSON object of this exact shape:\n'
    '{"answer": "...", "answerer": "...", "confidence": "high or low"}'
)

_SCHEMA_HINT = (
    'Respond with ONLY a JSON object of this exact shape:\n'
    '{\n'
    '  "questions": [\n'
    '    {\n'
    '      "question": "the question as asked, cleaned up",\n'
    '      "answer": "the answer that was given",\n'
    '      "answerer": "name of who actually answered, or empty string",\n'
    '      "directedTo": "name of who the question was aimed at, or empty string",\n'
    '      "confidence": "high or low — how sure you are of the answerer"\n'
    '    }\n'
    '  ]\n'
    '}'
)

SYSTEM_PROMPT = (
    "You are a meeting-analysis assistant. Read a meeting transcript and find "
    "the QUESTIONS that were asked AND received a substantive answer during the "
    "meeting. Ignore rhetorical questions and small talk.\n\n"
    "For each question output:\n"
    "- question: the question, cleaned into a clear single sentence.\n"
    "- answer: the answer that was given, concise but complete.\n"
    "- answerer: the name of the person who actually gave the answer. Choose "
    "from the listed attendees when the transcript makes it clear who spoke; "
    "otherwise use an empty string. Never guess a name that is not supported "
    "by the transcript.\n"
    "- directedTo: the name of the person the question appeared to be aimed at "
    "(who was expected to answer), or an empty string.\n"
    "- confidence: 'high' if the transcript clearly identifies who gave the "
    "answer, otherwise 'low'. Use 'low' whenever the answerer is a guess or "
    "unknown.\n\n"
    "Use ONLY information in the transcript — never invent questions, answers, "
    "or names. If no genuine Q&A pairs exist, return an empty questions array.\n\n"
    "EMPHASIS: in the question and in the answer, wrap the key phrase in "
    "**double asterisks** (markdown bold) so it stands out on the printed "
    "page. At most one or two SHORT bold spans each; never bold a whole "
    "sentence, and use no other markdown. Leave the name fields unmarked. "
    + _SCHEMA_HINT
)

# ---- Live (mid-meeting) prompt ------------------------------------------------
# The live path asks for the SAME Q&A pairs plus insights, from a partial and
# rough transcript. Separate from SYSTEM_PROMPT because the instructions differ
# in kind, not just in degree: silence beats speculation here (the operator is
# in a meeting), and the post-meeting run over the full transcript is what
# catches anything held back.

_LIVE_SCHEMA_HINT = (
    'Respond with ONLY a JSON object of this exact shape:\n'
    '{\n'
    '  "questions": [\n'
    '    {\n'
    '      "question": "the question as asked, cleaned up",\n'
    '      "answer": "the answer that was given",\n'
    '      "answerer": "name of who actually answered, or empty string",\n'
    '      "directedTo": "name of who the question was aimed at, or empty string",\n'
    '      "confidence": "high or low — how sure you are of the answerer"\n'
    '    }\n'
    '  ],\n'
    '  "insights": ["a lesson to apply going forward", ...]\n'
    '}'
)

LIVE_SYSTEM_PROMPT = (
    "You are a meeting-analysis assistant listening to a meeting that is STILL "
    "IN PROGRESS. You are given a rough, machine-transcribed excerpt of the "
    "last few minutes. A note-taker sees your output in a side panel and "
    "approves items one at a time, so a short, high-quality list beats a long "
    "speculative one. Return TWO things:\n\n"
    "1. questions — questions that were asked AND already answered in this "
    "excerpt. Ignore rhetorical questions and small talk. For each:\n"
    "- question: the question, cleaned into a clear single sentence.\n"
    "- answer: the answer that was given, concise but complete.\n"
    "- answerer: the name of the person who actually gave the answer, chosen "
    "from the listed attendees when the excerpt makes it clear who spoke; "
    "otherwise an empty string. Never guess a name the excerpt does not "
    "support.\n"
    "- directedTo: the name of the person the question appeared to be aimed at, "
    "or an empty string.\n"
    "- confidence: 'high' only if the excerpt clearly identifies who answered, "
    "otherwise 'low'.\n\n"
    "2. insights — LESSONS TO APPLY GOING FORWARD that this excerpt supports: "
    "something that is going wrong and should be handled differently, a risk or "
    "pattern worth planning around, or a practice worth repeating. Each a "
    "single forward-looking sentence. An insight is NOT a summary of what was "
    "said — do not restate the discussion, and do not repeat a question or its "
    "answer as an insight. Most excerpts of a live meeting contain NO real "
    "insight; an empty array is the correct and expected answer then. Never "
    "offer generic meeting advice.\n\n"
    "Use ONLY what is in the excerpt. Never invent questions, answers, names, "
    "or insights. Both arrays may be empty. " + _LIVE_SCHEMA_HINT
)


def _coerce(parsed) -> list[ExtractedQuestion]:
    """Turn the model's JSON into ExtractedQuestion records, defensively."""
    if isinstance(parsed, dict):
        raw = parsed.get("questions")
        if not isinstance(raw, list):
            # Some models drop the wrapper and return a single object.
            raw = [parsed] if parsed.get("question") else []
    elif isinstance(parsed, list):
        raw = parsed
    else:
        raw = []

    out: list[ExtractedQuestion] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        question = str(item.get("question") or "").strip()
        if not question:
            continue
        answerer = str(item.get("answerer") or "").strip()
        confidence = str(item.get("confidence") or "").strip().lower()
        # No answerer => nothing to be confident about; force low so the UI
        # flags it. Anything the model didn't clearly mark "high" is treated low.
        if not answerer or confidence != "high":
            confidence = "low"
        out.append(
            ExtractedQuestion(
                question=question,
                answer=str(item.get("answer") or "").strip(),
                answerer=answerer,
                directedTo=str(item.get("directedTo") or item.get("directed_to") or "").strip(),
                confidence=confidence,
            )
        )
    return out


def _dedupe(questions: list[ExtractedQuestion]) -> list[ExtractedQuestion]:
    """Drop repeats (case-folded question text) while preserving order."""
    seen: set[str] = set()
    out: list[ExtractedQuestion] = []
    for q in questions:
        key = q.question.casefold()
        if key in seen:
            continue
        seen.add(key)
        out.append(q)
    return out[:_MAX_QUESTIONS]


def _live_timeout(settings: Settings) -> httpx.Timeout:
    """Server-side budget for one live call.

    Bounded by LIVE_TIMEOUT_SEC rather than the summarize stage's generous
    read timeout: the laptop calls on a fixed interval while the meeting runs,
    so a hung call must die rather than queue behind itself. The laptop derives
    its own HTTP timeout from this same number (GET /live/config).
    """
    return httpx.Timeout(float(max(10, settings.LIVE_TIMEOUT_SEC)), connect=5.0)


def _coerce_insights(parsed) -> list[str]:
    """The ``insights`` array from a live reply -> clean bullet strings."""
    if not isinstance(parsed, dict):
        return []
    raw = parsed.get("insights")
    if not isinstance(raw, list):
        raw = parsed.get("keyInsights")
    if not isinstance(raw, list):
        return []
    out: list[str] = []
    seen: set[str] = set()
    for item in raw:
        # Tolerate {"insight": "..."} as well as a bare string — models drift.
        if isinstance(item, dict):
            item = item.get("insight") or item.get("text") or ""
        text = _ollama.clean_bullet(item)
        if not text:
            continue
        key = text.casefold()
        if key in seen:
            continue
        seen.add(key)
        out.append(text)
    return out[:_MAX_LIVE_INSIGHTS]


async def run_live(
    window_text: str,
    attendees: list[str],
    already_flagged: list[str],
    already_insights: list[str],
    settings: Settings,
) -> LiveSuggestions:
    """Suggest Q&A pairs AND key insights from a PARTIAL live transcript window.

    Called mid-meeting by the laptop (POST /live/questions). Same contract as
    the post-meeting run() — suggestions only, the operator approves each one —
    but a single fast chat call: the window is capped by the route, the answer
    budget is small (LIVE_EXTRACT_NUM_PREDICT), and the model is
    ``settings.live_model`` (which may be a smaller one than the summary model)
    held resident between ticks via keep_alive. The post-meeting pipeline over
    the full, higher-quality transcript remains the backstop for anything
    missed here.

    ``already_flagged`` / ``already_insights`` are what the operator has
    already been offered this session; both are excluded from the prompt AND
    filtered from the result, so the rail never shows the same thing twice.
    """
    attendee_line = ", ".join(attendees) if attendees else "(not listed)"
    flagged_block = (
        "\n".join(f"- {q}" for q in already_flagged) if already_flagged else "(none)"
    )
    insights_block = (
        "\n".join(f"- {i}" for i in already_insights) if already_insights else "(none)"
    )
    user_prompt = (
        f"Attendees: {attendee_line}\n"
        "This is a PARTIAL, ROUGH live transcript of a meeting that is still "
        "in progress (machine-transcribed; names may be misspelled). Extract "
        "only question-and-answer pairs where the answer already appears in "
        "this excerpt, plus any insights this excerpt genuinely supports.\n"
        "Do NOT repeat any of these already-suggested questions:\n"
        f"{flagged_block}\n"
        "Do NOT repeat any of these already-suggested insights:\n"
        f"{insights_block}\n\n"
        "Transcript excerpt:\n\n"
        f"{window_text}"
    )
    # _ollama, NOT _provider: see the note on warm_live_model below.
    async with httpx.AsyncClient(timeout=_live_timeout(settings)) as client:
        parsed = await _ollama.chat_json(
            client, settings, LIVE_SYSTEM_PROMPT, user_prompt,
            num_predict=settings.LIVE_EXTRACT_NUM_PREDICT,
            temperature=settings.EXTRACT_TEMPERATURE,
            model=settings.live_model,
            keep_alive=settings.live_keep_alive,
        )
    questions = _dedupe(_coerce(parsed))
    # Belt-and-braces: the model was told not to repeat itself, but drop exact
    # repeats anyway so the laptop never re-surfaces one.
    flagged_keys = {q.casefold().strip() for q in already_flagged}
    seen_insights = {i.casefold().strip() for i in already_insights}
    return LiveSuggestions(
        questions=[
            q for q in questions if q.question.casefold().strip() not in flagged_keys
        ],
        insights=[
            i for i in _coerce_insights(parsed)
            if i.casefold().strip() not in seen_insights
        ],
    )


async def warm_live_model(settings: Settings) -> None:
    """Load the live model into VRAM (and pin it there) before the ticks start.

    Called once when a live session begins. The first mid-meeting call would
    otherwise pay a cold model load on top of its own work — frequently the
    difference between a suggestion arriving and a tick timing out. Raises on
    failure so the caller can report WHY live suggestions won't work.

    OLLAMA ALWAYS, whatever AI_PROVIDER says — and this is a decision, not an
    oversight, so please don't "fix" the inconsistency by routing it back
    through _provider. AI_PROVIDER chooses who writes the notes AFTER the
    meeting. The live path is a different problem: it ticks every
    LIVE_INTERVAL_SEC (45s by default), and it is fast enough to be useful only
    because the model stays resident in VRAM between ticks (keep_alive) and
    answers into a small budget. The Claude CLI spawns a process per call, keeps
    nothing resident, needs a network round trip, and spends subscription usage
    every tick — it loses on every one of those counts. Local is the right
    backend here on the merits.
    """
    async with httpx.AsyncClient(timeout=_live_timeout(settings)) as client:
        await _ollama.chat_json(
            client, settings,
            'You are a health check. Respond with ONLY the JSON {"ok": true}.',
            "Reply now.",
            num_predict=16,
            temperature=0.0,
            model=settings.live_model,
            keep_alive=settings.live_keep_alive,
        )


async def run(
    transcript_text: str, meeting: MeetingMeta, settings: Settings
) -> list[ExtractedQuestion]:
    context = _ollama.meeting_context(meeting)
    num_predict = settings.EXTRACT_NUM_PREDICT
    temperature = settings.EXTRACT_TEMPERATURE
    budget_tokens = _provider.input_budget_tokens(settings, num_predict, "Q&A extraction")

    async with httpx.AsyncClient(timeout=_ollama.DEFAULT_TIMEOUT) as client:
        if _ollama.estimate_tokens(transcript_text) <= budget_tokens:
            user_prompt = (
                f"{context}\n"
                "Extract the question-and-answer pairs from this meeting "
                "transcript:\n\n"
                f"{transcript_text}"
            )
            parsed = await _provider.chat_json(
                client, settings, SYSTEM_PROMPT, user_prompt,
                num_predict=num_predict, temperature=temperature,
            )
            return _dedupe(_coerce(parsed))

        # Long transcript: extract per chunk and concatenate. Q&A pairs are
        # local to their part, so no cross-chunk merge pass is needed.
        chunks = _ollama.split_by_token_budget(transcript_text, max(budget_tokens, 1))
        log.info(
            "Transcript ~%d tokens exceeds budget of %d — extracting from %d parts",
            _ollama.estimate_tokens(transcript_text), budget_tokens, len(chunks),
        )
        collected: list[ExtractedQuestion] = []
        for index, chunk in enumerate(chunks, start=1):
            prompt = (
                f"{context}\n"
                f"Extract the question-and-answer pairs from PORTION {index} of "
                f"{len(chunks)} of a longer meeting transcript:\n\n"
                f"{chunk}"
            )
            parsed = await _provider.chat_json(
                client, settings, SYSTEM_PROMPT, prompt,
                num_predict=num_predict, temperature=temperature,
            )
            collected.extend(_coerce(parsed))
        return _dedupe(collected)


# ---- Answer drafting for operator-captured questions -------------------------


def _coerce_answer(parsed, card_id: str) -> AnsweredQuestion:
    """One model reply -> an AnsweredQuestion, defensively.

    An unparseable or empty reply is not an error: "no answer in this excerpt"
    is a legitimate outcome, and the operator sees the blank and moves on.
    """
    if not isinstance(parsed, dict):
        return AnsweredQuestion(id=card_id, confidence="low")
    answer = str(parsed.get("answer") or "").strip()
    answerer = str(parsed.get("answerer") or "").strip()
    confidence = str(parsed.get("confidence") or "").strip().lower()
    # An answer with nobody attached, or no answer at all, is never "high".
    if confidence != "high" or not answer or not answerer:
        confidence = "low"
    return AnsweredQuestion(
        id=card_id, answer=answer, answerer=answerer, confidence=confidence
    )


async def run_answers(
    items: list[dict],
    attendees: list[str],
    settings: Settings,
) -> list[AnsweredQuestion]:
    """Draft an answer for each captured question from its transcript window.

    ``items`` are ``{"id", "question", "window"}`` — the route owns slicing the
    window out of the transcript, because only it has the timed segments.
    Questions run concurrently (bounded), and one failure yields an empty
    answer for that question rather than failing the whole request: a partial
    result is still useful, and the operator approves each one anyway.
    """
    attendee_line = ", ".join(attendees) if attendees else "(not listed)"
    semaphore = asyncio.Semaphore(_ANSWER_CONCURRENCY)

    async def draft(client: httpx.AsyncClient, item: dict) -> AnsweredQuestion:
        card_id = str(item.get("id") or "")
        question = str(item.get("question") or "").strip()
        window = str(item.get("window") or "").strip()
        if not question or not window:
            return AnsweredQuestion(id=card_id, confidence="low")
        user_prompt = (
            f"Attendees: {attendee_line}\n\n"
            f"Question written down by the note-taker:\n{question}\n\n"
            "Transcript around the moment it was written "
            "(machine-transcribed; names may be misspelled):\n\n"
            f"{window}"
        )
        async with semaphore:
            try:
                parsed = await _provider.chat_json(
                    client, settings, _ANSWER_SYSTEM_PROMPT, user_prompt,
                    num_predict=settings.LIVE_EXTRACT_NUM_PREDICT,
                    temperature=settings.EXTRACT_TEMPERATURE,
                )
            except Exception as exc:  # one bad question must not sink the rest
                log.warning("Answer drafting failed for card %s: %s", card_id, exc)
                return AnsweredQuestion(id=card_id, confidence="low")
        return _coerce_answer(parsed, card_id)

    async with httpx.AsyncClient(timeout=ANSWER_TIMEOUT) as client:
        return list(await asyncio.gather(*(draft(client, i) for i in items)))
