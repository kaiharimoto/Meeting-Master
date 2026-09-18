"""The meeting progress map: POST /live/map.

Its own file rather than more of test_live.py, mirroring the split in the
feature itself — the map and the questions rail are two features sharing a
transport, with separate switches and separate failure domains.
"""

from .conftest import CANNED_MAP_OPS

AUTH = {"Authorization": "Bearer test-token"}

WINDOW = (
    "Marcus: the vendor came back at twelve percent up. "
    "Priya: we should hold the signature until that is renegotiated."
)


def _payload(**overrides):
    body = {
        "transcriptWindow": WINDOW,
        "attendees": ["Priya", "Marcus"],
        "digest": "",
    }
    body.update(overrides)
    return body


def test_requires_token(client):
    assert client.post("/live/map", json=_payload()).status_code == 401
    bad = {"Authorization": "Bearer wrong-token"}
    assert client.post("/live/map", json=_payload(), headers=bad).status_code == 401


def test_happy_path_returns_ops_not_a_map(client):
    """The answer is CHANGES to the map. The map itself never crosses the wire."""
    resp = client.post("/live/map", json=_payload(), headers=AUTH)
    assert resp.status_code == 200
    body = resp.json()
    assert list(body) == ["ops"]
    ops = body["ops"]
    assert [o["op"] for o in ops] == ["topic", "node", "status"]
    assert ops[0]["title"] == "Renewal quote"
    # Every topic carries the one sentence that stands in for it once it
    # collapses — without that, an aged-out topic has nothing to show.
    assert ops[0]["rollup"]
    assert ops[1]["topic"] == "t1" and ops[1]["kind"] == "decision"


def test_a_first_ask_with_an_empty_digest_is_normal(client):
    """The map starts empty. That is a state, not an error."""
    resp = client.post("/live/map", json=_payload(digest=""), headers=AUTH)
    assert resp.status_code == 200
    assert len(resp.json()["ops"]) == len(CANNED_MAP_OPS)


def test_empty_window_is_rejected(client):
    for bad in ("", "   "):
        resp = client.post(
            "/live/map", json=_payload(transcriptWindow=bad), headers=AUTH
        )
        assert resp.status_code == 422


def test_the_prompt_is_bounded_by_topic_count_not_meeting_length(client, monkeypatch):
    """The property that makes the map affordable on a home GPU.

    A two-hour meeting must not cost more per tick than a ten-minute one. The
    digest is the only part that grows with meeting length, so it is capped
    server-side as well as on the laptop — and capped SEPARATELY from the
    transcript window, so a long meeting's map can never crowd out the speech
    the model is supposed to be reading.
    """
    from app.pipeline import extract

    seen = {}

    async def spy(client_, settings, system, user, **kwargs):
        seen["user"] = user
        seen["kwargs"] = kwargs
        return {"ops": []}

    monkeypatch.setattr(extract._ollama, "chat_json", spy)

    huge_digest = "\n".join(
        f't{i} "Topic number {i}" — a rollup sentence for topic {i}.'
        for i in range(400)
    )
    resp = client.post(
        "/live/map",
        json=_payload(digest=huge_digest, transcriptWindow=WINDOW * 400),
        headers=AUTH,
    )
    assert resp.status_code == 200
    user = seen["user"]
    # Both halves are bounded, and neither was starved by the other.
    assert len(user) < 20000, "the whole prompt stays bounded"
    assert WINDOW.split(".")[0] in user, "the transcript survived the digest"
    assert "Topic number 399" in user, "the NEWEST topics survived the cap"
    assert "Topic number 0" not in user, "the coldest topics are what gets dropped"


def test_the_map_runs_on_ollama_with_the_live_model(client, monkeypatch):
    """Not _provider, and not a model of its own.

    A separate map model would make Ollama unload and reload between the
    questions ask and the map ask on every tick the two share — the exact
    thrash the GPU-busy guard exists to prevent.
    """
    from app.config import get_settings
    from app.pipeline import extract

    seen = {}

    async def spy(client_, settings, system, user, **kwargs):
        seen.update(kwargs)
        return {"ops": []}

    monkeypatch.setattr(extract._ollama, "chat_json", spy)
    monkeypatch.setenv("LIVE_MODEL", "tiny-live-model")
    get_settings.cache_clear()
    try:
        assert client.post("/live/map", json=_payload(), headers=AUTH).status_code == 200
        assert seen["model"] == "tiny-live-model"
        assert seen["keep_alive"]  # held resident between ticks
    finally:
        get_settings.cache_clear()


