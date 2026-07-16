"""Unit tests for template parsing, substitution, recipients, and SMTP send."""

import json
import smtplib

import pytest

from app.config import Settings
from app.mailer import sender
from app.models import MeetingMeta

TEMPLATE_TEXT = (
    "Subject: Notes — {{title}} ({{date}})\n"
    "\n"
    "Hello,\n"
    "\n"
    'Meeting "{{title}}" on {{date}} at {{time}}.\n'
    "Attendees: {{attendees}}\n"
)


def _meeting(recipients=None) -> MeetingMeta:
    return MeetingMeta.model_validate(
        {
            "schemaVersion": 1,
            "details": {
                "title": "Budget Review",
                "date": "2026-07-16",
                "time": "09:00",
                "attendees": ["Alice", "Bob"],
            },
            "cards": [],
            "recipients": recipients or [],
            "options": {},
        }
    )


def _settings(tmp_path, **overrides) -> Settings:
    """Settings with tmp template/recipients files; kwargs override env."""
    template_file = tmp_path / "template.txt"
    template_file.write_text(TEMPLATE_TEXT, encoding="utf-8")
    recipients_file = tmp_path / "recipients.json"
    recipients_file.write_text(
        json.dumps(["preset-a@example.com", "preset-b@example.com"]),
        encoding="utf-8",
    )
    values = {
        "EMAIL_TEMPLATE_PATH": str(template_file),
        "RECIPIENTS_PATH": str(recipients_file),
        "SMTP_USER": "me@example.com",
        "SMTP_FROM": "me@example.com",
        "SMTP_APP_PASSWORD": "app-pass",
        "SMTP_USE_SSL": True,
    }
    values.update(overrides)
    # Required fields (BEARER_TOKEN etc.) come from the env set in conftest.
    return Settings(**values)


class FakeSMTP:
    """Records logins and sent messages; works for both SSL and plain paths."""

    instances: list = []

    def __init__(self, host, port, timeout=None):
        self.host, self.port, self.timeout = host, port, timeout
        self.login_args = None
        self.sent: list = []
        FakeSMTP.instances.append(self)

    def __enter__(self):
        return self

    def __exit__(self, *exc_info):
        return False

    def login(self, user, password):
        self.login_args = (user, password)

    def send_message(self, msg):
        self.sent.append(msg)


@pytest.fixture(autouse=True)
def _reset_fake_smtp():
    FakeSMTP.instances = []
    yield


# --- template parsing ---

def test_parse_template_splits_subject_and_body():
    subject, body = sender.parse_template(TEMPLATE_TEXT)
    assert subject == "Notes — {{title}} ({{date}})"
    assert body.startswith("Hello,")
    assert "Attendees: {{attendees}}" in body


def test_parse_template_rejects_missing_subject_line():
    with pytest.raises(ValueError, match="Subject"):
        sender.parse_template("Hello,\n\nno subject here\n")


def test_substitute_fills_all_placeholders():
    meeting = _meeting()
    rendered = sender.substitute(
        "{{title}} | {{date}} | {{time}} | {{attendees}}", meeting.details
    )
    assert rendered == "Budget Review | 2026-07-16 | 09:00 | Alice, Bob"


# --- recipient resolution ---

def test_meeting_recipients_win(tmp_path):
    settings = _settings(tmp_path)
    meeting = _meeting(recipients=["direct@example.com"])
    assert sender.resolve_recipients(meeting, settings) == ["direct@example.com"]


def test_empty_meeting_recipients_fall_back_to_preset_file(tmp_path):
    settings = _settings(tmp_path)
    assert sender.resolve_recipients(_meeting(), settings) == [
        "preset-a@example.com",
        "preset-b@example.com",
    ]


def test_both_recipient_sources_empty_raises_clear_error(tmp_path):
    settings = _settings(tmp_path)
    settings.recipients_path.write_text("[]", encoding="utf-8")
    with pytest.raises(RuntimeError, match="[Nn]o email recipients"):
        sender.resolve_recipients(_meeting(), settings)


def test_missing_recipients_file_raises_clear_error(tmp_path):
    settings = _settings(tmp_path, RECIPIENTS_PATH=str(tmp_path / "nope.json"))
    with pytest.raises(RuntimeError, match="[Nn]o email recipients"):
        sender.resolve_recipients(_meeting(), settings)


# --- message building + sending ---

def test_send_sync_builds_and_sends_message(tmp_path, monkeypatch):
    monkeypatch.setattr(smtplib, "SMTP_SSL", FakeSMTP)
    settings = _settings(tmp_path)
    pdf_path = tmp_path / "notes.pdf"
    pdf_path.write_bytes(b"%PDF-1.4 fake pdf body")

    sender.send_sync(settings, _meeting(), pdf_path)

    assert len(FakeSMTP.instances) == 1
    smtp = FakeSMTP.instances[0]
    assert (smtp.host, smtp.port) == ("smtp.gmail.com", 465)
    assert smtp.login_args == ("me@example.com", "app-pass")
    assert len(smtp.sent) == 1

    msg = smtp.sent[0]
    assert msg["From"] == "me@example.com"
    assert msg["To"] == "preset-a@example.com, preset-b@example.com"
    assert msg["Subject"] == "Notes — Budget Review (2026-07-16)"
    assert "Alice, Bob" in msg.get_body(("plain",)).get_content()

    attachments = list(msg.iter_attachments())
    assert len(attachments) == 1
    attachment = attachments[0]
    assert attachment.get_content_type() == "application/pdf"
    assert attachment.get_filename() == "MeetingNotes-2026-07-16-Budget_Review.pdf"
    assert attachment.get_content() == b"%PDF-1.4 fake pdf body"


def test_send_sync_skips_login_without_password(tmp_path, monkeypatch):
    # Plain/no-auth path: a local dev SMTP server needs no credentials.
    monkeypatch.setattr(smtplib, "SMTP", FakeSMTP)
    settings = _settings(
        tmp_path, SMTP_USE_SSL=False, SMTP_APP_PASSWORD="", SMTP_PORT=1025
    )
    pdf_path = tmp_path / "notes.pdf"
    pdf_path.write_bytes(b"%PDF-1.4")

    sender.send_sync(settings, _meeting(), pdf_path)

    smtp = FakeSMTP.instances[0]
    assert smtp.login_args is None
    assert len(smtp.sent) == 1
