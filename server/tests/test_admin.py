"""The bearer-gated /admin mount: same settings, different door.

The invariants worth pinning here are the two that make the remote mount safe
to exist at all — it never leaks the token, and it is the SAME code as the
loopback mount rather than a copy that will drift.
"""

import pytest

AUTH = {"Authorization": "Bearer test-token"}


@pytest.fixture()
def loopback(client):
    """A second client onto the SAME app that looks like the home PC's browser.

    The shared `client` fixture reports a peer of "testclient", which is exactly
    what require_loopback is there to turn away — so /setup needs its own. No
    `with`: entering a second TestClient would re-run the lifespan against a
    store the first one already owns (see the note in test_monitor.py).
    """
    from fastapi.testclient import TestClient

    from app.main import app

    return TestClient(app, base_url="http://127.0.0.1:8080", client=("127.0.0.1", 40100))

# Every route the remote mount exposes, with a body where one is needed.
READ_ROUTES = ["/admin/state", "/admin/ollama-models", "/admin/jobs", "/admin/logs"]
WRITE_ROUTES = [
    ("/admin/ai-test", {}),
    ("/admin/live-test", {}),
]


# --- (a) the door is locked -------------------------------------------------
@pytest.mark.parametrize("path", READ_ROUTES)
def test_reads_need_the_token(client, path):
    assert client.get(path).status_code == 401
    assert client.get(path, headers=AUTH).status_code == 200


@pytest.mark.parametrize("path,body", WRITE_ROUTES)
def test_writes_need_the_token(client, path, body):
    assert client.post(path, json=body).status_code == 401


def test_save_needs_the_token(client):
    assert client.post("/admin/save", json={"recipients": []}).status_code == 401


# --- (b) the token never comes back out -------------------------------------
def test_admin_config_redacts_the_token(client):
    state = client.get("/admin/state", headers=AUTH).json()
    assert state["token"] is None
    # The connection code is the same secret, base64'd — redacting one and not
    # the other would have leaked it just as completely.
    assert state["connectionCode"] is None
    # ...while the non-secret configuration is all still there.
    assert state["configured"] is True
    assert "ollamaModel" in state and "liveParams" in state


def test_the_token_string_appears_nowhere_in_the_payload(client):
    """Belt and braces: scan the serialized body, not just the two keys we
    thought to redact. A field added to build_state later gets caught here."""
    raw = client.get("/admin/state", headers=AUTH).text
    assert "test-token" not in raw


def test_loopback_state_still_shows_the_token(loopback):
    """The redaction is per-mount, not a global removal — the local dashboard
    still needs the token to render the connection code."""
    state = loopback.get("/setup/state").json()
    assert state["token"] == "test-token"
    assert state["connectionCode"]


# --- (c) the token cannot be changed from here ------------------------------
def test_admin_refuses_to_rotate_the_token(client, loopback):
    resp = client.post(
        "/admin/save", json={"recipients": [], "token": "a-brand-new-token"}, headers=AUTH
    )
    assert resp.status_code == 400
    assert "cannot be changed remotely" in resp.json()["detail"]
    # And it really is unchanged — a refusal that still wrote would be worse
    # than the silent drop this replaced.
    assert loopback.get("/setup/state").json()["token"] == "test-token"


def test_a_save_without_a_token_field_keeps_the_saved_one(client, loopback):
    resp = client.post("/admin/save", json={"recipients": []}, headers=AUTH)
    assert resp.status_code == 200
    assert loopback.get("/setup/state").json()["token"] == "test-token"


# --- (d) secrets are write-only ---------------------------------------------
def test_blank_secrets_do_not_clobber_saved_ones(client):
    client.post(
        "/admin/save",
        json={"recipients": [], "smtpAppPassword": "hunter2", "githubToken": "ghp_x"},
        headers=AUTH,
    )
    # Saving again with the fields blank must not wipe them.
    state = client.post("/admin/save", json={"recipients": []}, headers=AUTH).json()
    assert state["email"]["hasPassword"] is True
    assert state["githubTokenSet"] is True
    # Set, but never readable.
    raw = client.get("/admin/state", headers=AUTH).text
    assert "hunter2" not in raw and "ghp_x" not in raw


