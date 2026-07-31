"""Job endpoints: upload audio+meeting, poll status, post back the PDF, and
draft answers for questions the operator captured but left blank."""

import json
import logging
import shutil
from pathlib import Path

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    Request,
    UploadFile,
)
from pydantic import BaseModel, Field, ValidationError
from starlette.concurrency import run_in_threadpool

from .. import worker
from ..auth import verify_token
from ..config import get_settings
from ..mailer import sender
from ..models import (
    READY_STATES,
    AnsweredQuestion,
    JobRecord,
    JobState,
    MeetingMeta,
)
from ..pipeline import extract
from ..store import JobStore

log = logging.getLogger(__name__)


def require_configured() -> None:
    """Friendly 503 while the home server is still in first-run setup mode.

    Ordered BEFORE verify_token so an unconfigured server answers with a helpful
    'open the setup page' message instead of a bare 401 (there is no token to
    check yet). Once configured, this is a no-op and the token check applies.
    """
    settings = get_settings()
    if not settings.is_configured:
        raise HTTPException(
            status_code=503,
            detail=(
                "Home server is not set up yet — open "
                f"http://127.0.0.1:{settings.SERVER_PORT}/setup on the home PC."
            ),
        )


# Every route in this router requires setup to be complete, then the token.
router = APIRouter(dependencies=[Depends(require_configured), Depends(verify_token)])

_COPY_CHUNK = 1024 * 1024  # 1 MiB


def _store(request: Request) -> JobStore:
    return request.app.state.store


async def _stream_upload_to(upload: UploadFile, dest: Path) -> None:
    """Copy an uploaded file to disk in 1 MiB chunks.

    The upload can be ~600 MB, so it must NEVER be read into memory in one
    piece. Starlette has already spooled the multipart part to a temp file;
    copyfileobj streams it chunk-by-chunk, and runs in the threadpool because
    it is blocking I/O.
    """
    with dest.open("wb") as out_fh:
        await run_in_threadpool(shutil.copyfileobj, upload.file, out_fh, _COPY_CHUNK)


@router.post("/jobs", status_code=202)
async def create_job(
    request: Request,
    meeting: str = Form(...),
    file: UploadFile = File(...),
) -> dict:
    try:
        meeting_obj = MeetingMeta.model_validate(json.loads(meeting))
    except json.JSONDecodeError as exc:
        raise HTTPException(
            status_code=400, detail=f"'meeting' form field is not valid JSON: {exc}"
        )
    except ValidationError as exc:
        raise HTTPException(
            status_code=400, detail=f"'meeting' JSON has an invalid shape: {exc}"
        )

    store = _store(request)
    record = store.create(meeting_obj)
    try:
        await _stream_upload_to(file, store.job_dir(record.id) / "raw.wav")
    except Exception as exc:
        # A disconnect mid-upload must not leave a forever-'queued' job behind.
        store.update(
            record,
            state=JobState.failed,
            error=f"Audio upload failed or was interrupted: {exc}",
        )
        log.exception("Job %s: audio upload failed", record.id)
        raise HTTPException(
            status_code=500, detail="Audio upload failed — please retry."
        )
    # Enqueue for the background worker — never transcribe inside the request.
    worker.enqueue(record.id)
    log.info("Job %s queued (%s)", record.id, meeting_obj.details.title)
    return {"id": record.id}


@router.get("/jobs/{job_id}", response_model=JobRecord)
async def get_job(request: Request, job_id: str) -> JobRecord:
    record = _store(request).get(job_id)
    if record is None:
        raise HTTPException(status_code=404, detail=f"Unknown job id: {job_id}")
    return record


@router.post("/jobs/{job_id}/pdf")
async def receive_pdf(
    request: Request,
    job_id: str,
    file: UploadFile = File(...),
) -> dict:
    store = _store(request)
    record = store.get(job_id)
    if record is None:
        raise HTTPException(status_code=404, detail=f"Unknown job id: {job_id}")
    if record.state not in READY_STATES:
        raise HTTPException(
            status_code=409,
            detail="Job is not ready yet — transcript/summary still processing",
        )

    pdf_path = store.job_dir(job_id) / "result.pdf"
    await _stream_upload_to(file, pdf_path)
    record.pdf.received = True
    store.update(record, state=JobState.pdf_received)

    try:
        await sender.send(get_settings(), record.meeting, pdf_path)
    except Exception as exc:
        # HTTP 200, not 5xx: the PDF WAS stored (pdf_received), only the email
        # leg failed. The laptop shows the error and the user can retry the
        # send without re-uploading anything.
        log.exception("Job %s: PDF stored but emailing failed", job_id)
        return {"ok": False, "emailed": False, "error": str(exc)}

    record.pdf.emailed = True
    store.update(record, state=JobState.emailed)
    log.info("Job %s emailed", job_id)
    return {"ok": True, "emailed": True, "error": None}


