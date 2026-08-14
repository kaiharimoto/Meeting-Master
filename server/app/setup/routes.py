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
import sys
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse
from pydantic import BaseModel

from .. import config
from . import bootstrap

log = logging.getLogger(__name__)


def _resolve_static_dir() -> Path:
    """Locate the setup page's static files, frozen or from source.

    Normally the files sit beside this module; in a PyInstaller bundle the
    onedir layout usually keeps that working, but fall back to the _MEIPASS
    root just in case the data files are laid out there instead.
    """
    here = Path(__file__).resolve().parent / "static"
    if here.exists():
        return here
    base = getattr(sys, "_MEIPASS", None)
    if base:
        candidate = Path(base) / "app" / "setup" / "static"
        if candidate.exists():
            return candidate
    return here  # best effort — FileResponse will 404 clearly if truly absent


_STATIC_DIR = _resolve_static_dir()
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


# Headers that only a reverse proxy adds. Their PRESENCE is the tell: the
# browser on the home PC talks to uvicorn directly and sends none of them.
_PROXY_HEADERS = ("x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "forwarded")


def require_loopback(request: Request) -> None:
    """403 unless the request really originates from this machine.

    The peer address alone is not enough, and the reason is worth knowing.
    ``tailscale serve`` proxies tailnet traffic from 127.0.0.1, so a remote
    request arrives with a LOOPBACK peer. What saves us today is a chain of
    third-party defaults: Tailscale sets X-Forwarded-For, and uvicorn's
    ProxyHeadersMiddleware (proxy_headers=True, forwarded_allow_ips=127.0.0.1
    by default) rewrites the client to the tailnet address before we see it.

    That chain is invisible from here and would break silently. Note especially
    that turning proxy_headers OFF — the instinctive "we're not behind a proxy"
    hardening — is what would OPEN this hole, because the peer would go back to
    reading 127.0.0.1. See desktop.py, where those options are now explicit.

    So check two things the peer address cannot tell us, neither of which the
    genuine local browser can trip:
      * any proxy header at all — a direct client sends none;
      * the Host header — ``tailscale serve`` passes the request's own Host
        through, so a tailnet request says <machine>.<tailnet>.ts.net.
    Remote settings management does not need this door: it has /admin/*, which
    is bearer-gated and never returns the token.
    """
    client = getattr(request, "client", None)
    host = getattr(client, "host", None)
    # getattr, like `client` above: this is called with hand-built request
    # doubles in tests, and a missing header map must not become a 500.
    headers = getattr(request, "headers", {}) or {}
    proxied = any(name in headers for name in _PROXY_HEADERS)
    # Strip the port, and the brackets an IPv6 literal arrives wrapped in.
    hostname = (headers.get("host") or "").rsplit(":", 1)[0].strip("[]").lower()
    # No Host header at all (HTTP/1.0, some test clients) leaves only the peer
    # check — don't fail closed on its absence, just don't credit it either.
    host_ok = hostname in _LOOPBACK_HOSTS or not hostname
    if host not in _LOOPBACK_HOSTS or proxied or not host_ok:
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


async def build_state(*, redact: bool = False) -> dict:
    """The whole settings picture the dashboard renders.

    ``redact=True`` strips the two fields that ARE credentials — the bearer
    token and the connection code that carries it — so the same payload can be
    served to an authenticated remote client (routes/admin.py). Everything else
    here is configuration, not secrets: passwords and tokens were already
    reported as ``hasPassword`` / ``githubTokenSet`` booleans rather than values.

    Redaction lives here, in the one function that assembles the payload, so a
    field added later is not silently exposed by a second copy that never
    learned about it.
    """
    settings = config.get_settings()
    recipients = _read_recipients(settings)
    return {
        "configured": settings.is_configured,
        "connectionCode": None if redact else connection_code(settings),
        "serverUrl": server_url(settings),
        # The token itself: fine on the loopback-only route (the UI shows it),
        # never over the network — see the redact note above.
        "token": None if redact else (settings.BEARER_TOKEN or None),
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
        # Hands-on AI engine tuning (v0.4.3): shown on the Settings tab.
        "aiParams": {
            "aiProvider": settings.AI_PROVIDER,
            "claudeCliPath": settings.CLAUDE_CLI_PATH,
            "claudeModel": settings.CLAUDE_MODEL,
            "claudeCliTimeoutSec": settings.CLAUDE_CLI_TIMEOUT_SEC,
            # Whether the CLI can actually be found right now — the difference
            # between "not installed" and "installed but not signed in", which
            # the operator otherwise only discovers when a meeting fails.
            "claudeCliFound": _claude_cli_found(settings),
            "ollamaUrl": settings.OLLAMA_URL,
            "numCtx": settings.NUM_CTX,
            "summaryNumPredict": settings.SUMMARY_NUM_PREDICT,
            "summaryTemperature": settings.SUMMARY_TEMPERATURE,
            "extractNumPredict": settings.EXTRACT_NUM_PREDICT,
            "extractTemperature": settings.EXTRACT_TEMPERATURE,
        },
        # Mid-meeting live suggestions. Configured here and ONLY here — the
        # laptop reads these off GET /live/config at the start of a meeting.
        "liveParams": {
            "liveSuggestions": settings.LIVE_SUGGESTIONS,
            "liveModel": settings.LIVE_MODEL,
            "liveModelEffective": settings.live_model,
            "liveIntervalSec": settings.LIVE_INTERVAL_SEC,
            "liveWindowChars": settings.LIVE_WINDOW_CHARS,
            "liveTimeoutSec": settings.LIVE_TIMEOUT_SEC,
            "liveKeepAliveMin": settings.LIVE_KEEP_ALIVE_MIN,
            "liveExtractNumPredict": settings.LIVE_EXTRACT_NUM_PREDICT,
        },
        "deps": await bootstrap.detect(),
        "tasks": bootstrap.all_task_states(),
        "updates": _updates_snapshot(),
        "githubTokenSet": bool(settings.GITHUB_TOKEN),
    }


def _claude_cli_found(settings) -> bool:
    """Is the Claude CLI resolvable? Best effort — never let a probe break the
    settings page."""
    try:
        from ..pipeline import _claude_cli

        return _claude_cli.resolve_cli(settings) is not None
    except Exception:
        return False


def _updates_snapshot() -> dict:
    from .. import updates  # local import — updates imports bootstrap from this package

    return updates.snapshot()


class SaveBody(BaseModel):
    token: str | None = None
    smtpUser: str = ""
    smtpAppPassword: str = ""
    smtpFrom: str = ""
    recipients: list[str] = []
    emailTemplate: str = ""
    ollamaModel: str | None = None
    whisperModel: str | None = None
    githubToken: str = ""
    # Which backend writes the notes — "ollama" or "claude_cli".
    aiProvider: str | None = None
    claudeCliPath: str | None = None
    claudeModel: str | None = None
    claudeCliTimeoutSec: int | None = None
    # AI engine tuning — None means "leave as saved".
    ollamaUrl: str | None = None
    numCtx: int | None = None
    summaryNumPredict: int | None = None
    summaryTemperature: float | None = None
    extractNumPredict: int | None = None
    extractTemperature: float | None = None
    # Mid-meeting live suggestions — None means "leave as saved".
    liveSuggestions: bool | None = None
    # "" is a MEANINGFUL value here (fall back to the summary model), so this
    # one is distinguished from "not sent" by None, not by emptiness.
    liveModel: str | None = None
    liveIntervalSec: int | None = None
    liveWindowChars: int | None = None
    liveTimeoutSec: int | None = None
    liveKeepAliveMin: int | None = None
    liveExtractNumPredict: int | None = None


# --- Routes -----------------------------------------------------------------

# Dashboards must never run stale JS against a newer backend: a cached
# pre-update dashboard.js once resurrected a long-hidden install button
# (field report, v0.3.0). no-cache forces revalidation on every load — the
# files are tiny and loopback-local, so this costs nothing.
_NO_CACHE = {"Cache-Control": "no-cache"}


def render_page(mount: str = "/setup") -> HTMLResponse:
    """The dashboard HTML, pointed at whichever mount is serving it.

    One page, two mounts (see routes/admin.py). dashboard.js reads
    window.MM_API_BASE and makes every request relative to it, so the only
    difference between the local and remote dashboards is the string injected
    here — not a second copy of a 900-line file.
    """
    # Version-stamp the asset URLs so no cache layer (browser OR the app
    # window's Chromium) can ever pair an old dashboard.js with a new backend.
    html = (_STATIC_DIR / "setup.html").read_text(encoding="utf-8")
    for asset in ("dashboard.css", "dashboard.js"):
        html = html.replace(
            f"/setup/assets/{asset}", f"{mount}/assets/{asset}?v={config.APP_VERSION}"
        )
    if mount != "/setup":
        # Before dashboard.js loads, so its `var API` sees it.
        html = html.replace(
            "<script", f'<script>window.MM_API_BASE={json.dumps(mount)}</script><script', 1
        )
    return HTMLResponse(html, headers=_NO_CACHE)


@router.get("")
async def setup_page() -> HTMLResponse:
    return render_page("/setup")


# Dashboard buttons whose ACTION lives in the Electron app (opening the notes
# window, installing an app update). Inside the app window, Electron
# intercepts the navigation before it ever reaches us; a plain browser lands
# here and gets told where the real control is.
_ACTION_EXPLANATIONS = {
    "open-notes": "Meeting notes opens as a window of the Meeting Master app",
    "app-update": "Updates are installed by the Meeting Master app",
}


@router.get("/action/{name}")
async def setup_action(name: str) -> HTMLResponse:
    what = _ACTION_EXPLANATIONS.get(name)
    if what is None:
        raise HTTPException(status_code=404, detail=f"Unknown action: {name}")
    return HTMLResponse(
        "<!doctype html><meta charset='utf-8'><title>Meeting Master</title>"
        "<body style='font-family:system-ui;max-width:34rem;margin:4rem auto;line-height:1.6'>"
        f"<h2>Open this from the Meeting Master app</h2><p>{what} — this browser "
        "tab can't do it. On the home PC, use the Meeting Master window (this "
        "same dashboard inside the app) or the tray icon by the clock.</p>"
        "<p><a href='/setup'>Back to the dashboard</a></p></body>",
        headers=_NO_CACHE,
    )


# Dashboard assets, served by explicit whitelist — deliberately NOT a
# StaticFiles mount (mounts would bypass this router's loopback dependency).
_ASSET_WHITELIST = {
    "dashboard.css": "text/css",
    "dashboard.js": "text/javascript",
}


@router.get("/assets/{name}")
async def setup_asset(name: str) -> FileResponse:
    media_type = _ASSET_WHITELIST.get(name)
    path = _STATIC_DIR / name
    # A whitelisted-but-missing file means a broken frozen bundle — a clear
    # 404 beats FileResponse's 500-with-traceback when diagnosing that.
    if media_type is None or not path.is_file():
        raise HTTPException(status_code=404, detail=f"Unknown asset: {name}")
    return FileResponse(path, media_type=media_type, headers=_NO_CACHE)


@router.get("/state")
async def get_state() -> dict:
    return await build_state()


@router.post("/save")
async def save(body: SaveBody) -> dict:
    return await apply_save(body)


async def apply_save(body: SaveBody, *, allow_token: bool = True, redact: bool = False) -> dict:
    """Validate and persist a settings save. Shared by /setup/save and the
    bearer-gated /admin/config (routes/admin.py).

    ONE copy of the clamps, the don't-clobber-a-blank-secret rules and
    _reject_impossible_context, because two would drift and the remote one
    would be the copy nobody re-reads.

    ``allow_token=False`` makes the request unable to touch BEARER_TOKEN: a
    remote client changing the shared secret would 401 itself mid-request and
    leave the only fix on a machine it cannot reach.
    """
    settings = config.get_settings()

    # Preserve the existing token on re-saves: the dashboard's Settings tab is
    # revisited routinely (model changes, recipients), and rotating the token
    # on every save would silently 401 the already-connected laptop. A new
    # token is minted only on true first-run (no token supplied AND none saved).
    supplied = (body.token or "").strip() if allow_token else ""
    token = supplied or settings.BEARER_TOKEN or secrets.token_urlsafe(32)

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
    # Same pattern for the GitHub token (auto-updates on a private repo).
    github_token = body.githubToken.strip() or settings.GITHUB_TOKEN
    if github_token:
        values["GITHUB_TOKEN"] = github_token
    if body.ollamaModel and body.ollamaModel.strip():
        values["OLLAMA_MODEL"] = body.ollamaModel.strip()
    if body.whisperModel and body.whisperModel.strip():
        values["WHISPER_MODEL_DEFAULT"] = body.whisperModel.strip()

    # AI engine tuning — clamped to sane ranges so a typo can't wedge the
    # pipeline (e.g. a 0-token context). None/blank leaves the saved value.
    def _clamp(value, lo, hi):
        return max(lo, min(hi, value))

    # Which backend writes the notes. An unrecognized name is stored as
    # "ollama" rather than rejected: the local model is the safe landing spot,
    # and _provider treats anything else that way too.
    if body.aiProvider is not None:
        wanted = body.aiProvider.strip().lower()
        values["AI_PROVIDER"] = "claude_cli" if wanted == "claude_cli" else "ollama"
    if body.claudeCliPath is not None:
        values["CLAUDE_CLI_PATH"] = body.claudeCliPath.strip()
    if body.claudeModel is not None:
        values["CLAUDE_MODEL"] = body.claudeModel.strip()
    if body.claudeCliTimeoutSec is not None:
        values["CLAUDE_CLI_TIMEOUT_SEC"] = _clamp(int(body.claudeCliTimeoutSec), 60, 3600)

    if body.ollamaUrl and body.ollamaUrl.strip():
        values["OLLAMA_URL"] = body.ollamaUrl.strip().rstrip("/")
    if body.numCtx is not None:
        values["NUM_CTX"] = _clamp(int(body.numCtx), 2048, 131072)
    if body.summaryNumPredict is not None:
        values["SUMMARY_NUM_PREDICT"] = _clamp(int(body.summaryNumPredict), 128, 8192)
    if body.summaryTemperature is not None:
        values["SUMMARY_TEMPERATURE"] = _clamp(float(body.summaryTemperature), 0.0, 2.0)
    if body.extractNumPredict is not None:
        values["EXTRACT_NUM_PREDICT"] = _clamp(int(body.extractNumPredict), 128, 8192)
    if body.extractTemperature is not None:
        values["EXTRACT_TEMPERATURE"] = _clamp(float(body.extractTemperature), 0.0, 2.0)

    # Live suggestions. The clamps matter more here than elsewhere: these run
    # while a meeting is in progress, so a too-short interval or too-tight
    # timeout produces a loop that fails every tick instead of a slow one.
    if body.liveSuggestions is not None:
        values["LIVE_SUGGESTIONS"] = "true" if body.liveSuggestions else "false"
    if body.liveModel is not None:
        values["LIVE_MODEL"] = body.liveModel.strip()
    if body.liveIntervalSec is not None:
        values["LIVE_INTERVAL_SEC"] = _clamp(int(body.liveIntervalSec), 15, 600)
    if body.liveWindowChars is not None:
        values["LIVE_WINDOW_CHARS"] = _clamp(int(body.liveWindowChars), 500, 12000)
    if body.liveTimeoutSec is not None:
        values["LIVE_TIMEOUT_SEC"] = _clamp(int(body.liveTimeoutSec), 15, 600)
    if body.liveKeepAliveMin is not None:
        values["LIVE_KEEP_ALIVE_MIN"] = _clamp(int(body.liveKeepAliveMin), 0, 1440)
    if body.liveExtractNumPredict is not None:
        values["LIVE_EXTRACT_NUM_PREDICT"] = _clamp(
            int(body.liveExtractNumPredict), 128, 4096
        )

    # A context window has to leave room for the OUTPUT it reserves plus the
    # prompt, or there is nothing left for the transcript. Clamping each number
    # into its own range (above) can't catch that — the relationship between
    # them is what breaks, and it breaks into a job that never finishes rather
    # than one that fails. Reject it here, naming the fix.
    _reject_impossible_context(values, settings)

    config.write_env(values)
    log.info("Setup saved (server is now configured=%s)", config.get_settings().is_configured)
    return await build_state(redact=redact)


def _reject_impossible_context(values: dict, saved) -> None:
    """422 when NUM_CTX can't hold its own reserved output plus a transcript."""
    from ..pipeline import _ollama

    num_ctx = int(values.get("NUM_CTX", saved.NUM_CTX))
    stages = (
        ("summary", int(values.get("SUMMARY_NUM_PREDICT", saved.SUMMARY_NUM_PREDICT))),
        ("Q&A extraction", int(values.get("EXTRACT_NUM_PREDICT", saved.EXTRACT_NUM_PREDICT))),
        # The live stage shares NUM_CTX and was missing from this check. It is
        # the one where an unusable setting is discovered at the worst possible
        # moment — the operator is in the meeting when the ticks start failing.
        (
            "live suggestions",
            int(values.get("LIVE_EXTRACT_NUM_PREDICT", saved.LIVE_EXTRACT_NUM_PREDICT)),
        ),
    )
    for stage, num_predict in stages:
        needed = (
            num_predict
            + _ollama.PROMPT_OVERHEAD_TOKENS
            + _ollama.MIN_INPUT_BUDGET_TOKENS
        )
        if num_ctx < needed:
            raise HTTPException(
                status_code=422,
                detail=(
                    f"A context window of {num_ctx} tokens is too small for the "
                    f"{stage} stage, which reserves {num_predict} tokens for its "
                    f"answer. Use at least {needed}, or lower that stage's max "
                    f"output tokens. ('Fit to your GPU' below suggests a context "
                    f"window that works on your card.)"
                ),
            )


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


# --- Monitoring mirrors (loopback-only, for the local dashboard) -------------
# Same handler bodies as the bearer-gated /jobs, /events, /logs/tail — mounted
# here so the dashboard works from the home PC's browser without a token, and
# BEFORE first-run setup completes (require_loopback comes from this router).
@router.get("/jobs")
async def setup_jobs(request: Request, limit: int = 50) -> dict:
    from ..routes import monitor

    return monitor.jobs_payload(request, limit)


@router.get("/events")
async def setup_events(request: Request):
    from ..routes import monitor

    return monitor.event_stream(request)


@router.get("/logs")
async def setup_logs(request: Request, lines: int = 200) -> dict:
    from ..routes import monitor

    return monitor.logs_payload(request, lines)


@router.get("/jobs/{job_id}/transcript")
async def setup_job_transcript(request: Request, job_id: str):
    from ..routes import monitor

    return monitor.transcript_response(request, job_id)


@router.get("/jobs/{job_id}/prompt")
async def setup_job_prompt(request: Request, job_id: str):
    from ..routes import monitor

    return monitor.prompt_response(request, job_id)


@router.post("/jobs/{job_id}/summarize")
async def setup_job_summarize(request: Request, job_id: str):
    from ..routes import monitor

    return monitor.summarize_retry_response(request, job_id)


@router.get("/jobs/{job_id}/email")
async def setup_job_email(request: Request, job_id: str):
    from ..routes import monitor

    return monitor.email_preview_response(request, job_id)


@router.get("/jobs/{job_id}/names")
async def setup_job_names(request: Request, job_id: str):
    from ..routes import monitor

    return monitor.job_names_response(request, job_id)


@router.post("/jobs/{job_id}/names")
async def setup_job_apply_names(request: Request, job_id: str):
    from ..routes import monitor

    return await monitor.apply_names_response(request, job_id)


@router.get("/ollama-models")
async def setup_ollama_models() -> dict:
    """Installed Ollama models (proxied /api/tags) — feeds the model picker
    and the parameter-suggestion helper. Empty list when Ollama is down."""
    import httpx

    settings = config.get_settings()
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(5.0, connect=2.0)) as client:
            resp = await client.get(f"{settings.OLLAMA_URL}/api/tags")
            resp.raise_for_status()
            data = resp.json()
    except Exception:
        return {"models": []}
    models = []
    for m in data.get("models") or []:
        details = m.get("details") or {}
        models.append({
            "name": m.get("name") or "",
            "sizeGB": round((m.get("size") or 0) / 1e9, 1),
            "paramSize": details.get("parameter_size") or "",
            "quant": details.get("quantization_level") or "",
        })
    return {"models": [m for m in models if m["name"]]}