# --- (e) one body, two mounts -----------------------------------------------
@pytest.mark.parametrize("base", ["/setup", "/admin"])
def test_both_mounts_clamp_identically(client, loopback, base):
    """The whole point of delegating instead of copying. If someone adds a
    clamp to one mount only, this fails."""
    path = f"{base}/save"
    caller, headers = (loopback, {}) if base == "/setup" else (client, AUTH)
    state = caller.post(
        path,
        json={"recipients": [], "liveIntervalSec": 99999, "extractTemperature": 9.9},
        headers=headers,
    ).json()
    assert state["liveParams"]["liveIntervalSec"] == 600
    assert state["aiParams"]["extractTemperature"] == 2.0


@pytest.mark.parametrize("base", ["/setup", "/admin"])
def test_both_mounts_reject_an_impossible_context(client, loopback, base):
    path = f"{base}/save"
    caller, headers = (loopback, {}) if base == "/setup" else (client, AUTH)
    resp = caller.post(
        path,
        json={"recipients": [], "numCtx": 2048, "summaryNumPredict": 8192},
        headers=headers,
    )
    assert resp.status_code == 422


def test_a_remote_save_takes_effect_without_a_restart(client):
    """write_env clears the settings cache, so the next call sees the change.
    This is what makes remote administration useful mid-meeting rather than
    something that needs someone to reboot the home PC."""
    client.post(
        "/admin/save", json={"recipients": [], "liveModel": "small-model:1b"}, headers=AUTH
    )
    assert client.get("/live/config", headers=AUTH).json()["model"] == "small-model:1b"


# --- (f) the module stays a delegation --------------------------------------
def test_admin_module_holds_no_logic_of_its_own():
    """Source read, in the spirit of the invariants CLAUDE.md lists: this
    covers wiring no functional test reaches. Every route body is a one-line
    delegation; the moment someone implements something here instead of in
    setup/routes.py, the two mounts have started to drift."""
    from pathlib import Path

    import app.routes.admin as admin_mod

    source = Path(admin_mod.__file__).read_text(encoding="utf-8")
    # The connection code is the token in another wrapper — this module must
    # never learn how to build one.
    assert "connection_code" not in source
    assert "encode_connection_code" not in source
    # No clamping, validation or env writing may live here.
    for forbidden in ("_clamp", "write_env", "secrets.token_urlsafe"):
        assert forbidden not in source, f"{forbidden} belongs in setup/routes.py"


def test_admin_routes_are_all_gated():
    """Nothing gets mounted here without the bearer dependency — a route added
    without it would be a hole with no test of its own."""
    from app.auth import verify_token
    from app.routes import admin as admin_mod

    deps = [d.dependency for d in admin_mod.router.dependencies]
    assert verify_token in deps


# --- (g) one page, two mounts -----------------------------------------------
def test_the_remote_page_points_its_script_at_the_admin_mount(client):
    """dashboard.js reads window.MM_API_BASE and makes every request relative
    to it. If this stops being injected the remote page silently talks to
    /setup, gets 403 on everything, and looks broken for no visible reason."""
    html = client.get("/admin", headers=AUTH).text
    assert 'window.MM_API_BASE="/admin"' in html
    assert "/admin/assets/dashboard.js" in html
    # ...and it must not still be asking for the loopback mount's assets.
    assert "/setup/assets/" not in html


def test_the_local_page_is_left_alone(loopback):
    """No MM_API_BASE on the home PC: dashboard.js falls back to "/setup", so
    the local dashboard is unchanged by any of this."""
    html = loopback.get("/setup").text
    assert "MM_API_BASE" not in html
    assert "/setup/assets/dashboard.js" in html


def test_both_mounts_serve_the_same_script(client, loopback):
    """Byte-for-byte. The mount difference lives in one injected global and a
    CSS class, never in the script — a fork here is how the two dashboards
    would quietly stop behaving the same way."""
    remote = client.get("/admin/assets/dashboard.js", headers=AUTH)
    local = loopback.get("/setup/assets/dashboard.js")
    assert remote.status_code == 200
    assert remote.text == local.text


def test_the_connection_code_is_not_mirrored(client):
    """It returns the token. The absence is the point, so it gets a test."""
    assert client.get("/admin/connection-code", headers=AUTH).status_code == 404
