"""The AI provider seam: Ollama by default, Claude via its CLI when asked.

The provider exists because the operator's WORK network blocks AI services
while the home PC's does not — so the server can do the round trip that
otherwise means carrying a prompt to a phone. Ollama stays the default and the
fallback, and these tests are mostly about making sure that is still true and
that switching does not quietly change the shape of anything.

Async tests follow this suite's convention (see test_monitor.py): a sync test
wrapping asyncio.run(), rather than taking a pytest-asyncio dependency.
"""

import asyncio
import json
import sys
from pathlib import Path

import pytest

from app import config, worker
from app.pipeline import _claude_cli, _ollama, _provider

STUB = str(Path(__file__).parent / "stubs" / "fake_claude.py")


def claude_settings(**overrides):
    """Settings pointed at the stub CLI. The stub is executable with a python3
    shebang, so it stands in for the real binary at the argv level."""
    values = {
        "AI_PROVIDER": "claude_cli",
        "CLAUDE_CLI_PATH": STUB,
        "CLAUDE_CLI_TIMEOUT_SEC": 60,
    }
    values.update(overrides)
    return config.get_settings().model_copy(update=values)


def chat_json(settings, system="sys", user="user", **kwargs):
    return asyncio.run(
        _claude_cli.chat_json(
            None, settings, system, user, num_predict=10, temperature=0.0, **kwargs
        )
    )


# --- Provider selection ------------------------------------------------------


def test_default_provider_is_ollama():
    settings = config.get_settings()
    assert _provider.provider_name(settings) == "ollama"
    assert not _provider.uses_claude_cli(settings)


def test_unknown_provider_falls_back_to_ollama():
    # A typo in server.env must land on the local model, not wedge the pipeline.
    for bogus in ["", "  ", "claude", "openai", "CLAUDE_CLI_TYPO"]:
        settings = config.get_settings().model_copy(update={"AI_PROVIDER": bogus})
        assert _provider.provider_name(settings) == "ollama", bogus


def test_provider_name_is_case_and_space_insensitive():
    for spelling in ["claude_cli", "Claude_CLI", "  claude_cli  "]:
        settings = config.get_settings().model_copy(update={"AI_PROVIDER": spelling})
        assert _provider.uses_claude_cli(settings), spelling


def test_provider_dispatches_to_the_right_backend():
    assert _provider._backend(config.get_settings()) is _ollama
    assert _provider._backend(claude_settings()) is _claude_cli


# --- The chunker bypass ------------------------------------------------------


def test_ollama_keeps_its_context_budget():
    settings = config.get_settings()
    budget = _provider.input_budget_tokens(settings, 1400, "summary")
    assert budget < settings.NUM_CTX  # whatever the number, NUM_CTX bounds it


def test_claude_gets_a_budget_no_meeting_will_exceed():
    # Chunking a meeting for Claude would split it and merge it back for
    # nothing, losing cross-chunk context on the way.
    budget = _provider.input_budget_tokens(claude_settings(), 1400, "summary")
    assert budget > 1_000_000


# --- Finding the CLI ---------------------------------------------------------


def test_resolve_cli_returns_none_when_absent(monkeypatch):
    # None, not the bare name: "not installed" is a setup problem with a setup
    # fix, and must be distinguishable from "ran and failed".
    monkeypatch.setattr(_claude_cli.shutil, "which", lambda _n: None)
    monkeypatch.setattr(_claude_cli.os.path, "exists", lambda _p: False)
    assert _claude_cli.resolve_cli(claude_settings(CLAUDE_CLI_PATH="")) is None


def test_resolve_cli_honours_a_configured_path():
    assert _claude_cli.resolve_cli(claude_settings()) == STUB


def test_missing_cli_explains_how_to_fix_it(monkeypatch):
    monkeypatch.setattr(_claude_cli, "resolve_cli", lambda _s: None)
    with pytest.raises(_claude_cli.ClaudeCliError) as excinfo:
        chat_json(claude_settings())
    message = str(excinfo.value)
    assert "not installed" in message
    assert "claude login" in message  # the next step, not just a failure


