"""Ollama auto-start: a stopped Ollama is started on demand, not just reported."""

import asyncio

import httpx
import pytest

from app.config import get_settings
from app.pipeline import _ollama

DEAD = "http://127.0.0.1:9"


def _settings(url=DEAD):
    return get_settings().model_copy(update={"OLLAMA_URL": url})


def test_a_stopped_local_ollama_is_started_once_and_the_call_retried(monkeypatch):
    spawned = []
    up = {"value": False}

    def spawn(exe, settings):
        spawned.append(exe)
        up["value"] = True
        return True

    async def reachable(settings):
        return up["value"]

    monkeypatch.setattr(_ollama, "_spawn_serve", spawn)
    monkeypatch.setattr(_ollama, "_reachable", reachable)

    calls = []

    async def call():
        calls.append(1)
        await asyncio.sleep(0)  # let both callers fail before either starts it
        if not up["value"] or len(calls) <= 2:
            raise httpx.ConnectError("All connection attempts failed")
        return "ok"

    async def main():
        # Two stages hitting a stopped Ollama at once share ONE start.
        return await asyncio.gather(
            _ollama._with_autostart(_settings(), call),
            _ollama._with_autostart(_settings(), call),
        )

    assert asyncio.run(main()) == ["ok", "ok"]
    assert len(spawned) == 1
    assert len(calls) == 4  # each failed once, then succeeded on the retry


def test_a_start_that_never_answers_is_not_retried_every_tick(monkeypatch):
    spawned = []

    def spawn(exe, settings):
        spawned.append(exe)
        return True

    async def never(settings):
        return False

    monkeypatch.setattr(_ollama, "_spawn_serve", spawn)
    monkeypatch.setattr(_ollama, "_reachable", never)
    monkeypatch.setattr(_ollama, "START_WAIT_SEC", 0.1)

    assert asyncio.run(_ollama.ensure_running(_settings())) is False
    assert asyncio.run(_ollama.ensure_running(_settings())) is False
    assert len(spawned) == 1  # rate-limited, not relaunched per call


def test_a_remote_ollama_is_never_started_and_the_error_says_what_to_do(monkeypatch):
    monkeypatch.setattr(
        _ollama, "_spawn_serve",
        lambda exe, settings: pytest.fail("must not start a remote Ollama"),
    )

    async def down(settings):
        return False

    monkeypatch.setattr(_ollama, "_reachable", down)

    async def call():
        raise httpx.ConnectError("All connection attempts failed")

    settings = _settings("http://192.0.2.10:11434")
    with pytest.raises(_ollama.OllamaNotRunning) as err:
        asyncio.run(_ollama._with_autostart(settings, call))
    assert "Ollama is not running at http://192.0.2.10:11434" in str(err.value)


def test_a_dead_local_port_reports_ollama_not_running():
    """End to end through chat_json: the old bare "All connection attempts
    failed" now names Ollama and the fix."""

    async def main():
        async with httpx.AsyncClient() as client:
            await _ollama.chat_json(client, _settings(), "sys", "user",
                                    num_predict=16, temperature=0.0)

    with pytest.raises(_ollama.OllamaNotRunning) as err:
        asyncio.run(main())
    assert "Start the Ollama app" in str(err.value)
