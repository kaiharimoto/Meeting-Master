"""Live (mid-meeting) endpoints.

The laptop's live-transcription loop drives all three of these while a meeting
is being recorded:

  GET  /live/config    how to run the loop (interval, window, timeout, whether
                       it is on at all) — so live suggestions are configured in
                       ONE place, this server's dashboard, and the laptop needs
                       no settings of its own.
  POST /live/warmup    load the live model into VRAM once, at session start, so
                       the first real tick doesn't pay for it.
  POST /live/questions the newest slice of the laptop's LOCAL draft transcript
                       in, candidate Q&A pairs + key insights out.

Stateless by design — no job, no store, nothing persisted. If these are
unreachable the laptop degrades quietly (it shows why in its side rail) and the
post-meeting extraction (routes/jobs.py pipeline) remains the quality backstop.

Three answers the laptop must be able to tell apart, hence three status codes:
``503`` the feature is switched off, ``409`` the GPU is busy with a pipeline job
(retry, don't back off), ``502`` the AI genuinely failed.
"""

import logging

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from ..auth import verify_token
from ..config import get_settings
from ..models import JobState, LiveSuggestions
from ..pipeline import extract
from .jobs import require_configured

log = logging.getLogger(__name__)

router = APIRouter(dependencies=[Depends(require_configured), Depends(verify_token)])

# The laptop sends its recent text; cap server-side anyway so a buggy or
# malicious client can't push an unbounded prompt into Ollama.
_MAX_WINDOW_CHARS = 12000
_MAX_LIST_ITEMS = 50

# Added to the server's own budget to give the laptop its HTTP timeout. The
# client must always be the MORE patient of the two: a client that gives up on
# a request the server is still working on records a failure, backs off, and
# eventually stops asking — which is precisely how live suggestions came to
# look permanently broken while the home server was answering fine.
_CLIENT_TIMEOUT_MARGIN_SEC = 20


def _require_enabled() -> None:
    if not get_settings().LIVE_SUGGESTIONS:
        raise HTTPException(
            status_code=503,
            detail=(
                "Live suggestions are turned off on the home server — enable "
                "them on the dashboard's Settings tab (AI models → Live "
                "suggestions)."
            ),
        )


# Stages that are already using the GPU this server shares with the live path.
# (normalizing is ffmpeg on the CPU and brief, so it doesn't count.)
_GPU_BUSY_STATES = frozenset({JobState.transcribing, JobState.summarizing})


def _require_gpu_free(request: Request) -> None:
    """Decline — politely and distinguishably — while a job holds the GPU.

    A live ask and a pipeline job are two different models wanting the same
    VRAM: mid-meeting asks landing on top of a post-meeting transcription (or a
    previous meeting's summary) make BOTH slow, and with a separate LIVE_MODEL
    they can thrash Ollama into unloading and reloading between every call.

    409, deliberately, and never 502: the laptop must show "busy, will retry"
    and NOT count this as a failure — a backoff here would punish the operator
    for the server doing exactly what it should be doing.
    """
    store = getattr(request.app.state, "store", None)
    if store is None:
        return
    for record in store.list():
        if record.state in _GPU_BUSY_STATES:
            raise HTTPException(
                status_code=409,
                detail=(
                    "The home server's GPU is busy processing another meeting "
                    f"({record.state.value}) — live suggestions resume when it "
                    "finishes."
                ),
            )


class LiveQuestionsRequest(BaseModel):
    transcriptWindow: str = Field(min_length=1)
    attendees: list[str] = []
    alreadyFlagged: list[str] = []
    # Insights the operator has already been offered this session (kept or
    # dismissed) — excluded so the rail never repeats itself.
    alreadyInsights: list[str] = []


@router.get("/live/config")
async def live_config() -> dict:
    """How the laptop should drive its live loop, and whether to run it at all.

    Fetched once per live session. Returning ``enabled: false`` is a normal
    answer, not an error: the laptop says so in its rail and skips the loop.
    """
    settings = get_settings()
    return {
        "enabled": settings.LIVE_SUGGESTIONS,
        "intervalSec": max(10, settings.LIVE_INTERVAL_SEC),
        "windowChars": max(500, min(_MAX_WINDOW_CHARS, settings.LIVE_WINDOW_CHARS)),
        "timeoutSec": max(10, settings.LIVE_TIMEOUT_SEC),
        # What the laptop should wait before giving up on one call — always
        # longer than the server's own budget (see the constant above).
        "clientTimeoutSec": max(10, settings.LIVE_TIMEOUT_SEC)
        + _CLIENT_TIMEOUT_MARGIN_SEC,
        "model": settings.live_model,
        "insights": True,
    }


@router.post("/live/warmup")
async def live_warmup(request: Request) -> dict:
    """Pin the live model in VRAM before the ticks start.

    Never raises: the laptop calls this at the start of a meeting and must not
    be disturbed by the result — the payload IS the diagnosis, and it is shown
    quietly in the side rail.
    """
    import time

    _require_enabled()
    _require_gpu_free(request)
    settings = get_settings()
    start = time.monotonic()
    error = None
    try:
        await extract.warm_live_model(settings)
    except Exception as exc:
        error = str(exc)
        log.warning("Live model warmup failed: %s", exc)
    return {
        "ok": error is None,
        "model": settings.live_model,
        "latencyMs": int((time.monotonic() - start) * 1000),
        "error": error,
    }


@router.post("/live/questions", response_model=LiveSuggestions)
async def live_questions(
    request: Request, body: LiveQuestionsRequest
) -> LiveSuggestions:
    _require_enabled()
    _require_gpu_free(request)
    window = body.transcriptWindow.strip()
    if not window:
        raise HTTPException(status_code=422, detail="transcriptWindow is empty.")
    window = window[-_MAX_WINDOW_CHARS:]

    attendees = [a.strip() for a in body.attendees[:_MAX_LIST_ITEMS] if a and a.strip()]
    flagged = [q.strip() for q in body.alreadyFlagged[:_MAX_LIST_ITEMS] if q and q.strip()]
    insights = [i.strip() for i in body.alreadyInsights[:_MAX_LIST_ITEMS] if i and i.strip()]

    settings = get_settings()
    try:
        return await extract.run_live(window, attendees, flagged, insights, settings)
    except Exception as exc:  # Ollama down/slow/garbled — the laptop says so
        log.warning("Live suggestions failed: %s", exc)
        raise HTTPException(
            status_code=502, detail=f"Live suggestions failed: {exc}"
        ) from exc
