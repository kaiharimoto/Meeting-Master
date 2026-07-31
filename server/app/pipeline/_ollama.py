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

# The least transcript a chunk may carry and still be worth sending. Below this
# the map-reduce split stops being a safeguard and becomes a catastrophe: at
# NUM_CTX=2048 with SUMMARY_NUM_PREDICT=1400 the budget goes NEGATIVE, the old
# `max(budget, 1)` turned that into one-token chunks, and a 60k-character
# transcript became 20,000 sequential Ollama calls each seeing three characters.
# It never errored — it just never finished, which is the worst way to fail.
MIN_INPUT_BUDGET_TOKENS = 1024

# Generation can take minutes for a long transcript on a local model, hence the
# generous read timeout (connect stays snappy).
DEFAULT_TIMEOUT = httpx.Timeout(600.0, connect=10.0)


# Which models advertise a "thinking" capability, cached per model name so the
# probe costs one request per model per server run rather than one per stage.
_THINKING_CACHE: dict[str, bool] = {}


async def supports_thinking(
    client: httpx.AsyncClient, settings: Settings, model: str
) -> bool:
    """Does this model have a reasoning/thinking mode? (cached, never raises)

    It matters because every stage here asks for STRICT JSON with a small
    num_predict. A thinking model left to think spends that budget on reasoning
    and can return no JSON at all — which surfaces as "the summary failed" with
    a model that is in fact working perfectly. Knowing lets us turn it off.
    """
    if model in _THINKING_CACHE:
        return _THINKING_CACHE[model]
    supported = False
    try:
        resp = await client.post(
            f"{settings.OLLAMA_URL.rstrip('/')}/api/show", json={"model": model}
        )
        resp.raise_for_status()
        caps = resp.json().get("capabilities") or []
        supported = any(str(c).lower() == "thinking" for c in caps)
    except Exception:
        # Older Ollama, or the model vanished. Assume no thinking mode: sending
        # `think` to a model that doesn't support it is an error, so the safe
        # default is to say nothing.
        supported = False
    _THINKING_CACHE[model] = supported
    return supported


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


def input_budget_tokens(settings: Settings, num_predict: int, stage: str = "AI") -> int:
    """How many transcript tokens fit alongside the prompt + reserved output.

    Raises when the three numbers leave no usable room, naming all three: the
    context window is the setting people reach for when a model won't fit in
    VRAM, and lowering it far enough silently inverts this arithmetic. Failing
    here is loud, immediate, and tells the operator exactly which number to
    change — the alternative was a job that hung forever splitting the
    transcript into one-token pieces.
    """
    budget = settings.NUM_CTX - num_predict - PROMPT_OVERHEAD_TOKENS
    if budget < MIN_INPUT_BUDGET_TOKENS:
        needed = num_predict + PROMPT_OVERHEAD_TOKENS + MIN_INPUT_BUDGET_TOKENS
        raise ValueError(
            f"The context window is too small for the {stage} stage: NUM_CTX="
            f"{settings.NUM_CTX} minus {num_predict} reserved output tokens and "
            f"{PROMPT_OVERHEAD_TOKENS} for the prompt leaves {budget} for the "
            f"transcript. Raise the context window to at least {needed}, or "
            f"lower the stage's max output tokens. (Dashboard → Settings → AI "
            f"models; 'Fit to your GPU' suggests values that work on your card.)"
        )
    return budget


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
    model: str | None = None,
    keep_alive: str | None = None,
):
    """One /api/chat turn constrained to JSON output, parsed defensively.

    ``format: "json"`` makes Ollama emit syntactically valid JSON (widely
    supported, unlike a full JSON-schema which needs a recent Ollama). The
    concrete SHAPE is still the model's choice, so callers must tolerate
    missing keys. Returns the parsed value (dict/list) or raises ValueError.

    ``model`` overrides OLLAMA_MODEL (the live path may run a smaller, faster
    model), and ``keep_alive`` asks Ollama to hold it in VRAM afterwards so a
    repeated call doesn't pay the load cost again. NOTE: num_ctx is deliberately
    NOT overridable — changing it forces Ollama to reload the model, which
    mid-meeting would stall every other stage.
    """
    payload = {
        "model": model or settings.OLLAMA_MODEL,
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
    if keep_alive:
        payload["keep_alive"] = keep_alive
    # A thinking model asked for strict JSON on a small output budget can spend
    # the whole budget reasoning and return nothing usable. Turn thinking off
    # for these calls when the model has it — but only then, because Ollama
    # rejects `think` outright for models that don't.
    if settings.OLLAMA_DISABLE_THINKING and await supports_thinking(
        client, settings, payload["model"]
    ):
        payload["think"] = False
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
