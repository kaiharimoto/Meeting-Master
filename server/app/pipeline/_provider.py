"""Which model answers — Ollama on this machine, or Claude via its CLI.

Every AI stage funnels through _ollama.chat_json/chat_text: summary, Q&A
extraction, mid-meeting live suggestions, answer drafting, and the setup
page's health check. That single choke point is what makes a second backend a
small change, and this module is the branch.

It exists as its own file rather than an `if` inside _ollama.py so that module
stays what its docstring says it is: the native Ollama /api/chat client.
Callers import chat_json from here and stop caring which model runs.

Ollama remains the default. It needs no account, no network, and no sign-in
that can lapse, which is the whole premise of a self-hosted pipeline; Claude
is opt-in for meetings the local model can't do justice to.
"""

from ..config import Settings

CLAUDE_CLI = "claude_cli"
OLLAMA = "ollama"


def provider_name(settings: Settings) -> str:
    """The configured backend, normalized. Anything unrecognized means Ollama:
    a typo in server.env should degrade to the local model, not wedge the
    pipeline."""
    name = (settings.AI_PROVIDER or "").strip().lower()
    return CLAUDE_CLI if name == CLAUDE_CLI else OLLAMA


def uses_claude_cli(settings: Settings) -> bool:
    return provider_name(settings) == CLAUDE_CLI


def _backend(settings: Settings):
    from . import _claude_cli, _ollama

    return _claude_cli if uses_claude_cli(settings) else _ollama


# Kwargs that only mean something to Ollama. `model` is an Ollama TAG
# ("gemma4:26b"), and `keep_alive` is a VRAM residency hint with no CLI
# equivalent — neither survives a trip to another backend.
_OLLAMA_ONLY_KWARGS = ("model", "keep_alive")


def _for_backend(settings: Settings, kwargs: dict) -> dict:
    """Drop kwargs the selected backend cannot understand.

    This module is a TRANSLATION layer, not a pass-through. Forwarding blindly
    is what broke live suggestions once already: run_live passes
    model=settings.live_model — an Ollama tag — and the Claude backend handed it
    straight to the CLI as `--model qwen2.5:14b-instruct-q6_K`, which exits
    non-zero. Every tick of a meeting failed while the post-meeting stages, which
    pass no model at all, kept working.

    Filtering HERE rather than at each call site is deliberate: a new caller
    should not have to know which kwargs are provider-specific, and the next
    Ollama-only knob added to _ollama.py only has to be named in the tuple above.
    """
    if not uses_claude_cli(settings):
        return kwargs
    return {k: v for k, v in kwargs.items() if k not in _OLLAMA_ONLY_KWARGS}


async def chat_text(client, settings: Settings, system_prompt: str, user_prompt: str, **kwargs):
    return await _backend(settings).chat_text(
        client, settings, system_prompt, user_prompt, **_for_backend(settings, kwargs)
    )


async def chat_json(client, settings: Settings, system_prompt: str, user_prompt: str, **kwargs):
    return await _backend(settings).chat_json(
        client, settings, system_prompt, user_prompt, **_for_backend(settings, kwargs)
    )


def input_budget_tokens(settings: Settings, num_predict: int, stage: str = "AI") -> int:
    """How much transcript one call may carry.

    Ollama's budget is NUM_CTX minus what the answer needs, and overflowing it
    is a real failure — hence the chunk-and-merge path in summarize.run.
    Claude's context is large enough that meeting transcripts do not approach
    it, so chunking there would split a meeting and merge it back for nothing,
    losing cross-chunk context on the way. Return a budget no transcript will
    exceed and let the whole thing go in one call.
    """
    from . import _ollama

    if uses_claude_cli(settings):
        return 10_000_000
    return _ollama.input_budget_tokens(settings, num_predict, stage)
