"""Unit tests for first-run setup mode.

Hermetic: no real subprocess, no network. The single external-command seam
(app.setup.bootstrap._run) is monkeypatched, and the token-generating save test
reloads app.config pointed at a throwaway MEETING_MASTER_HOME.
"""

import asyncio
import base64
import importlib
import json
import os
import types

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient


# --- fixtures ---------------------------------------------------------------
@pytest.fixture()
def no_tools(monkeypatch):
    """Make every external command look 'not installed' (no subprocess)."""
    from app.setup import bootstrap

    async def fake_run(cmd, **kwargs):
        return bootstrap.RunResult(
            returncode=127, stdout="", stderr="not found", launched=False
        )

    monkeypatch.setattr(bootstrap, "_run", fake_run)
    yield


@pytest.fixture()
def fresh_home(tmp_path):
    """Reload app.config against an empty tmp home with no inherited secrets,
    then restore the module + environment for the rest of the suite."""
    from app import config as config_mod

    keys = (
        "MEETING_MASTER_HOME", "BEARER_TOKEN", "DATA_DIR", "WHISPER_MODEL_DIR",
        "RECIPIENTS_PATH", "EMAIL_TEMPLATE_PATH", "SMTP_USER", "SMTP_FROM",
        "SMTP_APP_PASSWORD", "OLLAMA_MODEL", "WHISPER_MODEL_DEFAULT",
        "OLLAMA_URL", "FFMPEG_PATH", "WHISPER_CLI",
    )
    snapshot = {k: os.environ.get(k) for k in keys}
    for k in keys:
        os.environ.pop(k, None)
    os.environ["MEETING_MASTER_HOME"] = str(tmp_path)
    importlib.reload(config_mod)
    config_mod.get_settings.cache_clear()
    try:
        yield config_mod, tmp_path
    finally:
        for k, v in snapshot.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        importlib.reload(config_mod)
        config_mod.get_settings.cache_clear()


def _setup_app() -> FastAPI:
    from app.setup.routes import router

    app = FastAPI()
    app.include_router(router)
    return app


# --- (a) connection-code contract ------------------------------------------
def test_connection_code_roundtrip():
    from app.setup.routes import encode_connection_code

    url, token = "https://home.tail-abc.ts.net", "s3cr3t-token_value"
    code = encode_connection_code(url, token)

    # base64url, no padding.
    assert "=" not in code
    assert "+" not in code and "/" not in code

    # Decodes (with restored padding) back to the exact JSON contract.
    padded = code + "=" * (-len(code) % 4)
    decoded = json.loads(base64.urlsafe_b64decode(padded).decode("utf-8"))
    assert decoded == {"url": url, "token": token}

    # Matches the byte-for-byte base64url-no-pad contract.
    expected = (
        base64.urlsafe_b64encode(
            json.dumps({"url": url, "token": token}, separators=(",", ":")).encode()
        )
        .rstrip(b"=")
        .decode()
    )
    assert code == expected


# --- (b) loopback-only -----------------------------------------------------
def test_require_loopback_dependency_directly():
    from app.setup.routes import require_loopback

    for host in ("127.0.0.1", "::1", "localhost"):
        req = types.SimpleNamespace(client=types.SimpleNamespace(host=host))
        assert require_loopback(req) is None

    remote = types.SimpleNamespace(client=types.SimpleNamespace(host="100.64.0.9"))
    with pytest.raises(HTTPException) as exc:
        require_loopback(remote)
    assert exc.value.status_code == 403

    with pytest.raises(HTTPException):
        require_loopback(types.SimpleNamespace(client=None))


def test_state_loopback_ok_remote_403(no_tools):
    app = _setup_app()

    local = TestClient(app, client=("127.0.0.1", 40000))
    resp = local.get("/setup/state")
    assert resp.status_code == 200
    assert "configured" in resp.json()
    assert "deps" in resp.json()

    remote = TestClient(app, client=("100.64.0.9", 40000))
    assert remote.get("/setup/state").status_code == 403


# --- (c) save with no token generates one ----------------------------------
def test_save_generates_token_and_configures(fresh_home, no_tools):
    config_mod, home = fresh_home
    assert config_mod.get_settings().is_configured is False

    client = TestClient(_setup_app(), client=("127.0.0.1", 40000))
    body = {
        "smtpUser": "me@gmail.com",
        "smtpAppPassword": "app-pass-1234",
        "recipients": ["a@example.com", "b@example.com"],
        "emailTemplate": "",
        "githubToken": "github_pat_test123",
    }
    resp = client.post("/setup/save", json=body)
    assert resp.status_code == 200, resp.text
    state = resp.json()

    assert state["configured"] is True
    assert state["token"]  # a bearer token was generated
    assert state["connectionCode"]
    assert state["email"]["user"] == "me@gmail.com"
    assert state["email"]["hasPassword"] is True

    # REGRESSION: a second save without a token must PRESERVE the existing one
    # (rotating it would silently 401 the already-connected laptop — the
    # dashboard's Settings tab makes re-saves routine).
    first_token = state["token"]
    resp2 = client.post("/setup/save", json=body)
    assert resp2.status_code == 200, resp2.text
    assert resp2.json()["token"] == first_token

    # Persisted to the throwaway home.
    env_file = home / "server.env"
    assert env_file.exists()
    env_text = env_file.read_text(encoding="utf-8")
    assert "BEARER_TOKEN=" in env_text
    assert "GITHUB_TOKEN=github_pat_test123" in env_text
    assert config_mod.get_settings().is_configured is True

    recipients = json.loads((home / "recipients.json").read_text(encoding="utf-8"))
    assert recipients == ["a@example.com", "b@example.com"]
    assert (home / "email_template.txt").exists()


# --- (d) detect() survives absent tools ------------------------------------
def test_detect_survives_missing_tools(no_tools):
    from app.setup import bootstrap

    deps = asyncio.run(bootstrap.detect())
    assert deps["ollama"]["installed"] is False
    assert deps["ollama"]["modelPresent"] is False
    assert deps["tailscale"]["installed"] is False
    assert deps["tailscale"]["loggedIn"] is False
    assert deps["whisperModel"]["present"] is False
    assert "name" in deps["whisperModel"]


# --- (e) jobs 503 when unconfigured ----------------------------------------
def test_jobs_return_503_when_unconfigured(monkeypatch):
    from app.routes import jobs as jobs_mod

    fake_settings = types.SimpleNamespace(is_configured=False, SERVER_PORT=8080)
    monkeypatch.setattr(jobs_mod, "get_settings", lambda: fake_settings)

    app = FastAPI()
    app.include_router(jobs_mod.router)
    client = TestClient(app)

    resp = client.get("/jobs/anything")
    assert resp.status_code == 503
    detail = resp.json()["detail"]
    assert "not set up yet" in detail
    assert "/setup" in detail
