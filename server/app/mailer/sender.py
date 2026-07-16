"""Send the laptop-rendered PDF to the recipient list via SMTP.

Gmail requires an App Password (https://myaccount.google.com/apppasswords)
over smtp.gmail.com:465 with SSL — a normal account password will be rejected.

SECURITY: never log SMTP_APP_PASSWORD.
"""

import asyncio
import json
import re
import smtplib
from email.message import EmailMessage  # stdlib email, not this package
from pathlib import Path

from ..config import Settings
from ..models import MeetingDetails, MeetingMeta

_SUBJECT_PREFIX = "Subject:"


def parse_template(text: str) -> tuple[str, str]:
    """Split a template file into (subject, body).

    Format (see config/email_template.example.txt): the first line must start
    with 'Subject: '; everything after the first blank line is the body.
    """
    lines = text.splitlines()
    if not lines or not lines[0].startswith(_SUBJECT_PREFIX):
        raise ValueError(
            "Email template must start with a 'Subject: ...' line "
            "(see config/email_template.example.txt)"
        )
    subject = lines[0][len(_SUBJECT_PREFIX):].strip()
    body_lines: list[str] = []
    seen_blank = False
    for line in lines[1:]:
        if seen_blank:
            body_lines.append(line)
        elif line.strip() == "":
            seen_blank = True
    if not seen_blank:
        # No blank separator — treat everything after the subject as the body.
        body_lines = lines[1:]
    return subject, "\n".join(body_lines)


def substitute(template: str, details: MeetingDetails) -> str:
    """Replace {{title}} {{date}} {{time}} {{attendees}} placeholders."""
    mapping = {
        "title": details.title,
        "date": details.date,
        "time": details.time,
        "attendees": ", ".join(details.attendees),
    }
    result = template
    for key, value in mapping.items():
        result = result.replace("{{" + key + "}}", value)
    return result


def resolve_recipients(meeting: MeetingMeta, settings: Settings) -> list[str]:
    """Meeting-supplied recipients win; otherwise fall back to the preset file."""
    if meeting.recipients:
        return list(meeting.recipients)
    path = settings.recipients_path
    if path.exists():
        try:
            preset = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"Recipients file {path} is not valid JSON: {exc}")
        if isinstance(preset, list) and preset:
            return [str(address) for address in preset]
    raise RuntimeError(
        "No email recipients: the meeting JSON has none and the preset list "
        f"at {path} is missing or empty. Copy config/recipients.example.json "
        "to config/recipients.json and add addresses."
    )


def _sanitize_filename_part(text: str) -> str:
    """Make a title safe for use inside an attachment filename."""
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", text).strip("_")
    return cleaned or "Meeting"


def build_message(
    settings: Settings, meeting: MeetingMeta, pdf_bytes: bytes
) -> EmailMessage:
    subject_tpl, body_tpl = parse_template(
        settings.email_template_path.read_text(encoding="utf-8")
    )
    details = meeting.details
    msg = EmailMessage()
    msg["From"] = settings.SMTP_FROM or settings.SMTP_USER
    msg["To"] = ", ".join(resolve_recipients(meeting, settings))
    msg["Subject"] = substitute(subject_tpl, details)
    msg.set_content(substitute(body_tpl, details))
    filename = (
        f"MeetingNotes-{details.date}-{_sanitize_filename_part(details.title)}.pdf"
    )
    msg.add_attachment(
        pdf_bytes, maintype="application", subtype="pdf", filename=filename
    )
    return msg


def send_sync(settings: Settings, meeting: MeetingMeta, pdf_path: Path) -> None:
    """Blocking send — run via asyncio.to_thread (see send())."""
    pdf_bytes = Path(pdf_path).read_bytes()
    msg = build_message(settings, meeting, pdf_bytes)
    # Attribute lookup at call time so tests can monkeypatch smtplib.SMTP_SSL.
    smtp_factory = smtplib.SMTP_SSL if settings.SMTP_USE_SSL else smtplib.SMTP
    with smtp_factory(settings.SMTP_HOST, settings.SMTP_PORT, timeout=60) as smtp:
        # login() only when a password is configured — the plain/no-auth path
        # exists so a local dev SMTP server (or a test fake) needs no secrets.
        if settings.SMTP_APP_PASSWORD:
            smtp.login(settings.SMTP_USER, settings.SMTP_APP_PASSWORD)
        smtp.send_message(msg)


async def send(settings: Settings, meeting: MeetingMeta, pdf_path: Path) -> None:
    """Async wrapper: smtplib is blocking, so run it on a thread."""
    await asyncio.to_thread(send_sync, settings, meeting, pdf_path)
