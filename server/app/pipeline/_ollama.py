"""Shared helpers for the Ollama-backed pipeline stages (summarize, extract).

IMPORTANT: every call targets Ollama's NATIVE /api/chat endpoint, not the
OpenAI-compatible /v1 endpoint — /v1 ignores options.num_ctx and silently
truncates the prompt at the model's default 2048-token context, which destroys
long transcripts.
"""

import asyncio
import json
import logging
import os
import re
import subprocess
import sys
import time
from urllib.parse import urlparse

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
    except httpx.TransportError:
        # Ollama isn't reachable at all (not started yet). That says nothing
        # about the model, so don't cache it — a "no thinking" answer pinned
        # now would outlive the auto-start below and cost every later call.
        return False
    except Exception:
        # Older Ollama, or the model vanished. Assume no thinking mode: sending
        # `think` to a model that doesn't support it is an error, so the safe
        # default is to say nothing.
        supported = False
    _THINKING_CACHE[model] = supported
    return supported


# ---- Auto-start --------------------------------------------------------------
# "All connection attempts failed" was the whole diagnosis when Ollama wasn't
# running: nothing listening on OLLAMA_URL. On Windows the Ollama tray app
# normally starts the server at login, but quitting the tray (or a login where
# it didn't launch) leaves every AI stage dead until someone notices. When the
# URL is on this machine and Ollama is installed, start `ollama serve`
# ourselves and retry once; otherwise fail with a message that says what to do.

# How long a freshly spawned `ollama serve` gets to start listening.
START_WAIT_SEC = 20.0
# Don't respawn more often than this — a server that can't start (port in use
# by something else, broken install) must not be relaunched on every tick.
_START_RETRY_SEC = 60.0
_last_start_attempt: float = 0.0
_start_lock: asyncio.Lock | None = None


class OllamaNotRunning(RuntimeError):
    """Nothing is answering at OLLAMA_URL (and we couldn't start it)."""


def _is_local(url: str) -> bool:
    host = (urlparse(url).hostname or "").lower()
    return host in ("127.0.0.1", "localhost", "::1", "0.0.0.0")


def _not_running_message(settings: Settings, detail: str = "") -> str:
    url = settings.OLLAMA_URL.rstrip("/")
    if not _is_local(url):
        hint = ("Check that the machine at that address is on and running "
                "Ollama, or fix the Ollama URL in Dashboard → Settings → AI models.")
    else:
        hint = ("Start the Ollama app (Start menu → Ollama), or install it from "
                "the dashboard's Setup tab if it isn't installed.")
    return f"Ollama is not running at {url}{detail}. {hint}"


async def _reachable(settings: Settings) -> bool:
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(3.0)) as client:
            resp = await client.get(f"{settings.OLLAMA_URL.rstrip('/')}/api/version")
        return resp.status_code < 500
    except httpx.HTTPError:
        return False


def _spawn_serve(exe: str, settings: Settings) -> bool:
    """Launch `ollama serve` detached from this process. True if it launched."""
    from ..config import subprocess_flags

    host = urlparse(settings.OLLAMA_URL)
    env = None
    if host.port and host.port != 11434:
        # Make the spawned server listen where OLLAMA_URL points.
        env = {**os.environ, "OLLAMA_HOST": f"{host.hostname}:{host.port}"}
    kwargs: dict = dict(subprocess_flags())
    if sys.platform != "win32":
        kwargs["start_new_session"] = True
    try:
        subprocess.Popen(
            [exe, "serve"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            close_fds=True,
            env=env,
            **kwargs,
        )
    except OSError as exc:
        log.warning("Could not start Ollama (%s serve): %s", exe, exc)
        return False
    return True


async def ensure_running(settings: Settings) -> bool:
    """Make sure Ollama answers at OLLAMA_URL, starting it if we can.

    Returns True once it answers. Never raises. Only ever starts a LOCAL
    server, and at most once per _START_RETRY_SEC, so concurrent stages share
    one attempt instead of racing to launch several.
    """
    global _last_start_attempt, _start_lock
    if await _reachable(settings):
        return True
    if not _is_local(settings.OLLAMA_URL):
        return False
    if _start_lock is None:
        _start_lock = asyncio.Lock()
    async with _start_lock:
        if await _reachable(settings):  # another caller started it meanwhile
            return True
        now = time.monotonic()
        if _last_start_attempt and now - _last_start_attempt < _START_RETRY_SEC:
            return False
        _last_start_attempt = now

        from ..setup import bootstrap  # late: setup imports the pipeline

        exe = bootstrap._which("ollama")
        log.info("Ollama is not answering at %s — starting it (%s serve)",
                 settings.OLLAMA_URL, exe)
        if not _spawn_serve(exe, settings):
            return False
        deadline = time.monotonic() + START_WAIT_SEC
        while time.monotonic() < deadline:
            await asyncio.sleep(0.5)
            if await _reachable(settings):
                log.info("Ollama started and is answering at %s", settings.OLLAMA_URL)
                return True
        log.warning("Started Ollama but it did not answer within %.0fs", START_WAIT_SEC)
        return False


async def _with_autostart(settings: Settings, call):
    """Run ``call()``; if Ollama isn't listening, start it and retry once."""
    try:
        return await call()
    except httpx.ConnectError:
        pass
    if not await ensure_running(settings):
        raise OllamaNotRunning(_not_running_message(settings))
    try:
        return await call()
    except httpx.ConnectError as exc:
        raise OllamaNotRunning(_not_running_message(settings, f" ({exc})")) from exc


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

    async def call() -> str:
        resp = await client.post(url, json=payload)
        resp.raise_for_status()
        return resp.json()["message"]["content"].strip()

    return await _with_autostart(settings, call)


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
    url = f"{settings.OLLAMA_URL.rstrip('/')}/api/chat"

    async def call():
        # A thinking model asked for strict JSON on a small output budget can
        # spend the whole budget reasoning and return nothing usable. Turn
        # thinking off for these calls when the model has it — but only then,
        # because Ollama rejects `think` outright for models that don't.
        # (Probed inside the retry so an auto-started Ollama gets asked too.)
        if settings.OLLAMA_DISABLE_THINKING and await supports_thinking(
            client, settings, payload["model"]
        ):
            payload["think"] = False
        resp = await client.post(url, json=payload)
        resp.raise_for_status()
        return resp.json()["message"]["content"]

    return _loads_loose(await _with_autostart(settings, call))


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