# ---- Answer drafting ---------------------------------------------------------
#
# A note-taker types the question the moment it is asked and the answer arrives
# a minute or three later, by which time they are writing down the next
# question. This endpoint closes that gap: give it the questions that came out
# of the meeting with no answer, plus WHEN each was captured, and it reads the
# transcript around that moment and drafts the answer.
#
# Suggestions only, like every other AI output here — the laptop shows them for
# approval and nothing reaches a card until the operator says so.

# How much transcript to read around a captured question. Biased forward,
# heavily: the operator writes the question down as it is being asked, and the
# answer follows. The backward slack covers the seconds they spent typing.
_WINDOW_BEFORE_S = 45.0
_WINDOW_AFTER_S = 210.0

# Guards against a buggy client turning one request into an unbounded Ollama
# workload. A real meeting does not leave 25 questions unanswered.
_MAX_ANSWER_ITEMS = 25
_MAX_WINDOW_CHARS = 9000
_MAX_QUESTION_CHARS = 500


class BlankQuestion(BaseModel):
    """One captured question with no answer, and when it was captured."""

    id: str = Field(min_length=1, max_length=200)
    question: str = Field(min_length=1)
    # Milliseconds into the recording, from the laptop's capture clock. None
    # for questions typed outside a recording — those search the whole
    # transcript instead of a window.
    atMs: float | None = None


class DraftAnswersRequest(BaseModel):
    questions: list[BlankQuestion]
    attendees: list[str] = []


class DraftAnswersResponse(BaseModel):
    answers: list[AnsweredQuestion]


def _window_for(record: JobRecord, at_ms: float | None) -> str:
    """The transcript around ``at_ms``, or the whole thing when it is unknown.

    whisper.cpp gives per-segment start/end times (pipeline/transcribe.py), so
    this is a real slice of the conversation rather than a guess proportional
    to character count.
    """
    transcript = record.transcript
    if transcript is None:
        return ""
    segments = transcript.segments or []
    if at_ms is None or not segments:
        return (transcript.text or "")[:_MAX_WINDOW_CHARS]

    at_s = at_ms / 1000.0
    lo = at_s - _WINDOW_BEFORE_S
    hi = at_s + _WINDOW_AFTER_S
    picked = [s.text for s in segments if s.end >= lo and s.start <= hi]
    window = " ".join(t.strip() for t in picked if t and t.strip())
    if not window:
        # The stamp landed outside the transcript (clock skew, a trimmed
        # recording) — fall back to everything rather than answering nothing.
        return (transcript.text or "")[:_MAX_WINDOW_CHARS]
    return window[:_MAX_WINDOW_CHARS]


@router.post("/jobs/{job_id}/answers", response_model=DraftAnswersResponse)
async def draft_answers(
    request: Request, job_id: str, body: DraftAnswersRequest
) -> DraftAnswersResponse:
    record = _store(request).get(job_id)
    if record is None:
        raise HTTPException(status_code=404, detail=f"Unknown job id: {job_id}")
    if record.transcript is None or not (record.transcript.text or "").strip():
        raise HTTPException(
            status_code=409,
            detail="This job has no transcript yet — answers can only be drafted "
            "once transcription has finished.",
        )
    if not body.questions:
        return DraftAnswersResponse(answers=[])

    items = [
        {
            "id": q.id,
            "question": q.question.strip()[:_MAX_QUESTION_CHARS],
            "window": _window_for(record, q.atMs),
        }
        for q in body.questions[:_MAX_ANSWER_ITEMS]
    ]
    attendees = [a.strip() for a in body.attendees[:50] if a and a.strip()]

    settings = get_settings()
    try:
        answers = await extract.run_answers(items, attendees, settings)
    except Exception as exc:  # Ollama unreachable — the laptop shows the error
        log.warning("Answer drafting failed for job %s: %s", job_id, exc)
        raise HTTPException(
            status_code=502, detail=f"Answer drafting failed: {exc}"
        ) from exc
    log.info("Drafted %d answer(s) for job %s", len(answers), job_id)
    return DraftAnswersResponse(answers=answers)
