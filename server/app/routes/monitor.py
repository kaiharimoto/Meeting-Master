"""Monitoring endpoints: job list, live SSE event stream, and log tail.

The handler functions are written once and mounted TWICE:
  * bearer-gated at the API root (`/jobs`, `/events`, `/logs/tail`) for the
    laptop app over Tailscale;
  * loopback-only under `/setup` (`/setup/jobs`, `/setup/events`,
    `/setup/logs`) for the local dashboard — registered in setup/routes.py,
    which carries the require_loopback dependency, and deliberately NOT gated
    on is_configured so the dashboard works during first-run setup.

Job payloads are TRIMMED (id/state/progress/title/...) — never the transcript,
summary, or questions; those stay on the bearer-gated per-job endpoint.
"""

import asyncio
import json
import logging
import re
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import FileResponse, PlainTextResponse, StreamingResponse

from .. import updates
from ..auth import verify_token
from ..config import APP_VERSION, get_settings
from ..models import JobRecord
from .jobs import require_configured

log = logging.getLogger(__name__)

_PING_INTERVAL_SEC = 15.0


def trim_job(record: JobRecord) -> dict:
    """The list/event view of a job — small, and free of meeting content."""
    state = record.state.value if hasattr(record.state, "value") else str(record.state)
    return {
        "id": record.id,
        "state": state,
        "progress": record.progress,
        "createdAt": record.createdAt,
        "updatedAt": record.updatedAt,
        "title": record.meeting.details.title,
        "error": record.error,
        "summaryError": record.summaryError,
        "questionsError": record.questionsError,
        "pdf": {"received": record.pdf.received, "emailed": record.pdf.emailed},
    }


# ---- Shared handler bodies (used by both mounts) ----------------------------

def jobs_payload(request: Request, limit: int) -> dict:
    store = request.app.state.store
    limit = max(1, min(int(limit), 200))
    return {"jobs": [trim_job(r) for r in store.list()[:limit]]}


def logs_payload(request: Request, lines: int) -> dict:
    ring = getattr(request.app.state, "log_ring", None)
    lines = max(1, min(int(lines), 1000))
    return {"lines": ring.tail(lines) if ring is not None else []}


def _job_with_transcript(request: Request, job_id: str):
    record = request.app.state.store.get(job_id)
    if record is None:
        raise HTTPException(status_code=404, detail=f"Unknown job id: {job_id}")
    if record.transcript is None or not (record.transcript.text or "").strip():
        raise HTTPException(
            status_code=404,
            detail="This job has no transcript yet (it may still be transcribing, "
                   "or it failed before transcription finished).",
        )
    return record


def transcript_response(request: Request, job_id: str) -> PlainTextResponse:
    """The raw transcript as a downloadable .txt — the escape hatch for using
    an external model when local summarization can't handle the meeting."""
    record = _job_with_transcript(request, job_id)
    return PlainTextResponse(
        record.transcript.text,
        headers={
            "Content-Disposition": f'attachment; filename="meeting-transcript-{job_id}.txt"'
        },
    )


_DEFAULT_TEMPLATE = (
    "Subject: Meeting Notes — {{title}} ({{date}})\n\n"
    "Hello,\n\nAttached are the meeting notes for \"{{title}}\" held on "
    "{{date}} at {{time}}.\n\nAttendees: {{attendees}}\n\n"
    "— Sent automatically by Meeting Master."
)


def email_preview_response(request: Request, job_id: str) -> dict:
    """The exact Subject / recipient list / body the server would email —
    for manual sending when SMTP is broken (attach the PDF yourself)."""
    from ..mailer import sender

    record = request.app.state.store.get(job_id)
    if record is None:
        raise HTTPException(status_code=404, detail=f"Unknown job id: {job_id}")
    settings = get_settings()
    try:
        template_text = settings.email_template_path.read_text(encoding="utf-8")
    except OSError:
        template_text = _DEFAULT_TEMPLATE
    subject_tpl, body_tpl = sender.parse_template(template_text)
    details = record.meeting.details
    return {
        "subject": sender.substitute(subject_tpl, details),
        "recipients": sender.resolve_recipients(record.meeting, settings),
        "body": sender.substitute(body_tpl, details),
    }


def job_names_response(request: Request, job_id: str) -> dict:
    """Candidate person names in the job's transcript (plus attendees), for
    the fix-names review that runs BEFORE the AI stages read the text."""
    from ..pipeline import names as names_mod

    record = _job_with_transcript(request, job_id)
    return {"names": names_mod.candidate_names(record.transcript.text, record.meeting)}


async def apply_names_response(request: Request, job_id: str) -> dict:
    """Apply a {wrong: corrected} name mapping to the STORED transcript so
    every later consumer — the AI stages, transcript downloads, the external
    prompt — sees the corrected names."""
    from ..pipeline import names as names_mod

    record = _job_with_transcript(request, job_id)
    try:
        payload = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Body must be JSON: {\"mapping\": {...}}")
    mapping = payload.get("mapping") if isinstance(payload, dict) else None
    if not isinstance(mapping, dict) or not mapping:
        raise HTTPException(status_code=400, detail="Provide a non-empty {\"mapping\": {from: to}}")
    if len(mapping) > 100:
        raise HTTPException(status_code=400, detail="Mapping too large (max 100 names).")

    new_transcript, replaced = names_mod.apply_mapping(record.transcript, mapping)
    request.app.state.store.update(record, transcript=new_transcript)
    return {"ok": True, "replaced": replaced}


