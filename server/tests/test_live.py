"""Mid-meeting live suggestions: GET /live/config, POST /live/warmup,
POST /live/questions."""

from .conftest import CANNED_LIVE_INSIGHTS

AUTH = {"Authorization": "Bearer test-token"}


def _payload(**overrides):
    body = {
        "transcriptWindow": (
            "Alice: What is the renewal price? "
            "Bob: A 12% increase locked for 24 months."
        ),
        "attendees": ["Alice", "Bob"],
        "alreadyFlagged": [],
        "alreadyInsights": [],
    }
    body.update(overrides)
    return body


def test_requires_token(client):
    assert client.post("/live/questions", json=_payload()).status_code == 401
    assert client.get("/live/config").status_code == 401
    assert client.post("/live/warmup").status_code == 401
    bad = {"Authorization": "Bearer wrong-token"}
    assert client.post("/live/questions", json=_payload(), headers=bad).status_code == 401


def test_happy_path_returns_candidates(client):
    resp = client.post("/live/questions", json=_payload(), headers=AUTH)
    assert resp.status_code == 200
    questions = resp.json()["questions"]
    assert len(questions) == 1
    q = questions[0]
    assert q["question"] == "What is the renewal price?"
    assert q["answerer"] == "Bob"
    assert q["confidence"] == "high"


def test_insights_come_back_alongside_questions(client):
    """The rail offers two kinds of suggestion from one call."""
    resp = client.post("/live/questions", json=_payload(), headers=AUTH)
    assert resp.status_code == 200
    assert resp.json()["insights"] == CANNED_LIVE_INSIGHTS


def test_already_suggested_items_are_filtered(client):
    """Neither a question nor an insight is ever offered to the operator twice."""
    resp = client.post(
        "/live/questions",
        json=_payload(
            alreadyFlagged=["what is the renewal price?"],
            alreadyInsights=[CANNED_LIVE_INSIGHTS[0].upper()],  # case-insensitive
        ),
        headers=AUTH,
    )
    assert resp.status_code == 200
    assert resp.json() == {"questions": [], "insights": []}


def test_empty_window_is_rejected(client):
    resp = client.post(
        "/live/questions", json=_payload(transcriptWindow=""), headers=AUTH
    )
    assert resp.status_code == 422
    resp = client.post(
        "/live/questions", json=_payload(transcriptWindow="   "), headers=AUTH
    )
    assert resp.status_code == 422


def test_config_tells_the_laptop_how_to_run_the_loop(client):
    resp = client.get("/live/config", headers=AUTH)
    assert resp.status_code == 200
    cfg = resp.json()
    assert cfg["enabled"] is True
    assert cfg["insights"] is True
    assert cfg["model"]  # falls back to OLLAMA_MODEL when LIVE_MODEL is blank
    # The laptop must always be the MORE patient of the two, or it records
    # failures for requests the server is still working on.
    assert cfg["clientTimeoutSec"] > cfg["timeoutSec"]
    assert cfg["intervalSec"] >= 10 and cfg["windowChars"] >= 500


def test_warmup_reports_instead_of_raising(client):
    resp = client.post("/live/warmup", headers=AUTH)
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["model"] and body["error"] is None


def test_live_model_override_is_used(client, monkeypatch):
    """LIVE_MODEL points the live path at a different (smaller) model."""
    from app.config import get_settings

    monkeypatch.setenv("LIVE_MODEL", "tiny-live-model")
    get_settings.cache_clear()
    try:
        cfg = client.get("/live/config", headers=AUTH).json()
        assert cfg["model"] == "tiny-live-model"
    finally:
        get_settings.cache_clear()


def test_disabled_is_a_clean_503_everywhere(client, monkeypatch):
    """Turned off on the dashboard: the laptop is told so, not left guessing."""
    from app.config import get_settings

    monkeypatch.setenv("LIVE_SUGGESTIONS", "false")
    get_settings.cache_clear()
    try:
        cfg = client.get("/live/config", headers=AUTH).json()
        assert cfg["enabled"] is False
        for resp in (
            client.post("/live/questions", json=_payload(), headers=AUTH),
            client.post("/live/warmup", headers=AUTH),
        ):
            assert resp.status_code == 503
            assert "turned off" in resp.json()["detail"]
    finally:
        get_settings.cache_clear()


def test_ollama_unreachable_is_a_502(client, monkeypatch):
    # Point the (per-request) settings at a dead port; the route must answer
    # with a clean 502 the laptop can report in its rail, not hang or 500.
    from app.config import get_settings

    monkeypatch.setenv("OLLAMA_URL", "http://127.0.0.1:9")
    get_settings.cache_clear()
    try:
        resp = client.post("/live/questions", json=_payload(), headers=AUTH)
        assert resp.status_code == 502
        assert "Live suggestions failed" in resp.json()["detail"]
        # Warmup never raises — the payload IS the diagnosis.
        warm = client.post("/live/warmup", headers=AUTH)
        assert warm.status_code == 200
        assert warm.json()["ok"] is False and warm.json()["error"]
    finally:
        get_settings.cache_clear()  # monkeypatch restores the env for later tests
