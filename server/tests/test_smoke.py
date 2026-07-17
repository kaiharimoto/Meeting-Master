"""End-to-end smoke tests: auth, full pipeline with stub tools, PDF + email."""

import io
import json
import smtplib
import time

import pytest

from tests.conftest import CANNED_SUMMARY

AUTH = {"Authorization": "Bearer test-token"}

VALID_MEETING = {
    "schemaVersion": 1,
    "details": {
        "title": "Test Sync",
        "date": "2026-07-16",
        "time": "10:00",
        "attendees": ["Alice", "Bob"],
    },
    "cards": [
        {"id": "c1", "question": "Q?", "answer": "A.", "participant": "Alice"}
    ],
    "recipients": ["dest@example.com"],
    "options": {"whisperModel": "large-v3-turbo", "emailMode": "home"},
}


def _upload(client) -> str:
    response = client.post(
        "/jobs",
        headers=AUTH,
        data={"meeting": json.dumps(VALID_MEETING)},
        files={"file": ("audio.wav", io.BytesIO(b"RIFF" + b"\x00" * 256), "audio/wav")},
    )
    assert response.status_code == 202, response.text
    return response.json()["id"]


def _wait_ready(client, job_id: str, timeout: float = 30.0) -> dict:
    deadline = time.time() + timeout
    record: dict = {}
    while time.time() < deadline:
        response = client.get(f"/jobs/{job_id}", headers=AUTH)
        assert response.status_code == 200, response.text
        record = response.json()
        if record["state"] == "ready":
            return record
        if record["state"] == "failed":
            pytest.fail(f"Job failed:\n{json.dumps(record, indent=2)}")
        time.sleep(0.1)
    pytest.fail(f"Timed out waiting for ready:\n{json.dumps(record, indent=2)}")


def test_auth_required(client):
    # /health is deliberately open... (tests configure a token, so configured).
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "configured": True}
    # ...but /jobs endpoints reject missing and wrong tokens alike.
    assert client.get("/jobs/anything").status_code == 401
    assert (
        client.get(
            "/jobs/anything", headers={"Authorization": "Bearer wrong-token"}
        ).status_code
        == 401
    )


def test_full_pipeline(client):
    job_id = _upload(client)
    record = _wait_ready(client, job_id)

    assert "stub transcript" in record["transcript"]["text"]
    assert record["summary"] == CANNED_SUMMARY

    first_segment = record["transcript"]["segments"][0]
    assert first_segment["start"] == 0.0
    assert first_segment["end"] == 4.2

    # Unknown ids 404 (with auth).
    assert client.get("/jobs/no-such-job", headers=AUTH).status_code == 404


def test_pdf_upload_and_email(client, monkeypatch):
    sent_messages = []

    class FakeSMTPSSL:
        def __init__(self, host, port, timeout=None):
            self.host, self.port = host, port
            self.login_args = None

        def __enter__(self):
            return self

        def __exit__(self, *exc_info):
            return False

        def login(self, user, password):
            self.login_args = (user, password)

        def send_message(self, msg):
            sent_messages.append(msg)

    monkeypatch.setattr(smtplib, "SMTP_SSL", FakeSMTPSSL)

    job_id = _upload(client)
    _wait_ready(client, job_id)

    response = client.post(
        f"/jobs/{job_id}/pdf",
        headers=AUTH,
        files={"file": ("notes.pdf", io.BytesIO(b"%PDF-1.4 fake"), "application/pdf")},
    )
    assert response.status_code == 200, response.text
    assert response.json() == {"ok": True, "emailed": True, "error": None}

    assert len(sent_messages) == 1
    message = sent_messages[0]
    assert message["To"] == "dest@example.com"  # meeting recipients win
    assert "Test Sync" in message["Subject"]

    record = client.get(f"/jobs/{job_id}", headers=AUTH).json()
    assert record["state"] == "emailed"
    assert record["pdf"] == {"received": True, "emailed": True}


def test_pdf_rejected_before_ready(client, monkeypatch):
    # Make the stub ffmpeg sleep so the fresh job is deterministically still
    # queued/normalizing when we try to post the PDF.
    monkeypatch.setenv("FAKE_FFMPEG_SLEEP", "5")
    job_id = _upload(client)

    response = client.post(
        f"/jobs/{job_id}/pdf",
        headers=AUTH,
        files={"file": ("notes.pdf", io.BytesIO(b"%PDF-1.4"), "application/pdf")},
    )
    assert response.status_code == 409, response.text
    assert "not ready" in response.json()["detail"]