def summarize_retry_response(request: Request, job_id: str) -> dict:
    """Queue a summary+Q&A re-run on the stored transcript (the transcript
    itself is never redone). The job flips back to `summarizing` and lands in
    `ready` with fresh summary/questions — or fresh per-stage errors."""
    from .. import worker  # late import — worker pulls the pipeline stack

    record = _job_with_transcript(request, job_id)
    worker.enqueue(f"summarize:{record.id}")
    return {"ok": True, "id": record.id, "queued": True}


def prompt_response(request: Request, job_id: str) -> PlainTextResponse:
    """The full prompt harness (system prompt + task + this job's transcript),
    ready to paste into any external chatbot; its JSON reply round-trips back
    in through the app's summary editor Import button."""
    from ..pipeline import summarize  # late import — pipeline pulls httpx

    record = _job_with_transcript(request, job_id)
    return PlainTextResponse(
        summarize.external_prompt(record.transcript.text, record.meeting)
    )


def _sse(eid: int, event: str, data_json: str) -> str:
    return f"id: {eid}\nevent: {event}\ndata: {data_json}\n\n"


def _hello_payload(request: Request) -> str:
    store = request.app.state.store
    return json.dumps(
        {
            "serverTime": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "configured": get_settings().is_configured,
            "version": APP_VERSION,
            "jobs": [trim_job(r) for r in store.list()[:50]],
        },
        default=str,
    )


def event_stream(request: Request) -> StreamingResponse:
    """SSE: hello snapshot (or Last-Event-ID replay), then live events with a
    comment ping every 15s so proxies/timeouts keep the connection alive."""
    broker = request.app.state.broker

    async def gen():
        q = broker.subscribe()
        try:
            yield "retry: 3000\n\n"

            replay = None
            last = request.headers.get("last-event-id", "")
            if last.isdigit():
                replay = broker.replay_since(int(last))

            if replay is None:
                # Unknown/absent id: full snapshot removes the subscribe race.
                yield _sse(broker.last_id, "hello", _hello_payload(request))
            else:
                for eid, event, data_json in replay:
                    yield _sse(eid, event, data_json)

            while True:
                # Broker dropped us as a slow consumer: end the stream so the
                # client reconnects and receives a fresh snapshot (drain any
                # already-queued events first — they're still valid).
                if getattr(q, "_mm_dropped", False) and q.empty():
                    log.info("Closing SSE stream for a lagging subscriber")
                    return
                try:
                    eid, event, data_json = await asyncio.wait_for(
                        q.get(), timeout=_PING_INTERVAL_SEC
                    )
                except asyncio.TimeoutError:
                    yield ": ping\n\n"
                    continue
                yield _sse(eid, event, data_json)
        finally:
            broker.unsubscribe(q)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",  # defeat any buffering reverse proxy
        },
    )


# ---- Bearer-gated router (laptop, over Tailscale) ---------------------------

router = APIRouter(dependencies=[Depends(require_configured), Depends(verify_token)])


@router.get("/jobs")
async def list_jobs(request: Request, limit: int = Query(50)) -> dict:
    return jobs_payload(request, limit)


@router.get("/events")
async def events(request: Request) -> StreamingResponse:
    return event_stream(request)


@router.get("/logs/tail")
async def logs_tail(request: Request, lines: int = Query(200)) -> dict:
    return logs_payload(request, lines)


@router.get("/jobs/{job_id}/transcript")
async def job_transcript(request: Request, job_id: str) -> PlainTextResponse:
    return transcript_response(request, job_id)


@router.get("/jobs/{job_id}/prompt")
async def job_prompt(request: Request, job_id: str) -> PlainTextResponse:
    return prompt_response(request, job_id)


@router.post("/jobs/{job_id}/summarize")
async def job_summarize_retry(request: Request, job_id: str) -> dict:
    return summarize_retry_response(request, job_id)


@router.get("/jobs/{job_id}/email")
async def job_email_preview(request: Request, job_id: str) -> dict:
    return email_preview_response(request, job_id)


@router.get("/jobs/{job_id}/names")
async def job_names(request: Request, job_id: str) -> dict:
    return job_names_response(request, job_id)


@router.post("/jobs/{job_id}/names")
async def job_apply_names(request: Request, job_id: str) -> dict:
    return await apply_names_response(request, job_id)


# ---- Laptop auto-update feed ------------------------------------------------
# electron-updater (generic provider) on the laptop fetches latest.yml and the
# installer it names from here — files the server cached from GitHub. Strict
# name whitelist; served only when a cache exists.

_UPDATE_NAME_RE = re.compile(r"^(latest\.yml|MeetingMaster-Setup-[\w.\-]+\.exe(\.blockmap)?)$")


@router.get("/updates/laptop/{name}")
async def laptop_update_asset(name: str) -> FileResponse:
    if not _UPDATE_NAME_RE.match(name):
        raise HTTPException(status_code=404, detail=f"Unknown update asset: {name}")
    cache = updates.laptop_dir()
    if cache is None:
        raise HTTPException(
            status_code=404,
            detail="No update cache yet — the server hasn't fetched a release.",
        )
    path = cache / name
    if not path.is_file():
        raise HTTPException(status_code=404, detail=f"Asset not cached: {name}")
    media = "text/yaml" if name.endswith(".yml") else "application/octet-stream"
    return FileResponse(path, media_type=media)
