"""Remote settings administration — the home server's dashboard, over Tailscale.

WHY THIS EXISTS. Every setting on this server was reachable from exactly one
place: the dashboard at http://127.0.0.1:8080/setup, which is loopback-only by
design because it hands out BEARER_TOKEN. That is the right guard for a page
that shows a credential, but it meant a wrong setting could only be fixed while
sitting at the home PC. The failure that prompted this was a live-suggestions
loop failing every 45 seconds in a meeting, with the fix one field away on a
machine thirty miles off, and no way to reach it.

So: the same dashboard, at a second mount, with a different guard.

  /setup/*   loopback-only, UNAUTHENTICATED, returns the token.  Unchanged.
  /admin/*   bearer-gated, reachable over the tailnet, token REDACTED.

The route NAMES mirror /setup exactly. That is what lets one dashboard.js serve
both mounts off a single `window.MM_API_BASE` prefix instead of a fork, and it
means "is this route mirrored?" is answerable by reading two lists side by side.

Every handler here is a one-line delegation to the body in setup/routes.py —
the idiom routes/monitor.py already uses for its two mounts, and for the same
reason: two copies of the clamps and the validation would drift, and the copy
nobody re-reads would be the remote one. If you find yourself writing logic in
this file, put it in setup/routes.py and call it from both.

WHAT NEVER CROSSES THIS SURFACE.
  * BEARER_TOKEN, in either direction. Redacted from reads (along with the
    connection code, which is the same secret base64'd), and a write naming it
    is refused rather than ignored — a caller who believes they rotated a token
    and did not is worse off than one who got an error. Rotation stays a
    loopback operation, which is right: it is the one change that can lock
    every device out of the server, this route included.
  * SMTP_APP_PASSWORD and GITHUB_TOKEN are write-only. They were already
    reported as hasPassword/githubTokenSet booleans rather than values, and a
    blank field still means "keep what is saved".
  * /connection-code is DELIBERATELY not mirrored. It returns the token.
"""

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse

from ..auth import verify_token
from ..setup import routes as setup_routes
from . import monitor
from .jobs import require_configured

MOUNT = "/admin"

router = APIRouter(
    prefix=MOUNT,
    tags=["admin"],
    dependencies=[Depends(require_configured), Depends(verify_token)],
)


# --- The page itself ---------------------------------------------------------
@router.get("")
async def admin_page() -> HTMLResponse:
    return setup_routes.render_page(MOUNT)


@router.get("/assets/{name}")
async def admin_asset(name: str) -> FileResponse:
    return await setup_routes.setup_asset(name)


# --- Settings ----------------------------------------------------------------
@router.get("/state")
async def admin_state() -> dict:
    return await setup_routes.build_state(redact=True)


@router.post("/save")
async def admin_save(body: setup_routes.SaveBody) -> dict:
    # Refuse loudly rather than dropping the field. See the module docstring.
    if (body.token or "").strip():
        raise HTTPException(
            status_code=400,
            detail=(
                "The bearer token cannot be changed remotely — a new token would "
                "lock this connection out mid-request. Change it on the home PC's "
                "setup page, then re-pair the laptop with the new connection code."
            ),
        )
    return await setup_routes.apply_save(body, allow_token=False, redact=True)


# --- Diagnostics -------------------------------------------------------------
@router.post("/ai-test")
async def admin_ai_test(body: setup_routes.AiTestBody) -> dict:
    """Live-fire the AFTER-THE-MEETING provider (summary + Q&A extraction)."""
    return await setup_routes.setup_ai_test(body)


@router.post("/live-test")
async def admin_live_test(body: setup_routes.LiveTestBody) -> dict:
    """Live-fire the MID-MEETING path over a fixed excerpt.

    The one that matters remotely. It runs the real run_live() call, so it
    exercises what the summary test structurally cannot — which is exactly the
    gap that let a broken live path ship while "Test AI now" reported success.
    """
    return await setup_routes.setup_live_test(body)


@router.get("/ollama-models")
async def admin_ollama_models() -> dict:
    return await setup_routes.setup_ollama_models()


@router.get("/model-fit")
async def admin_model_fit(vramGB: float = 24.0, kvCache: str = "f16") -> dict:
    return await setup_routes.setup_model_fit(vramGB=vramGB, kvCache=kvCache)


@router.post("/install/{component}")
async def admin_install(component: str) -> dict:
    """Start a guided install (Ollama, Tailscale, a model) on the home PC.

    Mirrored for parity with the dashboard, and worth being explicit about:
    this is the one route where the bearer token reaches something that runs a
    program on the home PC. Not an escalation — the same token already uploads
    audio and reads every transcript — but the first route to drop if that
    trade ever stops looking worthwhile.
    """
    return await setup_routes.install(component)


# --- Monitoring mirrors ------------------------------------------------------
# Same bodies as /setup's loopback mirrors and the bearer-gated API root. The
# dashboard polls these, so the remote mount needs them under its own prefix.
@router.get("/jobs")
async def admin_jobs(request: Request, limit: int = 50) -> dict:
    return monitor.jobs_payload(request, limit)


@router.get("/events")
async def admin_events(request: Request):
    return monitor.event_stream(request)


@router.get("/logs")
async def admin_logs(request: Request, lines: int = 200) -> dict:
    return monitor.logs_payload(request, lines)


@router.get("/jobs/{job_id}/transcript")
async def admin_job_transcript(request: Request, job_id: str):
    return monitor.transcript_response(request, job_id)


@router.get("/jobs/{job_id}/prompt")
async def admin_job_prompt(request: Request, job_id: str):
    return monitor.prompt_response(request, job_id)


@router.post("/jobs/{job_id}/summarize")
async def admin_job_summarize(request: Request, job_id: str):
    return monitor.summarize_retry_response(request, job_id)


@router.get("/jobs/{job_id}/email")
async def admin_job_email(request: Request, job_id: str):
    return monitor.email_preview_response(request, job_id)