def test_a_malformed_op_costs_one_op_not_the_tick(client, monkeypatch):
    """A local model that invents a field must not cost the whole ask.

    The laptop does the other half of this (an op naming an id it has never
    seen is dropped there, where the map actually lives).
    """
    from app.pipeline import extract

    async def junk(client_, settings, system, user, **kwargs):
        return {
            "ops": [
                {"op": "topic", "id": "t1", "title": "Kept"},
                {"op": "nonsense", "id": "t2"},          # unknown op
                {"op": "node", "topic": "t1", "text": "no id"},  # unusable
                {"op": "link", "from": "n1"},            # half a link
                "not an object",
                {"op": "status", "id": "n1", "status": "resolved"},
            ]
        }

    monkeypatch.setattr(extract._ollama, "chat_json", junk)
    resp = client.post("/live/map", json=_payload(), headers=AUTH)
    assert resp.status_code == 200
    ops = resp.json()["ops"]
    assert [o["op"] for o in ops] == ["topic", "status"]


def test_an_empty_ops_array_is_a_correct_answer(client, monkeypatch):
    """Most excerpts only elaborate what is already on the map."""
    from app.pipeline import extract

    async def nothing(client_, settings, system, user, **kwargs):
        return {"ops": []}

    monkeypatch.setattr(extract._ollama, "chat_json", nothing)
    resp = client.post("/live/map", json=_payload(), headers=AUTH)
    assert resp.status_code == 200
    assert resp.json()["ops"] == []


def test_the_map_switches_off_independently_of_the_questions_rail(client, monkeypatch):
    """The two live features share a transport, not a switch."""
    from app.config import get_settings

    monkeypatch.setenv("LIVE_MAP", "false")
    get_settings.cache_clear()
    try:
        cfg = client.get("/live/config", headers=AUTH).json()
        assert cfg["map"]["enabled"] is False
        assert cfg["enabled"] is True, "the questions rail is untouched"

        resp = client.post("/live/map", json=_payload(), headers=AUTH)
        assert resp.status_code == 503
        assert "turned off" in resp.json()["detail"]

        # …and the questions path still answers.
        questions = client.post(
            "/live/questions",
            json={"transcriptWindow": WINDOW, "attendees": [], "alreadyFlagged": []},
            headers=AUTH,
        )
        assert questions.status_code == 200
    finally:
        get_settings.cache_clear()


def test_the_questions_rail_switches_off_without_taking_the_map(client, monkeypatch):
    """The other direction of the same independence."""
    from app.config import get_settings

    monkeypatch.setenv("LIVE_SUGGESTIONS", "false")
    get_settings.cache_clear()
    try:
        cfg = client.get("/live/config", headers=AUTH).json()
        assert cfg["enabled"] is False
        assert cfg["map"]["enabled"] is True

        assert (
            client.post("/live/questions", json=_payload(), headers=AUTH).status_code
            == 503
        )
        assert client.post("/live/map", json=_payload(), headers=AUTH).status_code == 200
    finally:
        get_settings.cache_clear()


def test_ollama_unreachable_is_a_502(client, monkeypatch):
    from app.config import get_settings

    monkeypatch.setenv("OLLAMA_URL", "http://127.0.0.1:9")
    get_settings.cache_clear()
    try:
        resp = client.post("/live/map", json=_payload(), headers=AUTH)
        assert resp.status_code == 502
        assert "Meeting map failed" in resp.json()["detail"]
    finally:
        get_settings.cache_clear()


def test_a_busy_gpu_is_a_409_not_a_failure(client):
    """Same rule as the questions path: standing aside is not failing."""
    from app.main import store
    from app.models import JobState, MeetingDetails, MeetingMeta

    job = store.create(MeetingMeta(details=MeetingDetails(title="Busy GPU")))
    try:
        for busy in (JobState.transcribing, JobState.summarizing):
            store.update(job, state=busy)
            resp = client.post("/live/map", json=_payload(), headers=AUTH)
            assert resp.status_code == 409
            assert "busy" in resp.json()["detail"]
    finally:
        store.update(job, state=JobState.failed)


def test_config_tells_the_laptop_how_to_run_the_map_loop(client):
    cfg = client.get("/live/config", headers=AUTH).json()["map"]
    assert cfg["enabled"] is True
    assert cfg["intervalSec"] >= 20
    assert cfg["windowChars"] >= 500
    assert cfg["digestChars"] >= 500
    # The laptop must always be the MORE patient of the two, exactly as on the
    # questions path — a client that gives up first turns a slow but working
    # server into a permanent failure.
    assert cfg["clientTimeoutSec"] > client.get(
        "/live/config", headers=AUTH
    ).json()["timeoutSec"]
