"""Stage 3b: extract candidate Q&A pairs from the transcript with an Ollama
model.

These are CANDIDATES only — the laptop presents them for the operator to
approve (or cull) before any become meeting cards. For each detected question
the model guesses ``answerer`` (who actually answered — the field that matters,
since it becomes the card's participant) and ``directedTo`` (who the question
seemed aimed at / who could answer — a softer culling aid).

See _ollama.py for the shared chat/token helpers.
"""

import logging

import httpx

from ..config import Settings
from ..models import ExtractedQuestion, MeetingMeta
from . import _ollama

log = logging.getLogger(__name__)

# Keep the approval list reviewable; a real meeting rarely has more real Q&A.
_MAX_QUESTIONS = 30

# Live extraction must fail fast: the laptop calls every ~30 s while the
# meeting is running, and a slow/hung call would queue behind itself. The
# window is small, so a healthy Ollama answers well inside this.
LIVE_TIMEOUT = httpx.Timeout(60.0, connect=5.0)

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
    "or names. If no genuine Q&A pairs exist, return an empty questions array. "
    + _SCHEMA_HINT
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


async def run_live(
    window_text: str,
    attendees: list[str],
    already_flagged: list[str],
    settings: Settings,
) -> list[ExtractedQuestion]:
    """Extract Q&A candidates from a PARTIAL live transcript window.

    Called mid-meeting by the laptop (POST /live/questions). Same contract as
    the post-meeting run() — candidates only, operator approves — but a single
    fast chat call: the window is already capped by the route, and the answer
    budget is small (LIVE_EXTRACT_NUM_PREDICT) so results arrive while the
    conversation is still fresh. The post-meeting extraction over the full,
    higher-quality transcript remains the backstop for anything missed here.
    """
    attendee_line = ", ".join(attendees) if attendees else "(not listed)"
    flagged_block = (
        "\n".join(f"- {q}" for q in already_flagged) if already_flagged else "(none)"
    )
    user_prompt = (
        f"Attendees: {attendee_line}\n"
        "This is a PARTIAL, ROUGH live transcript of a meeting that is still "
        "in progress (machine-transcribed; names may be misspelled). Extract "
        "only question-and-answer pairs where the answer already appears in "
        "this excerpt.\n"
        "Do NOT repeat any of these already-flagged questions:\n"
        f"{flagged_block}\n\n"
        "Transcript excerpt:\n\n"
        f"{window_text}"
    )
    async with httpx.AsyncClient(timeout=LIVE_TIMEOUT) as client:
        parsed = await _ollama.chat_json(
            client, settings, SYSTEM_PROMPT, user_prompt,
            num_predict=settings.LIVE_EXTRACT_NUM_PREDICT,
            temperature=settings.EXTRACT_TEMPERATURE,
        )
    questions = _dedupe(_coerce(parsed))
    # Belt-and-braces: the model was told not to repeat flagged questions, but
    # drop exact repeats anyway so the laptop never re-surfaces one.
    flagged_keys = {q.casefold().strip() for q in already_flagged}
    return [q for q in questions if q.question.casefold().strip() not in flagged_keys]


async def run(
    transcript_text: str, meeting: MeetingMeta, settings: Settings
) -> list[ExtractedQuestion]:
    context = _ollama.meeting_context(meeting)
    num_predict = settings.EXTRACT_NUM_PREDICT
    temperature = settings.EXTRACT_TEMPERATURE
    budget_tokens = _ollama.input_budget_tokens(settings, num_predict)

    async with httpx.AsyncClient(timeout=_ollama.DEFAULT_TIMEOUT) as client:
        if _ollama.estimate_tokens(transcript_text) <= budget_tokens:
            user_prompt = (
                f"{context}\n"
                "Extract the question-and-answer pairs from this meeting "
                "transcript:\n\n"
                f"{transcript_text}"
            )
            parsed = await _ollama.chat_json(
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
            parsed = await _ollama.chat_json(
                client, settings, SYSTEM_PROMPT, prompt,
                num_predict=num_predict, temperature=temperature,
            )
            collected.extend(_coerce(parsed))
        return _dedupe(collected)
