"""Shared helpers for the Ollama-backed pipeline stages (summarize, extract).

IMPORTANT: every call targets Ollama's NATIVE /api/chat endpoint, not the
OpenAI-compatible /v1 endpoint — /v1 ignores options.num_ctx and silently
truncates the prompt at the model's default 2048-token context, which destroys
long transcripts.
"""

import json
import logging
import re

import httpx

from ..config import Settings
from ..models import MeetingMeta

log = logging.getLogger(__name__)

# Rough token estimate. ASCII text runs ~4 chars/token, so 3 is conservative;
# non-ASCII scripts (CJK especially) tokenize closer to one token PER CHARACTER,
# so they must be counted at full weight or a long non-English transcript would
# silently overflow num_ctx — the exact truncation bug these stages guard against.
_ASCII_CHARS_PER_TOKEN = 3

# Headroom reserved for the system prompt, meeting context, and chat framing.
PROMPT_OVERHEAD_TOKENS = 1000

# Generation can take minutes for a long transcript on a local model, hence the
# generous read timeout (connect stays snappy).
DEFAULT_TIMEOUT = httpx.Timeout(600.0, connect=10.0)


def estimate_tokens(text: str) -> int:
    ascii_chars = sum(1 for ch in text if ord(ch) < 128)
    return ascii_chars // _ASCII_CHARS_PER_TOKEN + (len(text) - ascii_chars)


def split_by_token_budget(text: str, budget_tokens: int) -> list[str]:
    """Split text into chunks whose estimated token count fits the budget."""
    per_ascii = 1.0 / _ASCII_CHARS_PER_TOKEN
    chunks: list[str] = []
    start = 0
    weight = 0.0
    for i, ch in enumerate(text):
        weight += per_ascii if ord(ch) < 128 else 1.0
        if weight >= budget_tokens:
            chunks.append(text[start : i + 1])
            start = i + 1
            weight = 0.0
    if start < len(text):
        chunks.append(text[start:])
    return chunks or [text]


def input_budget_tokens(settings: Settings, num_predict: int) -> int:
    """How many transcript tokens fit alongside the prompt + reserved output."""
    return settings.NUM_CTX - num_predict - PROMPT_OVERHEAD_TOKENS


def meeting_context(meeting: MeetingMeta) -> str:
    d = meeting.details
    attendees = ", ".join(d.attendees) if d.attendees else "(not listed)"
    return (
        f"Meeting title: {d.title}\n"
        f"Date: {d.date} {d.time}\n"
        f"Attendees: {attendees}\n"
    )


async def chat_text(
    client: httpx.AsyncClient,
    settings: Settings,
    system_prompt: str,
    user_prompt: str,
    *,
    num_predict: int,
    temperature: float,
) -> str:
    """One /api/chat turn returning the assistant's plain-text reply."""
    payload = {
        "model": settings.OLLAMA_MODEL,
        "stream": False,
        "options": {
            "num_ctx": settings.NUM_CTX,
            "temperature": temperature,
            "num_predict": num_predict,
        },
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
    }
    url = f"{settings.OLLAMA_URL.rstrip('/')}/api/chat"
    resp = await client.post(url, json=payload)
    resp.raise_for_status()
    return resp.json()["message"]["content"].strip()


async def chat_json(
    client: httpx.AsyncClient,
    settings: Settings,
    system_prompt: str,
    user_prompt: str,
    *,
    num_predict: int,
    temperature: float,
):
    """One /api/chat turn constrained to JSON output, parsed defensively.

    ``format: "json"`` makes Ollama emit syntactically valid JSON (widely
    supported, unlike a full JSON-schema which needs a recent Ollama). The
    concrete SHAPE is still the model's choice, so callers must tolerate
    missing keys. Returns the parsed value (dict/list) or raises ValueError.
    """
    payload = {
        "model": settings.OLLAMA_MODEL,
        "stream": False,
        "format": "json",
        "options": {
            "num_ctx": settings.NUM_CTX,
            "temperature": temperature,
            "num_predict": num_predict,
        },
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
    }
    url = f"{settings.OLLAMA_URL.rstrip('/')}/api/chat"
    resp = await client.post(url, json=payload)
    resp.raise_for_status()
    content = resp.json()["message"]["content"]
    return _loads_loose(content)


def _loads_loose(text: str):
    """json.loads, but tolerant of code fences and leading/trailing prose."""
    text = (text or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z0-9]*\n?", "", text)
        text = re.sub(r"\n?```$", "", text).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    # Fall back to the first balanced-looking object/array in the string.
    for open_ch, close_ch in (("{", "}"), ("[", "]")):
        start = text.find(open_ch)
        end = text.rfind(close_ch)
        if start != -1 and end > start:
            try:
                return json.loads(text[start : end + 1])
            except json.JSONDecodeError:
                continue
    raise ValueError("Ollama did not return parseable JSON")


def clean_bullet(text) -> str:
    """Normalize one model-produced bullet: strip list markers and whitespace."""
    s = str(text or "").strip()
    # Drop a leading "-", "*", "•", or "1." style marker the model may add
    # despite being asked for bare strings.
    s = re.sub(r"^\s*(?:[-*•]|\d+[.)])\s+", "", s)
    return s.strip()
