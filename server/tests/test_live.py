"""POST /live/questions — mid-meeting live question flagging."""

AUTH = {"Authorization": "Bearer test-token"}


def _payload(**overrides):
    body = {
        "transcriptWindow": (
            "Alice: What is the renewal price? "
            "Bob: A 12% increase locked for 24 months."
        ),
        "attendees": ["Alice", "Bob"],
        "alreadyFlagged": [],
    }
    body.update(overrides)
    return body


def test_requires_token(client):
    assert client.post("/live/questions", json=_payload()).status_code == 401
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


def test_already_flagged_questions_are_filtered(client):
    resp = client.post(
        "/live/questions",
        json=_payload(alreadyFlagged=["what is the renewal price?"]),
        headers=AUTH,
    )
    assert resp.status_code == 200
    assert resp.json()["questions"] == []


def test_empty_window_is_rejected(client):
    resp = client.post(
        "/live/questions", json=_payload(transcriptWindow=""), headers=AUTH
    )
    assert resp.status_code == 422
    resp = client.post(
        "/live/questions", json=_payload(transcriptWindow="   "), headers=AUTH
    )
    assert resp.status_code == 422


def test_ollama_unreachable_is_a_502(client, monkeypatch):
    # Point the (per-request) settings at a dead port; the route must answer
    # with a clean 502 the laptop can silently skip, not hang or 500.
    from app.config import get_settings

    monkeypatch.setenv("OLLAMA_URL", "http://127.0.0.1:9")
    get_settings.cache_clear()
    try:
        resp = client.post("/live/questions", json=_payload(), headers=AUTH)
        assert resp.status_code == 502
        assert "Live question extraction failed" in resp.json()["detail"]
    finally:
        get_settings.cache_clear()  # monkeypatch restores the env for later tests
