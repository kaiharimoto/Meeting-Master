"""Stage 3: summarize the transcript with a local Ollama model.

IMPORTANT: this calls Ollama's NATIVE /api/chat endpoint, not the
OpenAI-compatible /v1 endpoint — /v1 ignores options.num_ctx and silently
truncates the prompt at the model's default 2048-token context, which destroys
long transcripts.
"""

import logging

import httpx

from ..config import Settings
from ..models import MeetingMeta

log = logging.getLogger(__name__)

SYSTEM_PROMPT = (
    "You are a precise meeting-notes assistant. Write a faithful GENERAL "
    "SUMMARY of the meeting transcript you are given, as 2-4 plain-prose "
    "paragraphs. Use only information that appears in the transcript — never "
    "invent names, numbers, decisions, or dates. Do not use bullet lists or "
    "headings, and do not add any preamble such as 'Here is a summary'; "
    "start directly with the summary text."
)

# Rough token estimate: ~3 characters per token is a conservative ratio for
# mixed English/CJK meeting text (English alone is ~4 chars/token).
_CHARS_PER_TOKEN = 3

# Headroom reserved for the system prompt, meeting context, and chat framing.
_PROMPT_OVERHEAD_TOKENS = 1000


def _estimate_tokens(text: str) -> int:
    return len(text) // _CHARS_PER_TOKEN


def _meeting_context(meeting: MeetingMeta) -> str:
    d = meeting.details
    attendees = ", ".join(d.attendees) if d.attendees else "(not listed)"
    return (
        f"Meeting title: {d.title}\n"
        f"Date: {d.date} {d.time}\n"
        f"Attendees: {attendees}\n"
    )


async def _chat(client: httpx.AsyncClient, settings: Settings, user_prompt: str) -> str:
    payload = {
        "model": settings.OLLAMA_MODEL,
        "stream": False,
        "options": {
            "num_ctx": settings.NUM_CTX,
            "temperature": settings.SUMMARY_TEMPERATURE,
            "num_predict": settings.SUMMARY_NUM_PREDICT,
        },
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_prompt},
        ],
    }
    url = f"{settings.OLLAMA_URL.rstrip('/')}/api/chat"
    resp = await client.post(url, json=payload)
    resp.raise_for_status()
    return resp.json()["message"]["content"].strip()


async def run(transcript_text: str, meeting: MeetingMeta, settings: Settings) -> str:
    context = _meeting_context(meeting)
    # Generation can take minutes for a long transcript on a local model,
    # hence the generous read timeout (connect stays snappy).
    timeout = httpx.Timeout(600.0, connect=10.0)
    budget_tokens = (
        settings.NUM_CTX - settings.SUMMARY_NUM_PREDICT - _PROMPT_OVERHEAD_TOKENS
    )

    async with httpx.AsyncClient(timeout=timeout) as client:
        if _estimate_tokens(transcript_text) <= budget_tokens:
            user_prompt = (
                f"{context}\n"
                "Summarize the following meeting transcript:\n\n"
                f"{transcript_text}"
            )
            return await _chat(client, settings, user_prompt)

        # CHUNKING SAFEGUARD: the transcript likely exceeds the context window.
        # Summarize fixed-size character chunks, then summarize the summaries.
        chunk_chars = max(budget_tokens * _CHARS_PER_TOKEN, _CHARS_PER_TOKEN)
        chunks = [
            transcript_text[i : i + chunk_chars]
            for i in range(0, len(transcript_text), chunk_chars)
        ]
        log.info(
            "Transcript ~%d tokens exceeds budget of %d — chunking into %d parts",
            _estimate_tokens(transcript_text), budget_tokens, len(chunks),
        )
        partials: list[str] = []
        for index, chunk in enumerate(chunks, start=1):
            prompt = (
                f"{context}\n"
                f"Summarize this PORTION ({index} of {len(chunks)}) of a longer "
                "meeting transcript. Capture every substantive point so the "
                "portions can later be combined into one summary:\n\n"
                f"{chunk}"
            )
            partials.append(await _chat(client, settings, prompt))

        final_prompt = (
            f"{context}\n"
            "The following are summaries of consecutive portions of one meeting "
            "transcript. Combine them into a single coherent general summary of "
            "the whole meeting:\n\n" + "\n\n".join(partials)
        )
        return await _chat(client, settings, final_prompt)
