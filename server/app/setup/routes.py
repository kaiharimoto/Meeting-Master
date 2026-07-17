"""First-run setup API — mounted at ``/setup``.

EVERY route here is loopback-only (a 403 for any non-localhost client) and
UNAUTHENTICATED: setup configures the bearer token, so it cannot require one,
and it must never be reachable over Tailscale. The loopback guard is the only
thing standing between "unconfigured server" and "anyone on the tailnet".

The connection code the laptop pastes is:  base64url (no padding) of the UTF-8
JSON ``{"url": <serverUrl>, "token": <BEARER_TOKEN>}`` — see
app/src/main/config.js:applyConnectionCode on the laptop side.

SECURITY: the token is only ever returned from these loopback-only routes.
Nothing here logs BEARER_TOKEN or SMTP_APP_PASSWORD.
"""

import base64
import json
import logging
import secrets
import socket
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel

from .. import config
from . import bootstrap

log = logging.getLogger(__name__)

_STATIC_DIR = Path(__file__).resolve().parent / "static"
_LOOPBACK_HOSTS = {"127.0.0.1", "::1", "localhost"}

DEFAULT_EMAIL_TEMPLATE = (
    "Subject: Meeting Notes — {{title}} ({{date}})\n"
    "\n"
    "Hello,\n"
    "\n"
    'Attached are the meeting notes for "{{title}}" held on {{date}} at {{time}}.\n'
    "\n"
    "Attendees: {{attendees}}\n"
    "\n"
    "— Sent automatically by Meeting Master.\n"
)


def require_loopback(request: Request) -> None:
    """403 unless the request originates from localhost."""
    client = getattr(request, "client", None)
    host = getattr(client, "host", None)
    if host not in _LOOPBACK_HOSTS:
        raise HTTPException(
            status_code=403,
            detail="Setup is only available on the home PC (http://127.0.0.1).",
        )


router = APIRouter(
    prefix="/setup", tags=["setup"], dependencies=[Depends(require_loopback)]
)


# --- Connection code helpers -----------------------------------------------
def encode_connection_code(server_url: str, token: str) -> str:
    """base64url (no padding) of ``{"url": ..., "token": ...}`` — the laptop
    contract in app/src/main/config.js."""
    payload = json.dumps(
        {"url": server_url, "token": token}, separators=(",", ":")
    ).encode("utf-8")
    return base64.urlsafe_b64encode(payload).rstrip(b"=").decode("ascii")


def server_url(settings) -> str:
    """The URL the laptop should reach this server at: the Tailscale serve URL
    if we have one, else ``http://<hostname>:<port>``."""
    serve = bootstrap.get_serve_url()
    if serve:
        return serve.rstrip("/")
    host = socket.gethostname() or "localhost"
    return f"http://{host}:{settings.SERVER_PORT}"


def connection_code(settings) -> str | None:
    token = settings.BEARER_TOKEN
    if not token:
        return None
    return encode_connection_code(server_url(settings), token)


# --- State ------------------------------------------------------------------
def _read_recipients(settings) -> list[str]:
    path = settings.recipients_path
    if path.exists():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(data, list):
                return [str(x) for x in data]
        except (json.JSONDecodeError, OSError):
            log.warning("Recipients file %s is unreadable", path)
    return []


def _read_template(settings) -> str:
    path = settings.email_template_path
    if path.exists():
        try:
            return path.read_text(encoding="utf-8")
        except OSError:
            log.warning("Email template %s is unreadable", path)
    return DEFAULT_EMAIL_TEMPLATE


async def build_state() -> dict:
    settings = config.get_settings()
    recipients = _read_recipients(settings)
    return {
        "configured": settings.is_configured,
        "connectionCode": connection_code(settings),
        "serverUrl": server_url(settings),
        # Loopback-only route — safe to surface the token so the UI can show it.
        "token": settings.BEARER_TOKEN or None,
        "email": {
            "user": settings.SMTP_USER,
            "from": settings.SMTP_FROM,
            "recipientsCount": len(recipients),
            "hasPassword": bool(settings.SMTP_APP_PASSWORD),
        },
        # Additive, loopback-only conveniences so the UI can re-populate itself.
        "recipients": recipients,
        "emailTemplate": _read_template(settings),
        "ollamaModel": settings.OLLAMA_MODEL,
        "whisperModel": settings.WHISPER_MODEL_DEFAULT,
        "deps": await bootstrap.detect(),
        "tasks": bootstrap.all_task_states(),
    }


class SaveBody(BaseModel):
    token: str | None = None
    smtpUser: str = ""
    smtpAppPassword: str = ""
    smtpFrom: str = ""
    recipients: list[str] = []
    emailTemplate: str = ""
    ollamaModel: str | None = None
    whisperModel: str | None = None


# --- Routes -----------------------------------------------------------------
@router.get("")
async def setup_page() -> FileResponse:
    return FileResponse(_STATIC_DIR / "setup.html")


@router.get("/state")
async def get_state() -> dict:
    return await build_state()


@router.post("/save")
async def save(body: SaveBody) -> dict:
    settings = config.get_settings()

    token = (body.token or "").strip() or secrets.token_urlsafe(32)

    # Recipients JSON array + email template file live in the config home.
    recipients = [r.strip() for r in body.recipients if r.strip()]
    settings.recipients_path.parent.mkdir(parents=True, exist_ok=True)
    settings.recipients_path.write_text(
        json.dumps(recipients, indent=2), encoding="utf-8"
    )
    template = body.emailTemplate.strip() or DEFAULT_EMAIL_TEMPLATE.strip()
    settings.email_template_path.parent.mkdir(parents=True, exist_ok=True)
    settings.email_template_path.write_text(template + "\n", encoding="utf-8")

    values: dict = {
        "BEARER_TOKEN": token,
        "SMTP_USER": body.smtpUser.strip(),
        "SMTP_FROM": (body.smtpFrom.strip() or body.smtpUser.strip()),
    }
    # Don't clobber a previously-saved app password with a blank field.
    password = body.smtpAppPassword.strip() or settings.SMTP_APP_PASSWORD
    if password:
        values["SMTP_APP_PASSWORD"] = password
    if body.ollamaModel and body.ollamaModel.strip():
        values["OLLAMA_MODEL"] = body.ollamaModel.strip()
    if body.whisperModel and body.whisperModel.strip():
        values["WHISPER_MODEL_DEFAULT"] = body.whisperModel.strip()

    config.write_env(values)
    log.info("Setup saved (server is now configured=%s)", config.get_settings().is_configured)
    return await build_state()


@router.post("/install/{component}")
async def install(component: str) -> dict:
    if component not in bootstrap._COMPONENTS:
        raise HTTPException(status_code=404, detail=f"Unknown component: {component}")
    started, task = bootstrap.start(component)
    return {"started": started, "task": task}


@router.get("/connection-code")
async def get_connection_code() -> dict:
    settings = config.get_settings()
    return {
        "connectionCode": connection_code(settings),
        "serverUrl": server_url(settings),
    }