@router.get("/model-fit")
async def setup_model_fit(vramGB: float = 24.0, kvCache: str = "f16") -> dict:
    """Which installed models fit this GPU, and at what context window.

    Answers the question the dashboard could not answer before: not "is there an
    update" or "does the model load", but "what should I actually run on this
    card, and how much context can I afford". Computed from each model's real
    layer/head metadata (/api/show) plus what Ollama has resident now (/api/ps),
    so it stays correct for models this code has never heard of.

    Never raises: Ollama being down is a normal answer here (empty list), not an
    error page in the middle of the Settings tab.
    """
    import asyncio

    import httpx

    from . import modelfit

    settings = config.get_settings()
    vram_bytes = int(max(2.0, min(256.0, vramGB)) * modelfit.GB)
    cache_type = kvCache if kvCache in modelfit.KV_CACHE_BYTES else "f16"
    base = settings.OLLAMA_URL.rstrip("/")
    result: dict = {
        "vramGB": round(vram_bytes / modelfit.GB, 1),
        "kvCache": cache_type,
        "models": [],
        "loaded": [],
        "currentModel": settings.OLLAMA_MODEL,
        "liveModel": settings.live_model,
        "numCtx": settings.NUM_CTX,
        "minUsableCtx": modelfit.MIN_USABLE_CTX,
        "error": None,
    }

    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(20.0, connect=3.0)) as client:
            tags = (await client.get(f"{base}/api/tags")).json()
            installed = [m for m in (tags.get("models") or []) if m.get("name")]

            # /api/show per model, concurrently — a dozen installed models
            # would otherwise make the Settings tab wait a second per model.
            async def describe(entry: dict) -> dict:
                try:
                    resp = await client.post(f"{base}/api/show", json={"model": entry["name"]})
                    resp.raise_for_status()
                    return resp.json()
                except Exception:
                    return {}

            shown = await asyncio.gather(*(describe(m) for m in installed))
            for entry, info in zip(installed, shown):
                details = {**(entry.get("details") or {}), **(info.get("details") or {})}
                result["models"].append(
                    modelfit.plan_model(
                        name=entry["name"],
                        weights_bytes=int(entry.get("size") or 0),
                        model_info=info.get("model_info") or {},
                        vram_bytes=vram_bytes,
                        cache_type=cache_type,
                        quantization=str(details.get("quantization_level") or ""),
                        param_size=str(details.get("parameter_size") or ""),
                    )
                )
            result["models"] = modelfit.rank(result["models"])

            try:
                ps = (await client.get(f"{base}/api/ps")).json()
                result["loaded"] = modelfit.loaded_summary(ps)
            except Exception:
                result["loaded"] = []  # older Ollama without /api/ps
    except Exception as exc:
        result["error"] = f"Could not reach Ollama at {base}: {exc}"

    return result


