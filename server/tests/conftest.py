"""Test environment bootstrap.

Everything here that touches os.environ runs at *module import time* — before
pytest imports any test module (and therefore before anything imports the
app), so app.config.Settings picks up the test values. The fake Ollama HTTP
server also binds its port at import time so OLLAMA_URL is known up front;
its serving thread is started/stopped by a session fixture.
"""

import json
import os
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

CANNED_SUMMARY = "A concise test summary of the meeting."

# The fake Ollama returns these structured payloads for the JSON-mode calls the
# summarize/extract stages make (branched on a marker in the request body).
CANNED_SUMMARY_SECTIONS = {
    "keyTakeaways": ["A key decision was reached.", "Budget was approved."],
    "decisions": ["Approved the vendor renewal at 12%."],
    "actionItems": [
        {
            "task": "Send the redlined contract.",
            "owner": "Alice",
            "due": "Nov 15",
            "priority": "high",
        }
    ],
    "keyFigures": ["12% price increase, locked 24 months"],
    "topics": ["Pricing", "Timeline"],
}
CANNED_QUESTIONS = [
    {
        "question": "What is the renewal price?",
        "answer": "A 12% increase locked for 24 months.",
        "answerer": "Bob",
        "directedTo": "Bob",
        "confidence": "high",
    }
]

_TESTS_DIR = Path(__file__).resolve().parent
_STUBS_DIR = _TESTS_DIR / "stubs"
_TMP = Path(tempfile.mkdtemp(prefix="meeting-master-tests-"))

# --- preset recipients + email template files (for the email leg) ---
_RECIPIENTS_FILE = _TMP / "recipients.json"
_RECIPIENTS_FILE.write_text(
    json.dumps(["preset-a@example.com", "preset-b@example.com"]), encoding="utf-8"
)

_TEMPLATE_FILE = _TMP / "email_template.txt"
_TEMPLATE_FILE.write_text(
    "Subject: Meeting Notes — {{title}} ({{date}})\n"
    "\n"
    "Hello,\n"
    "\n"
    'Attached are the meeting notes for "{{title}}" held on {{date}} at {{time}}.\n'
    "\n"
    "Attendees: {{attendees}}\n",
    encoding="utf-8",
)

(_TMP / "models").mkdir()  # WHISPER_MODEL_DIR — intentionally has no .bin files


# --- fake Ollama: answers POST /api/chat, branching on which stage called ---
class _FakeOllamaHandler(BaseHTTPRequestHandler):
    def do_POST(self):  # noqa: N802 (BaseHTTPRequestHandler API)
        length = int(self.headers.get("Content-Length") or 0)
        request = self.rfile.read(length).decode("utf-8", "replace")
        # The stages carry distinctive schema keywords in their prompts:
        # extraction asks for "answerer"; summarization asks for "keyTakeaways".
        if "answerer" in request:
            content = json.dumps({"questions": CANNED_QUESTIONS})
        elif "keyTakeaways" in request:
            content = json.dumps(CANNED_SUMMARY_SECTIONS)
        else:
            content = CANNED_SUMMARY
        body = json.dumps(
            {"message": {"role": "assistant", "content": content}}
        ).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):  # keep pytest output clean
        pass


# Port 0 -> the OS picks a free port; created at import so the env var below
# can point at it before the app is ever imported.
_OLLAMA_SERVER = ThreadingHTTPServer(("127.0.0.1", 0), _FakeOllamaHandler)
_OLLAMA_PORT = _OLLAMA_SERVER.server_address[1]


# --- environment: MUST be set before the app (app.config) is imported ---
os.environ.update(
    {
        "BEARER_TOKEN": "test-token",
        "DATA_DIR": str(_TMP / "data"),
        "FFMPEG_PATH": str(_STUBS_DIR / "fake_ffmpeg.py"),
        "WHISPER_CLI": str(_STUBS_DIR / "fake_whisper.py"),
        "WHISPER_MODEL_DIR": str(_TMP / "models"),
        "OLLAMA_URL": f"http://127.0.0.1:{_OLLAMA_PORT}",
        "RECIPIENTS_PATH": str(_RECIPIENTS_FILE),
        "EMAIL_TEMPLATE_PATH": str(_TEMPLATE_FILE),
        "SMTP_USER": "sender@example.com",
        "SMTP_FROM": "sender@example.com",
        "SMTP_APP_PASSWORD": "fake-app-password",
    }
)


@pytest.fixture(scope="session", autouse=True)
def fake_ollama():
    thread = threading.Thread(target=_OLLAMA_SERVER.serve_forever, daemon=True)
    thread.start()
    yield
    _OLLAMA_SERVER.shutdown()
    thread.join(timeout=5)


@pytest.fixture()
def client():
    # Clear the settings cache so the env above applies even if some earlier
    # import already materialized a Settings instance.
    from app.config import get_settings

    get_settings.cache_clear()

    from fastapi.testclient import TestClient

    from app.main import app

    # `with` runs the lifespan: data dir mkdir, load_all, worker task.
    with TestClient(app) as test_client:
        yield test_client