# --- Talking to the CLI ------------------------------------------------------


def test_chat_json_parses_the_reply(monkeypatch):
    monkeypatch.setenv("FAKE_CLAUDE_MODE", "json")
    assert chat_json(claude_settings())["ok"] is True


def test_chat_json_survives_prose_and_code_fences(monkeypatch):
    # A real CLI answers in sentences and fences its JSON. _loads_loose is what
    # makes that survivable, and this is the case it exists for.
    monkeypatch.setenv("FAKE_CLAUDE_MODE", "chatty")
    assert chat_json(claude_settings())["ok"] is True


def test_prompt_travels_on_stdin_not_argv(monkeypatch, tmp_path):
    # A transcript is far past the Windows command-line limit, and argv is
    # visible to anything that can list processes.
    log = tmp_path / "calls.jsonl"
    monkeypatch.setenv("FAKE_CLAUDE_LOG", str(log))
    monkeypatch.setenv("FAKE_CLAUDE_MODE", "json")
    transcript = "the quick brown fox " * 500

    chat_json(claude_settings(), system="SYSTEM RULES", user=transcript)

    call = json.loads(log.read_text().strip().splitlines()[0])
    assert transcript in call["stdin"]
    assert not any(transcript in str(a) for a in call["argv"])
    # The system prompt does ride on argv — it is small and fixed.
    assert "SYSTEM RULES" in call["argv"]


def test_the_whole_transcript_goes_in_one_call(monkeypatch, tmp_path):
    # The point of the chunker bypass: one call, not N partials plus a merge.
    log = tmp_path / "calls.jsonl"
    monkeypatch.setenv("FAKE_CLAUDE_LOG", str(log))
    monkeypatch.setenv("FAKE_CLAUDE_MODE", "json")
    chat_json(claude_settings(), user="a transcript")
    assert len(log.read_text().strip().splitlines()) == 1


def test_nonzero_exit_surfaces_the_stderr(monkeypatch):
    monkeypatch.setenv("FAKE_CLAUDE_MODE", "fail")
    with pytest.raises(_claude_cli.ClaudeCliError) as excinfo:
        chat_json(claude_settings())
    assert "something went wrong" in str(excinfo.value)


def test_empty_output_points_at_the_sign_in(monkeypatch):
    # An expired login exits quietly, which is the confusing failure — say so.
    monkeypatch.setenv("FAKE_CLAUDE_MODE", "empty")
    with pytest.raises(_claude_cli.ClaudeCliError) as excinfo:
        chat_json(claude_settings())
    assert "claude login" in str(excinfo.value)


def test_a_hung_cli_times_out_rather_than_hanging_the_worker(monkeypatch):
    monkeypatch.setenv("FAKE_CLAUDE_MODE", "hang")
    with pytest.raises(_claude_cli.ClaudeCliError) as excinfo:
        chat_json(claude_settings(CLAUDE_CLI_TIMEOUT_SEC=1))
    assert "did not finish" in str(excinfo.value)


# --- The retry that must not fire -------------------------------------------


def test_usage_limit_does_not_trigger_the_halve_context_retry():
    # "Usage limit reached for this 5-hour context window" contains the word
    # "context". Halving NUM_CTX cannot help — NUM_CTX is an Ollama setting and
    # the quota is already spent — so the retry would just burn a second call.
    limit = RuntimeError("Usage limit reached for this 5-hour context window.")
    assert worker._looks_like_context_error(limit, claude_settings()) is False
    # The same string on Ollama keeps the old behaviour: this is a provider
    # rule, not a change to how Ollama failures are read.
    assert worker._looks_like_context_error(limit, config.get_settings()) is True


def test_ollama_context_errors_still_retry():
    for message in ["CUDA out of memory", "kv cache is full", "context window exceeded"]:
        assert worker._looks_like_context_error(RuntimeError(message), config.get_settings())