class LiveTestBody(BaseModel):
    """Overrides for a live-suggestions test run, so the operator can prove a
    setting works BEFORE saving it. None => use what is saved."""

    liveModel: str | None = None
    liveTimeoutSec: int | None = None
    liveExtractNumPredict: int | None = None


# A short scripted excerpt with exactly one answered question and one genuine
# forward-looking lesson in it. Fixed text so the test measures the MODEL, not
# the meeting — and so a plausible-looking empty result is a real failure.
_LIVE_TEST_WINDOW = (
    "Priya: Before we go on — what did the renewal quote come back at? "
    "Marcus: Twelve percent up, locked for twenty-four months. "
    "Priya: Twelve? We only found that out this morning. "
    "Marcus: Yes, the vendor sat on it for three weeks and we did not chase "
    "them, so we are agreeing to it with two days left before the deadline. "
    "Priya: Right. We cannot be in this position again next year."
)


@router.post("/live-test")
async def setup_live_test(body: LiveTestBody) -> dict:
    """Run the REAL mid-meeting live path over a fixed scripted excerpt.

    The one honest answer to "live suggestions don't work": it uses the same
    prompt, model, timeout and parsing a real meeting does, and reports what
    came back — how long it took, how many questions and insights, and the
    exact error if any. Never raises; the result IS the diagnosis.
    """
    import time

    from ..pipeline import extract

    settings = config.get_settings()
    overrides: dict = {}
    if body.liveModel is not None:
        overrides["LIVE_MODEL"] = body.liveModel.strip()
    if body.liveTimeoutSec:
        overrides["LIVE_TIMEOUT_SEC"] = max(15, min(600, int(body.liveTimeoutSec)))
    if body.liveExtractNumPredict:
        overrides["LIVE_EXTRACT_NUM_PREDICT"] = max(
            128, min(4096, int(body.liveExtractNumPredict))
        )
    if overrides:
        settings = settings.model_copy(update=overrides)

    start = time.monotonic()
    result = None
    error = None
    try:
        result = await extract.run_live(
            _LIVE_TEST_WINDOW, ["Priya", "Marcus"], [], [], settings
        )
    except Exception as exc:
        error = str(exc)
        log.warning("Live suggestions test failed: %s", exc)
    latency_ms = int((time.monotonic() - start) * 1000)
    return {
        "ok": error is None,
        "enabled": settings.LIVE_SUGGESTIONS,
        "model": settings.live_model,
        "latencyMs": latency_ms,
        "intervalSec": settings.LIVE_INTERVAL_SEC,
        # A run that is slower than the interval means every tick lands on top
        # of the previous one — worth saying out loud, not just timing.
        "slowerThanInterval": latency_ms > settings.LIVE_INTERVAL_SEC * 1000,
        "questions": [q.model_dump() for q in (result.questions if result else [])],
        "insights": list(result.insights) if result else [],
        "error": error,
    }


