"""Monitoring API: job list, log tail, SSE broker + stream, auth boundaries."""

import asyncio
import io
import json
import logging
import time
import types

import pytest

AUTH = {"Authorization": "Bearer test-token"}

MEETING = {
    "schemaVersion": 1,
    "details": {
        "title": "Monitor Sync",
        "date": "2026-07-19",
        "time": "10:00",
        "attendees": ["Alice"],
    },
    "cards": [],
    "recipients": ["dest@example.com"],
    "options": {},
}


def _upload(client) -> str:
    response = client.post(
        "/jobs",
        headers=AUTH,
        data={"meeting": json.dumps(MEETING)},
        files={"file": ("audio.wav", io.BytesIO(b"RIFF" + b"\x00" * 64), "audio/wav")},
    )
    assert response.status_code == 202, response.text
    return response.json()["id"]


def _wait_ready(client, job_id, timeout=30.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        record = client.get(f"/jobs/{job_id}", headers=AUTH).json()
        if record["state"] in ("ready", "failed"):
            return record
        time.sleep(0.05)
    pytest.fail("job never finished")


# ---- Job list ---------------------------------------------------------------

def test_jobs_list_requires_token(client):
    assert client.get("/jobs").status_code == 401
    assert (
        client.get("/jobs", headers={"Authorization": "Bearer wrong"}).status_code
        == 401
    )


def test_jobs_list_shape_order_and_trimming(client):
    first = _upload(client)
    _wait_ready(client, first)
    second = _upload(client)
    _wait_ready(client, second)

    payload = client.get("/jobs", headers=AUTH).json()
    jobs = payload["jobs"]
    ids = [j["id"] for j in jobs]
    assert first in ids and second in ids
    # Newest first.
    assert ids.index(second) < ids.index(first)

    entry = jobs[ids.index(first)]
    assert entry["title"] == "Monitor Sync"
    assert entry["state"] in ("ready", "failed")
    assert set(entry.keys()) == {
        "id", "state", "progress", "createdAt", "updatedAt", "title", "error",
        "summaryError", "questionsError", "pdf",
    }
    # Trimmed: meeting content must never ride along in list view.
    assert "transcript" not in entry and "summary" not in entry and "questions" not in entry


def test_jobs_list_loopback_mirror(client):
    job_id = _upload(client)
    _wait_ready(client, job_id)
    # The /setup mirror serves the same data without a bearer token. NOTE: the
    # extra TestClients are used WITHOUT `with` on purpose — entering them
    # would run a SECOND lifespan on the same app and clobber the live
    # broker/worker wiring the outer `client` fixture set up.
    from fastapi.testclient import TestClient

    from app.main import app

    local = TestClient(app, client=("127.0.0.1", 40000))
    assert job_id in [j["id"] for j in local.get("/setup/jobs").json()["jobs"]]

    remote = TestClient(app, client=("100.64.0.9", 40000))
    assert remote.get("/setup/jobs").status_code == 403


# ---- Log tail ---------------------------------------------------------------

def test_log_tail_returns_recent_lines(client):
    # .warning: under pytest the root level may still be WARNING (basicConfig
    # in main.py is a no-op once pytest installed its own handlers).
    logging.getLogger("monitor-test").warning("hello from the monitor test")
    lines = client.get("/logs/tail", headers=AUTH).json()["lines"]
    assert any("hello from the monitor test" in line for line in lines)

    # The loopback mirror sees the same ring. (No `with` — a nested lifespan
    # would clobber the outer client fixture's broker/worker wiring.)
    from fastapi.testclient import TestClient

    from app.main import app

    local = TestClient(app, client=("127.0.0.1", 40000))
    logging.getLogger("monitor-test").warning("second marker line")
    mirrored = local.get("/setup/logs").json()["lines"]
    assert any("second marker line" in line for line in mirrored)


# ---- Broker unit tests ------------------------------------------------------

def test_broker_publish_subscribe_and_ring_replay():
    from app.events import EventBroker

    async def scenario():
        broker = EventBroker(ring_size=4)
        q = broker.subscribe()
        broker.publish("job", {"n": 1})
        broker.publish("log", {"n": 2})
        eid1, name1, data1 = q.get_nowait()
        eid2, name2, _ = q.get_nowait()
        assert (name1, name2) == ("job", "log")
        assert eid2 == eid1 + 1
        assert json.loads(data1) == {"n": 1}

        # Replay: from a known id -> newer events; unknown/too old -> None.
        assert [e[0] for e in broker.replay_since(eid1)] == [eid2]
        assert broker.replay_since(eid2) == []
        for n in range(3, 9):  # overflow the 4-slot ring
            broker.publish("job", {"n": n})
        assert broker.replay_since(eid1) is None

        broker.unsubscribe(q)
        depth = q.qsize()
        broker.publish("job", {"n": 99})
        assert q.qsize() == depth  # unsubscribed queues receive nothing new

    asyncio.run(scenario())


def test_broker_drops_slow_subscribers():
    from app import events
    from app.events import EventBroker

    async def scenario():
        broker = EventBroker()
        q = broker.subscribe()
        for n in range(events._SUBSCRIBER_QUEUE_MAX + 5):
            broker.publish("log", {"n": n})
        # The overflowing subscriber was dropped, not blocked on.
        assert q.full()
        broker.publish("log", {"n": -1})
        assert q.qsize() == events._SUBSCRIBER_QUEUE_MAX

    asyncio.run(scenario())


# ---- SSE stream (bounded, driven directly) ----------------------------------

def test_event_stream_hello_and_live_event(client):
    """Drive the SSE generator directly with a stubbed request — bounded, no
    real socket. Uses the app's live broker/store from the running lifespan."""
    from app.main import app as fastapi_app
    from app.routes.monitor import event_stream

    job_id = _upload(client)
    _wait_ready(client, job_id)

    async def scenario():
        request = types.SimpleNamespace(app=fastapi_app, headers={})
        response = event_stream(request)
        gen = response.body_iterator

        first = await asyncio.wait_for(gen.__anext__(), 5)
        assert "retry:" in first

        hello = await asyncio.wait_for(gen.__anext__(), 5)
        assert "event: hello" in hello
        payload = json.loads(hello.split("data: ", 1)[1].strip())
        assert payload["version"]
        assert any(j["id"] == job_id for j in payload["jobs"])

        # A live publish reaches the open stream.
        broker = fastapi_app.state.broker
        broker.publish("job", {"id": "live-1", "state": "queued"})
        live = await asyncio.wait_for(gen.__anext__(), 5)
        assert "event: job" in live and "live-1" in live

        await gen.aclose()

    # The client fixture's lifespan loop is separate; run our own loop but
    # point the broker at it so publish/subscribe share it.
    broker = fastapi_app.state.broker

    async def runner():
        broker.bind_loop(asyncio.get_running_loop())
        await scenario()

    asyncio.run(runner())


def test_dashboard_assets_whitelist(client):
    # No `with` on the extra clients — a nested lifespan would clobber the
    # outer client fixture's broker/worker wiring.
    from fastapi.testclient import TestClient

    from app.main import app

    local = TestClient(app, client=("127.0.0.1", 40000))
    page = local.get("/setup")
    assert page.status_code == 200
    assert "dashboard.js" in page.text  # the dashboard shell is served

    css = local.get("/setup/assets/dashboard.css")
    assert css.status_code == 200
    assert "text/css" in css.headers["content-type"]

    js = local.get("/setup/assets/dashboard.js")
    assert js.status_code == 200

    # Only whitelisted names are served — no traversal, no surprises.
    assert local.get("/setup/assets/setup.html").status_code == 404
    assert local.get("/setup/assets/..%2F..%2Fconfig.py").status_code == 404

    remote = TestClient(app, client=("100.64.0.9", 40000))
    assert remote.get("/setup/assets/dashboard.js").status_code == 403


def test_event_routes_registered():
    from app.main import app as fastapi_app

    def walk(routes):
        for r in routes:
            path = getattr(r, "path", None)
            if path:
                yield path
            # This FastAPI version wraps include_router() targets in an
            # _IncludedRouter holding the real APIRouter as original_router.
            inner = getattr(r, "original_router", None)
            yield from walk(getattr(r, "routes", []) or [])
            if inner is not None:
                yield from walk(getattr(inner, "routes", []) or [])

    paths = set(walk(fastapi_app.routes))
    assert {"/events", "/logs/tail", "/setup/events", "/setup/jobs", "/setup/logs"} <= paths


# ---- Transcript + external-AI prompt endpoints ------------------------------

def test_transcript_and_prompt_endpoints(client):
    job_id = _upload(client)
    _wait_ready(client, job_id)

    # Bearer-gated transcript download.
    assert client.get(f"/jobs/{job_id}/transcript").status_code == 401
    resp = client.get(f"/jobs/{job_id}/transcript", headers=AUTH)
    assert resp.status_code == 200
    assert resp.headers["content-disposition"].startswith("attachment")
    assert resp.text.strip()  # the fake whisper stub produced text

    # The prompt embeds the real system prompt, the meeting context, the
    # transcript, and the round-trip instructions.
    prompt = client.get(f"/jobs/{job_id}/prompt", headers=AUTH)
    assert prompt.status_code == 200
    assert "keyTakeaways" in prompt.text          # schema the reply must use
    assert resp.text.strip()[:40] in prompt.text  # transcript embedded
    assert "Import AI output" in prompt.text      # round-trip instructions

    # Loopback dashboard mirrors (no bearer, loopback-only).
    from fastapi.testclient import TestClient
    from app.main import app

    local = TestClient(app, client=("127.0.0.1", 40001))
    assert local.get(f"/setup/jobs/{job_id}/transcript").status_code == 200
    assert local.get(f"/setup/jobs/{job_id}/prompt").status_code == 200
    remote = TestClient(app, client=("203.0.113.9", 40002))
    assert remote.get(f"/setup/jobs/{job_id}/transcript").status_code == 403

    # Unknown job / no transcript -> 404.
    assert client.get("/jobs/nope/transcript", headers=AUTH).status_code == 404
    assert client.get("/jobs/nope/prompt", headers=AUTH).status_code == 404


def test_summarize_retry_endpoint(client):
    """POST /jobs/{id}/summarize re-runs the AI stages on the stored
    transcript — the separate-stages escape hatch after a summary failure."""
    job_id = _upload(client)
    _wait_ready(client, job_id)

    assert client.post(f"/jobs/{job_id}/summarize").status_code == 401
    resp = client.post(f"/jobs/{job_id}/summarize", headers=AUTH)
    assert resp.status_code == 200 and resp.json()["queued"] is True

    record = _wait_ready(client, job_id)  # summarizing -> ready again
    assert record["state"] == "ready"
    assert record["transcript"]["text"].strip()  # transcript untouched

    # No transcript / unknown id -> 404.
    assert client.post("/jobs/nope/summarize", headers=AUTH).status_code == 404

    # Loopback twin for the dashboard.
    from fastapi.testclient import TestClient
    from app.main import app

    local = TestClient(app, client=("127.0.0.1", 40003))
    assert local.post(f"/setup/jobs/{job_id}/summarize").status_code == 200


# ---- Two-step pipeline + transcript name tools ------------------------------

def test_skip_ai_stops_after_transcript_and_names_roundtrip(client):
    """options.skipAi lands the job in ready with a transcript and NO AI
    output; the names endpoints harvest candidates and rewrite the stored
    transcript before Start AI (POST /summarize) runs the AI stages."""
    import copy as _copy
    meeting = _copy.deepcopy(MEETING)
    meeting["details"]["attendees"] = ["Kai", "Alice"]
    meeting["options"] = {"skipAi": True}
    resp = client.post(
        "/jobs",
        headers=AUTH,
        data={"meeting": json.dumps(meeting)},
        files={"file": ("audio.wav", io.BytesIO(b"RIFF" + b"\x00" * 64), "audio/wav")},
    )
    assert resp.status_code == 202
    job_id = resp.json()["id"]
    record = _wait_ready(client, job_id)
    assert record["state"] == "ready"
    assert record["summary"] is None          # AI deferred
    assert record["questions"] == []
    assert record["transcript"]["text"].strip()

    # Candidate names include the attendees.
    names = client.get(f"/jobs/{job_id}/names", headers=AUTH).json()["names"]
    assert any(n["name"] == "Kai" for n in names)
    assert any(n["name"] == "Alice" for n in names)

    # Rewrite a word that the fake-whisper transcript definitely contains.
    word = record["transcript"]["text"].split()[0]
    resp = client.post(f"/jobs/{job_id}/names", headers=AUTH,
                       json={"mapping": {word: "Kai"}})
    assert resp.status_code == 200 and resp.json()["replaced"] >= 1
    updated = client.get(f"/jobs/{job_id}", headers=AUTH).json()
    assert word not in updated["transcript"]["text"].split()

    # Bad mapping bodies are rejected.
    assert client.post(f"/jobs/{job_id}/names", headers=AUTH,
                       json={"mapping": {}}).status_code == 400

    # Start AI = the existing summarize endpoint; job gains AI output.
    assert client.post(f"/jobs/{job_id}/summarize", headers=AUTH).status_code == 200
    record = _wait_ready(client, job_id)
    assert record["summary"] is not None


def test_candidate_names_heuristic():
    from app.models import MeetingDetails, MeetingMeta
    from app.pipeline import names as names_mod

    meeting = MeetingMeta(details=MeetingDetails(
        title="t", date="2026-07-22", time="10:00", attendees=["Kai"]))
    text = ("Okay so Kai said the budget is fine. Then Kye disagreed with "
            "Kai. Later Bob asked about Monday. Bob said yes.")
    names = names_mod.candidate_names(text, meeting)
    by_name = {n["name"]: n for n in names}
    assert by_name["Kai"]["count"] == 2
    assert by_name["Kye"]["suggest"] == "Kai"   # sound-alike -> merge hint
    assert "Bob" in by_name                      # mid-sentence repeat
    assert "Monday" not in by_name               # stopword
    assert "Okay" not in by_name                 # stopword + sentence start
