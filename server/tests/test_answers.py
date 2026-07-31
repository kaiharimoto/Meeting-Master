"""POST /jobs/{id}/answers — drafting answers for questions the operator
captured during the meeting but had no time to fill in.

The interesting part is the WINDOW: whisper.cpp gives per-segment timestamps,
so a question captured at 00:02:00 is answered from the conversation around
00:02:00 rather than from the whole transcript. These tests pin that, plus the
guards that keep one request from becoming an unbounded model workload.
"""

import io
import json
import time

from app.models import JobRecord, JobState, MeetingMeta, Transcript, TranscriptSegment
from app.routes.jobs import _window_for

AUTH = {"Authorization": "Bearer test-token"}

MEETING = {
    "schemaVersion": 1,
    "details": {
        "title": "Answer Drafting",
        "date": "2026-07-28",
        "time": "11:00",
        "attendees": ["Alice", "Bob"],
    },
    "cards": [],
    "recipients": [],
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


def _ready_job(client, timeout=30.0) -> str:
    """Upload and run a job all the way to a transcript."""
    job_id = _upload(client)
    deadline = time.time() + timeout
    while time.time() < deadline:
        record = client.get(f"/jobs/{job_id}", headers=AUTH).json()
        if record["state"] in ("ready", "failed"):
            assert record["state"] == "ready", record
            return job_id
        time.sleep(0.05)
    raise AssertionError("job never reached a terminal state")


def _segments():
    # A twelve-minute meeting, one segment per minute — long enough that a
    # window around one moment genuinely excludes the rest of it.
    lines = [
        "Welcome everyone, let us get started.",           # 0:00
        "First topic is the vendor contract renewal.",     # 1:00
        "What is the renewal price for the next term?",    # 2:00
        "A 12% increase locked for 24 months, says Bob.",  # 3:00
        "Any other pricing questions before we move on.",  # 4:00
        "Second topic, the data migration timeline.",      # 5:00
        "When does the migration have to be finished?",    # 6:00
        "The hard deadline is November 15th.",             # 7:00
        "We will keep a two-week buffer before cutover.",  # 8:00
        "Third topic, integration testing ownership.",     # 9:00
        "The platform team owns regression coverage.",     # 10:00
        "That is everything, thanks all.",                 # 11:00
    ]
    return [
        TranscriptSegment(start=i * 60.0, end=(i + 1) * 60.0, text=text)
        for i, text in enumerate(lines)
    ]


def _record(**overrides):
    data = {
        "id": "job-answers",
        "state": JobState.ready,
        "createdAt": "2026-07-28T00:00:00Z",
        "updatedAt": "2026-07-28T00:00:00Z",
        "meeting": MeetingMeta(**MEETING),
        "transcript": Transcript(
            text=" ".join(seg.text for seg in _segments()), segments=_segments()
        ),
    }
    data.update(overrides)
    return JobRecord(**data)


# ---- window slicing (pure, no HTTP) ----------------------------------------


def test_window_is_centred_on_the_capture_moment_and_biased_forward():
    # Captured at 2:00, as the question is being asked. The answer lands at
    # 3:00 and must be in the window; the 7:00 material must not be.
    window = _window_for(_record(), 120_000)
    assert "What is the renewal price" in window
    assert "12% increase" in window
    assert "November 15th" not in window


def test_the_window_reaches_back_far_enough_to_cover_the_typing_lag():
    # The operator finishes typing a few seconds AFTER the question was asked,
    # so the stamp trails it — the question itself still has to be in view.
    window = _window_for(_record(), 150_000)  # 2:30, half a minute late
    assert "What is the renewal price" in window


def test_a_question_without_a_timestamp_reads_the_whole_transcript():
    window = _window_for(_record(), None)
    assert "Welcome everyone" in window
    assert "November 15th" in window


def test_a_timestamp_beyond_the_recording_falls_back_to_everything():
    # Clock skew or a trimmed recording must not answer "nothing found".
    window = _window_for(_record(), 9_000_000)
    assert "Welcome everyone" in window


def test_no_transcript_yields_an_empty_window():
    assert _window_for(_record(transcript=None), 1000) == ""


# ---- the endpoint ----------------------------------------------------------


def test_requires_token(client):
    body = {"questions": [{"id": "c1", "question": "What is the renewal price?"}]}
    assert client.post("/jobs/x/answers", json=body).status_code == 401


def test_unknown_job_is_a_404(client):
    body = {"questions": [{"id": "c1", "question": "Anything?"}]}
    resp = client.post("/jobs/nope/answers", json=body, headers=AUTH)
    assert resp.status_code == 404


def test_no_questions_returns_an_empty_list_without_calling_the_model(client):
    job_id = _ready_job(client)
    resp = client.post(
        f"/jobs/{job_id}/answers", json={"questions": []}, headers=AUTH
    )
    assert resp.status_code == 200
    assert resp.json()["answers"] == []


def test_happy_path_drafts_an_answer_per_question(client):
    job_id = _ready_job(client)
    resp = client.post(
        f"/jobs/{job_id}/answers",
        json={
            "questions": [
                {"id": "c1", "question": "What is the renewal price?", "atMs": 60000},
                {"id": "c2", "question": "When does migration finish?", "atMs": 150000},
            ],
            "attendees": ["Alice", "Bob"],
        },
        headers=AUTH,
    )
    assert resp.status_code == 200
    answers = resp.json()["answers"]
    assert len(answers) == 2
    # Answers come back keyed by CARD id, so the laptop never has to re-match
    # on question text it may have edited since.
    assert [a["id"] for a in answers] == ["c1", "c2"]
    assert answers[0]["answer"] == "A 12% increase locked for 24 months."
    assert answers[0]["answerer"] == "Bob"
    assert answers[0]["confidence"] == "high"


def test_a_job_without_a_transcript_is_a_409(client):
    # Straight after upload the job is queued and has no transcript yet.
    job_id = _upload(client)
    resp = client.post(
        f"/jobs/{job_id}/answers",
        json={"questions": [{"id": "c1", "question": "Anything?"}]},
        headers=AUTH,
    )
    assert resp.status_code == 409
    assert "transcript" in resp.json()["detail"].lower()


def test_the_question_list_is_capped(client):
    # 40 in, 25 out — a buggy client cannot turn one request into 40 model calls.
    job_id = _ready_job(client)
    resp = client.post(
        f"/jobs/{job_id}/answers",
        json={
            "questions": [
                {"id": f"c{i}", "question": f"Question {i}?", "atMs": 1000}
                for i in range(40)
            ]
        },
        headers=AUTH,
    )
    assert resp.status_code == 200
    assert len(resp.json()["answers"]) == 25
