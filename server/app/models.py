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


class ExtractedQuestion(BaseModel):
    """A Q&A pair the AI found in the transcript, offered to the operator for
    approval (never auto-added to the meeting cards).

    ``answerer`` is the one that matters — it becomes a card's ``participant``
    when the operator approves the question. ``directedTo`` (who the question
    seemed aimed at / who could answer) is a lower-confidence culling aid.
    """

    model_config = ConfigDict(extra="ignore")

    question: str = ""
    answer: str = ""
    answerer: str = ""
    directedTo: str = ""
    # Confidence in the ``answerer`` attribution: "high" when the transcript
    # clearly names who spoke, else "low" (the approval UI flags low ones so the
    # operator double-checks). Empty answerer is always treated as low.
    confidence: str = "high"


class LiveSuggestions(BaseModel):
    """What the mid-meeting live path offers the operator (POST /live/questions).

    Two kinds of suggestion, both advisory and both approved one at a time in
    the laptop's side rail:

    * ``questions`` — Q&A pairs already answered in the conversation, which
      become ordinary meeting cards when approved.
    * ``insights`` — lessons worth carrying forward, which become Key Insights
      in the summary/PDF when kept. NOT a summary of what happened (that is the
      post-meeting Key Takeaways' job).

    Nothing here is ever added automatically, and nothing here is persisted
    server-side: the live path is stateless and the post-meeting pipeline over
    the full transcript remains the quality backstop.
    """

    model_config = ConfigDict(extra="ignore")

    questions: list[ExtractedQuestion] = Field(default_factory=list)
    insights: list[str] = Field(default_factory=list)


class AnsweredQuestion(BaseModel):
    """An answer the AI drafted for a question the OPERATOR captured.

    The inverse of ExtractedQuestion: there the AI finds the question, here the
    question is already known (typed during the meeting) and only the answer is
    missing. Carries the card ``id`` so the laptop can match the answer back to
    the exact card without string-matching questions it may since have edited.

    Like every AI output in this app, it is a SUGGESTION — the operator approves
    each one before it touches a card.
    """

    model_config = ConfigDict(extra="ignore")

    id: str = ""
    answer: str = ""
    answerer: str = ""
    # "high" when the transcript window plainly contains the answer; "low" when
    # the model had to reach. Empty answer is always low.
    confidence: str = "high"


class ActionItem(BaseModel):
    """A follow-up task extracted from the meeting: what to do, who owns it,
    when it's due, and how urgent. Rendered as a ruled table in the PDF."""

    model_config = ConfigDict(extra="ignore")

    task: str = ""
    owner: str = ""      # who owns it (or "" if the transcript never says)
    due: str = ""        # due date/'when' AS STATED ("Nov 15", "next sprint"), or ""
    priority: str = "normal"  # "high" | "normal" | "low"


class MeetingSummary(BaseModel):
    """Structured, presentation-style summary rendered as a bulleted "deck" in
    the PDF: Key Takeaways, Key Insights, Decisions, Action Items
    (owner/due/priority), Key Figures, and Topics. String lists hold short
    self-contained bullets.

    keyTakeaways vs keyInsights is a deliberate, load-bearing distinction:
    takeaways RECORD the meeting (what happened, what was concluded), insights
    are LESSONS carried forward (what to do differently, what this teaches for
    next time). Never merge the two — a reader skims takeaways to remember the
    meeting and insights to act beyond it.
    """

    model_config = ConfigDict(extra="ignore")

    keyTakeaways: list[str] = Field(default_factory=list)
    keyInsights: list[str] = Field(default_factory=list)
    decisions: list[str] = Field(default_factory=list)
    actionItems: list[ActionItem] = Field(default_factory=list)
    keyFigures: list[str] = Field(default_factory=list)
    topics: list[str] = Field(default_factory=list)


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
    # Set when the transcript looks damaged in a way that will quietly poison
    # the notes made from it — currently a whisper repetition loop over quiet
    # audio. Not an error: the transcript is still delivered, and the operator
    # decides. None means it looked clean.
    warning: str | None = None


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
    # Structured, presentation-style summary (Key Takeaways / Decisions /
    # Action Items / Key Figures / Topics). None until summarize completes.
    # `str` is tolerated ONLY
    # so pre-upgrade job.json files (whose summary was plain prose) still load
    # instead of being dropped whole by load_all() — the PDF renderer already
    # handles both shapes. New jobs always store a MeetingSummary.
    summary: MeetingSummary | str | None = None
    # Q&A pairs the AI detected in the transcript, awaiting operator approval
    # on the laptop — never merged into meeting.cards automatically.
    questions: list[ExtractedQuestion] = Field(default_factory=list)
    # 0-100 progress for the current long stage (transcription); None otherwise.
    # Lets the laptop show "Transcribing… 42%" instead of a mystery spinner.
    progress: int | None = None
    pdf: PdfInfo = Field(default_factory=PdfInfo)
    error: str | None = None
    # Per-AI-stage failures (v0.5.0). A job can be `ready` (transcript done)
    # while summarization or question extraction failed — these carry the
    # reason so clients can SAY so and offer a retry, instead of silently
    # shipping an empty summary. None = the stage succeeded (or hasn't run).
    summaryError: str | None = None
    questionsError: str | None = None
