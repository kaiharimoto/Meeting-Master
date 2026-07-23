"""Live (mid-meeting) endpoints.

The laptop's live-transcription loop calls POST /live/questions every ~30 s
with the newest slice of its LOCAL draft transcript; the answer is candidate
Q&A pairs the operator can approve into cards while the meeting is running.
Stateless by design — no job, no store, nothing persisted: if this endpoint
is unreachable the laptop silently skips the tick and the post-meeting
extraction (routes/jobs.py pipeline) remains the quality backstop.
"""

import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..auth import verify_token
from ..config import get_settings
from ..models import ExtractedQuestion
from ..pipeline import extract
from .jobs import require_configured

log = logging.getLogger(__name__)

router = APIRouter(dependencies=[Depends(require_configured), Depends(verify_token)])

# The laptop sends its recent text; cap server-side anyway so a buggy or
# malicious client can't push an unbounded prompt into Ollama.
_MAX_WINDOW_CHARS = 12000
_MAX_LIST_ITEMS = 50


class LiveQuestionsRequest(BaseModel):
    transcriptWindow: str = Field(min_length=1)
    attendees: list[str] = []
    alreadyFlagged: list[str] = []


class LiveQuestionsResponse(BaseModel):
    questions: list[ExtractedQuestion]


@router.post("/live/questions", response_model=LiveQuestionsResponse)
async def live_questions(body: LiveQuestionsRequest) -> LiveQuestionsResponse:
    window = body.transcriptWindow.strip()
    if not window:
        raise HTTPException(status_code=422, detail="transcriptWindow is empty.")
    window = window[-_MAX_WINDOW_CHARS:]

    attendees = [a.strip() for a in body.attendees[:_MAX_LIST_ITEMS] if a and a.strip()]
    flagged = [q.strip() for q in body.alreadyFlagged[:_MAX_LIST_ITEMS] if q and q.strip()]

    settings = get_settings()
    try:
        questions = await extract.run_live(window, attendees, flagged, settings)
    except Exception as exc:  # Ollama down/slow/garbled — the laptop skips the tick
        log.warning("Live question extraction failed: %s", exc)
        raise HTTPException(
            status_code=502, detail=f"Live question extraction failed: {exc}"
        ) from exc
    return LiveQuestionsResponse(questions=questions)