class AiTestBody(BaseModel):
    numCtx: int | None = None
    # Test the provider currently selected in the form, not the saved one.
    aiProvider: str | None = None


@router.post("/ai-test")
async def setup_ai_test(body: AiTestBody) -> dict:
    """Live-fire the configured model with the (possibly still-unsaved)
    context window: a tiny real chat that proves the model + NUM_CTX actually
    load on this hardware. Never raises — the result IS the diagnosis."""
    import time

    import httpx

    from ..pipeline import _provider

    settings = config.get_settings()
    if body.numCtx:
        settings = settings.model_copy(
            update={"NUM_CTX": max(2048, min(131072, int(body.numCtx)))}
        )
    if body.aiProvider:
        # Test what the operator has just selected, not what is still saved —
        # otherwise switching provider and pressing Test reports on the old one.
        settings = settings.model_copy(update={"AI_PROVIDER": body.aiProvider})
    claude = _provider.uses_claude_cli(settings)
    start = time.monotonic()
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(180.0, connect=5.0)) as client:
            await _provider.chat_json(
                client, settings,
                'You are a health check. Respond with ONLY the JSON {"ok": true}.',
                "Reply now.",
                num_predict=20, temperature=0.0,
            )
        error = None
    except Exception as exc:
        error = str(exc)
    return {
        "ok": error is None,
        "latencyMs": int((time.monotonic() - start) * 1000),
        "provider": _provider.provider_name(settings),
        # NUM_CTX is an Ollama knob; reporting it for the CLI would imply this
        # test proved something about a setting it never touched.
        "model": (settings.CLAUDE_MODEL or "default") if claude else settings.OLLAMA_MODEL,
        "numCtx": None if claude else settings.NUM_CTX,
        "error": error,
    }
