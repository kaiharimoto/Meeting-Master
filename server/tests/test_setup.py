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
import sys
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


def _clear_all_settings_caches():
    """Clear EVERY live reference to get_settings' cache, not just app.config's.

    reload(app.config) rebinds config.get_settings to a fresh lru_cache, but the
    modules that did ``from ..config import get_settings`` (routes, auth,
    worker) still hold the PREVIOUS function object — and its populated cache.
    Clearing only the reloaded one leaves those serving pre-reload settings, so
    a later test could save a setting, see it through /setup/state (which reads
    the module attribute) and NOT through a route (which holds a stale name).
    reload mutates the module in place, so the old function's globals are the
    restored ones by the time this runs.
    """
    for module in list(sys.modules.values()):
        fn = getattr(module, "get_settings", None)
        if fn is not None and hasattr(fn, "cache_clear"):
            fn.cache_clear()


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
    _clear_all_settings_caches()
    try:
        yield config_mod, tmp_path
    finally:
        for k, v in snapshot.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        importlib.reload(config_mod)
        _clear_all_settings_caches()


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


def test_save_ai_params_persists_and_clamps(client, tmp_path, monkeypatch):
    """The hands-on AI tuning fields round-trip through save -> state, and
    out-of-range values are clamped instead of wedging the pipeline."""
    from fastapi.testclient import TestClient

    from app.config import get_settings
    from app.main import app

    local = TestClient(app, client=("127.0.0.1", 40010))
    before = local.get("/setup/state").json()
    assert before["aiParams"]["numCtx"] >= 2048

    resp = local.post("/setup/save", json={
        "recipients": before.get("recipients") or [],
        "emailTemplate": before.get("emailTemplate") or "",
        "ollamaUrl": "http://127.0.0.1:12345/",
        "numCtx": 16384,
        "summaryNumPredict": 999999,   # clamped to 8192
        "summaryTemperature": 0.7,
        "extractNumPredict": 1500,
        "extractTemperature": 9.5,     # clamped to 2.0
    })
    assert resp.status_code == 200, resp.text

    # OLLAMA_URL: the test env var (fake Ollama stub) outranks the file, so
    # check the persisted file for that one; the numerics come via settings.
    from app import config as app_config

    env_text = app_config.ENV_FILE.read_text(encoding="utf-8")
    assert "OLLAMA_URL=http://127.0.0.1:12345" in env_text

    settings = get_settings()
    assert settings.NUM_CTX == 16384
    assert settings.SUMMARY_NUM_PREDICT == 8192
    assert settings.SUMMARY_TEMPERATURE == 0.7
    assert settings.EXTRACT_TEMPERATURE == 2.0

    after = local.get("/setup/state").json()
    assert after["aiParams"]["numCtx"] == 16384
    # (ollamaUrl in state reflects the env-var override the test harness sets,
    # so the file assertion above is the persistence proof for that field.)


def test_save_live_params_persists_and_clamps(client):
    """Live suggestions are configured on the dashboard and nowhere else, so
    save -> state -> GET /live/config must agree — with clamps, since these
    numbers drive a loop that runs during a meeting."""
    from fastapi.testclient import TestClient

    from app.config import get_settings
    from app.main import app

    local = TestClient(app, client=("127.0.0.1", 40013))
    before = local.get("/setup/state").json()
    assert before["liveParams"]["liveSuggestions"] is True

    resp = local.post("/setup/save", json={
        "recipients": before.get("recipients") or [],
        "emailTemplate": before.get("emailTemplate") or "",
        "liveSuggestions": True,
        "liveModel": "small-live-model",
        "liveIntervalSec": 5,          # clamped up to 15
        "liveWindowChars": 99999,      # clamped down to 12000
        "liveTimeoutSec": 120,
        "liveKeepAliveMin": 0,         # a real value, not "unset"
        "liveExtractNumPredict": 800,
    })
    assert resp.status_code == 200, resp.text

    settings = get_settings()
    assert settings.LIVE_MODEL == "small-live-model"
    assert settings.live_model == "small-live-model"
    assert settings.LIVE_INTERVAL_SEC == 15
    assert settings.LIVE_WINDOW_CHARS == 12000
    assert settings.LIVE_TIMEOUT_SEC == 120
    assert settings.LIVE_KEEP_ALIVE_MIN == 0
    assert settings.LIVE_EXTRACT_NUM_PREDICT == 800

    after = local.get("/setup/state").json()["liveParams"]
    assert after["liveModel"] == "small-live-model"
    assert after["liveModelEffective"] == "small-live-model"
    assert after["liveIntervalSec"] == 15

    # What the laptop actually reads. The cache clear is an artifact of this
    # test process, not of the product: an earlier test reloaded app.config
    # (see fresh_home), so the routes hold a different get_settings function
    # from the one write_env clears. A real server never reloads its config
    # module, and there write_env's own cache clear is sufficient.
    _clear_all_settings_caches()
    cfg = client.get("/live/config", headers={"Authorization": "Bearer test-token"}).json()
    assert cfg["intervalSec"] == 15 and cfg["windowChars"] == 12000
    assert cfg["clientTimeoutSec"] > cfg["timeoutSec"] == 120

    # Blank means "use the summary model" — a meaningful value, not "unset".
    assert local.post("/setup/save", json={
        "recipients": [], "emailTemplate": before.get("emailTemplate") or "",
        "liveModel": "",
    }).status_code == 200
    settings = get_settings()
    assert settings.LIVE_MODEL == "" and settings.live_model == settings.OLLAMA_MODEL


def test_live_test_endpoint_reports_what_came_back(client):
    """The dashboard's "Test live suggestions" runs the REAL live path over a
    fixed sample and never raises — the payload is the diagnosis."""
    from fastapi.testclient import TestClient

    from app.main import app

    local = TestClient(app, client=("127.0.0.1", 40014))
    result = local.post("/setup/live-test", json={}).json()
    assert set(result) >= {
        "ok", "enabled", "model", "latencyMs", "intervalSec",
        "slowerThanInterval", "questions", "insights", "error",
    }
    assert result["ok"] is True and result["error"] is None
    # The sample conversation contains an answered question AND a lesson, so a
    # working model finds both.
    assert len(result["questions"]) >= 1 and len(result["insights"]) >= 1

    remote = TestClient(app, client=("203.0.113.9", 40015))
    assert remote.post("/setup/live-test", json={}).status_code == 403


def test_ai_helper_endpoints(client):
    """ollama-models + ai-test never raise — they report, loopback-only."""
    from fastapi.testclient import TestClient

    from app.main import app

    local = TestClient(app, client=("127.0.0.1", 40011))
    models = local.get("/setup/ollama-models")
    assert models.status_code == 200 and "models" in models.json()

    result = local.post("/setup/ai-test", json={"numCtx": 4096}).json()
    assert set(result) >= {"ok", "latencyMs", "model", "numCtx", "error"}
    assert result["numCtx"] == 4096  # the unsaved override was applied

    remote = TestClient(app, client=("203.0.113.9", 40012))
    assert remote.post("/setup/ai-test", json={}).status_code == 403
