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
    # Distinct from keyTakeaways on purpose: takeaways record the meeting,
    # insights are the lessons to apply next time (see MeetingSummary).
    "keyInsights": ["Start renewal talks a quarter earlier next time."],
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
# The mid-meeting live path asks for questions AND insights in one reply.
CANNED_LIVE_INSIGHTS = ["Chase the vendor before the deadline next time."]

CANNED_QUESTIONS = [
    {
        "question": "What is the renewal price?",
        "answer": "A 12% increase locked for 24 months.",
        "answerer": "Bob",
        "directedTo": "Bob",
        "confidence": "high",
    }
]

# The answer-drafting stage (POST /jobs/{id}/answers) asks for ONE answer to a
# question it already has, so it gets its own canned reply shape.
CANNED_ANSWER = {
    "answer": "A 12% increase locked for 24 months.",
    "answerer": "Bob",
    "confidence": "high",
}

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

# --- installed models the fake Ollama reports (GET /api/tags + POST /api/show) -
# Two deliberately different shapes so "Fit to your GPU" has something real to
# rank: one that fits a 24 GB card with room, one whose weights alone don't.
def _model_info(arch, layers, heads, kv_heads, embedding, ctx):
    return {
        "general.architecture": arch,
        f"{arch}.block_count": layers,
        f"{arch}.attention.head_count": heads,
        f"{arch}.attention.head_count_kv": kv_heads,
        f"{arch}.embedding_length": embedding,
        f"{arch}.context_length": ctx,
    }


FAKE_INSTALLED = {
    "fits-well:27b": {
        "size": 16_000_000_000,
        "details": {"parameter_size": "27B", "quantization_level": "Q4_K_M"},
        "model_info": _model_info("testfit", 46, 32, 8, 4096, 131072),
    },
    "too-big:70b": {
        "size": 40_000_000_000,
        "details": {"parameter_size": "70B", "quantization_level": "Q4_K_M"},
        "model_info": _model_info("testbig", 80, 64, 8, 8192, 32768),
    },
}

# What GET /api/ps reports as resident — deliberately a partial GPU load, the
# condition the dashboard has to name out loud ("the AI is slow" in disguise).
FAKE_LOADED = {
    "models": [
        {
            "name": "fits-well:27b",
            "size": 20_000_000_000,
            "size_vram": 15_000_000_000,
            "context_length": 32768,
        }
    ]
}


# --- fake Ollama: answers POST /api/chat, branching on which stage called ---
class _FakeOllamaHandler(BaseHTTPRequestHandler):
    def _json(self, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802 (BaseHTTPRequestHandler API)
        # There was no do_GET at all before, so /api/tags answered 501 and every
        # code path that reads the installed-model list was exercised only in
        # its "Ollama is down" branch.
        if self.path.startswith("/api/tags"):
            self._json({"models": [
                {"name": name, "size": spec["size"], "details": spec["details"]}
                for name, spec in FAKE_INSTALLED.items()
            ]})
            return
        if self.path.startswith("/api/ps"):
            self._json(FAKE_LOADED)
            return
        self.send_response(404)
        self.end_headers()

    def do_POST(self):  # noqa: N802 (BaseHTTPRequestHandler API)
        length = int(self.headers.get("Content-Length") or 0)
        request = self.rfile.read(length).decode("utf-8", "replace")
        if self.path.startswith("/api/show"):
            wanted = json.loads(request or "{}").get("model", "")
            spec = FAKE_INSTALLED.get(wanted)
            self._json(
                {"details": spec["details"], "model_info": spec["model_info"]}
                if spec
                else {}
            )
            return
        # The stages carry distinctive keywords in their prompts. Answer
        # drafting is checked FIRST: its schema also mentions "answerer", so
        # the broader extraction branch below would otherwise swallow it.
        if "written down by the note-taker" in request:
            content = json.dumps(CANNED_ANSWER)
        elif "health check" in request:
            # Warmup (POST /live/warmup) and the dashboard's "Test AI now".
            content = json.dumps({"ok": True})
        elif "STILL IN PROGRESS" in request:
            # Live suggestions: the same Q&A shape plus insights.
            content = json.dumps(
                {"questions": CANNED_QUESTIONS, "insights": CANNED_LIVE_INSIGHTS}
            )
        elif "answerer" in request:
            content = json.dumps({"questions": CANNED_QUESTIONS})
        elif "keyTakeaways" in request:
            content = json.dumps(CANNED_SUMMARY_SECTIONS)
        else:
            content = CANNED_SUMMARY
        self._json({"message": {"role": "assistant", "content": content}})

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
    with TestClient(app, base_url="http://127.0.0.1:8080") as test_client:
        yield test_client
