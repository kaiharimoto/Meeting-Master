"""Pydantic models for the job pipeline.

Field names are deliberately camelCase where the HTTP/IPC contract uses
camelCase (createdAt/updatedAt, schemaVersion, ...) so serialized JSON matches
the laptop app without alias plumbing. JobState values must stay in sync with
JOB_STATES in app/src/shared/schema.js.
"""

from enum import Enum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class JobState(str, Enum):
    queued = "queued"
    normalizing = "normalizing"
    transcribing = "transcribing"
    summarizing = "summarizing"
    ready = "ready"
    pdf_received = "pdf_received"
    emailed = "emailed"
    failed = "failed"


# States in which transcript+summary exist and a PDF may be posted back.
READY_STATES = frozenset({JobState.ready, JobState.pdf_received, JobState.emailed})


class Card(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str = ""
    question: str = ""
    answer: str = ""
    participant: str = ""


class MeetingDetails(BaseModel):
    model_config = ConfigDict(extra="ignore")

    title: str = ""
    date: str = ""
    time: str = ""
    attendees: list[str] = Field(default_factory=list)


class MeetingMeta(BaseModel):
    """The meeting JSON uploaded by the laptop.

    Tolerates extra fields (the renderer state may carry transcript/summary or
    future keys) so a newer laptop app doesn't break an older server.
    """

    model_config = ConfigDict(extra="ignore")

    schemaVersion: int = 1
    details: MeetingDetails
    cards: list[Card] = Field(default_factory=list)
    recipients: list[str] = Field(default_factory=list)
    options: dict[str, Any] = Field(default_factory=dict)


class TranscriptSegment(BaseModel):
    start: float  # seconds
    end: float    # seconds
    text: str


class Transcript(BaseModel):
    text: str
    segments: list[TranscriptSegment] = Field(default_factory=list)


class PdfInfo(BaseModel):
    received: bool = False
    emailed: bool = False


class JobRecord(BaseModel):
    id: str
    state: JobState
    createdAt: str  # ISO-8601 UTC
    updatedAt: str  # ISO-8601 UTC
    meeting: MeetingMeta
    transcript: Transcript | None = None
    summary: str | None = None
    # 0-100 progress for the current long stage (transcription); None otherwise.
    # Lets the laptop show "Transcribing… 42%" instead of a mystery spinner.
    progress: int | None = None
    pdf: PdfInfo = Field(default_factory=PdfInfo)
    error: str | None = None
