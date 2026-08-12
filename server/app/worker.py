"""Single background worker that processes uploaded jobs one at a time.

Upload handlers only enqueue a job id (never process inline — a ~600 MB WAV
takes minutes of GPU time); this loop pulls ids off the queue and runs the
normalize -> transcribe -> summarize pipeline sequentially, which also keeps
the GPU to one whisper/Ollama job at a time.
"""

import asyncio
import logging

from .config import get_settings
from .models import JobState, MeetingSummary
from .pipeline import _provider, extract, normalize, summarize, transcribe
from .store import JobStore

log = logging.getLogger(__name__)

# Module-level queue of job ids. Safe to create at import time on Python 3.10+
# (asyncio.Queue no longer binds to an event loop at construction) — but it
# DOES bind to the first loop that awaits it, so lifespan startup calls
# reset_queue() to get a fresh queue per application lifecycle (the test
# client creates a new event loop for every test).
queue: asyncio.Queue[str] = asyncio.Queue()


def reset_queue() -> None:
    """Replace the queue — called at startup so it binds to the current loop."""
    global queue
    queue = asyncio.Queue()


def enqueue(job_id: str) -> None:
    queue.put_nowait(job_id)


async def process(store: JobStore, job) -> None:
    """Run one job through the pipeline, recording stage transitions."""
    settings = get_settings()
    job_dir = store.job_dir(job.id)
    raw_path = job_dir / "raw.wav"
    norm_path = job_dir / "norm.wav"
    try:
        store.update(job, state=JobState.normalizing, progress=None)
        await normalize.run(settings, raw_path, norm_path)

        store.update(job, state=JobState.transcribing, progress=0)
        # Persist each new whole-percent from whisper so the laptop can show a
        # live "Transcribing… N%", and log every 10% to server.log so the home
        # PC operator can see it is moving (and how fast).
        progress_state = {"pct": -1, "logged": -10}

        def on_progress(pct: int) -> None:
            pct = max(0, min(100, int(pct)))
            if pct == progress_state["pct"]:
                return
            progress_state["pct"] = pct
            store.update(job, progress=pct)
            if pct - progress_state["logged"] >= 10 or pct == 100:
                progress_state["logged"] = pct
                log.info("Job %s transcription %d%%", job.id, pct)

        transcript = await transcribe.run(
            settings, job.meeting, norm_path, job_dir, on_progress=on_progress
        )
        store.update(job, transcript=transcript, progress=None)

        # Two-step flow (v0.7.0 standard): the upload asks for transcript-only
        # so the operator can review/fix names BEFORE any AI reads them; the
        # app's "Start AI" then hits POST /jobs/{id}/summarize.
        if job.meeting.options.get("skipAi"):
            store.update(job, state=JobState.ready, progress=None)
            log.info("Job %s transcript ready (AI deferred to Start AI)", job.id)
            return

        store.update(job, state=JobState.summarizing, progress=None)
        await run_ai_stages(store, job, transcript.text)
        log.info("Job %s ready (%d candidate question(s))", job.id, len(job.questions))
    except Exception as exc:
        log.exception("Job %s failed", job.id)
        store.update(job, state=JobState.failed, error=str(exc))


def _looks_like_context_error(exc: Exception, settings=None) -> bool:
    """Does this failure look like Ollama ran out of context or VRAM?

    Only ever true for Ollama. NUM_CTX is an Ollama setting, so halving it does
    nothing for another backend — and the keywords below are broad enough to
    match things that are not context problems at all. "Usage limit reached for
    this 5-hour context window" from the Claude CLI contains "context" and
    would otherwise buy a second doomed call against a quota that is already
    spent.
    """
    if settings is not None and _provider.uses_claude_cli(settings):
        return False
    text = str(exc).lower()
    return any(k in text for k in ("context", "out of memory", "oom", "kv cache", "memory"))


async def run_ai_stages(store: JobStore, job, transcript_text: str) -> None:
    """Summarize + extract Q&A on an existing transcript, recording per-stage
    failures on the job (never silently swallowing them). Used by the normal
    pipeline AND by the retry endpoint (POST /jobs/{id}/summarize).

    Auto-remedy: an Ollama failure that smells like a context/VRAM problem is
    retried ONCE with half the configured context window before being reported.
    """
    settings = get_settings()

    summary, summary_error = None, None
    try:
        summary = await summarize.run(transcript_text, job.meeting, settings)
    except Exception as exc:
        if _looks_like_context_error(exc, settings):
            log.warning("Job %s: summary hit a context-like error (%s) — retrying "
                        "with NUM_CTX %d", job.id, exc, settings.NUM_CTX // 2)
            try:
                reduced = settings.model_copy(update={"NUM_CTX": max(2048, settings.NUM_CTX // 2)})
                summary = await summarize.run(transcript_text, job.meeting, reduced)
            except Exception as exc2:
                summary_error = f"{exc2} (also failed after halving the context window)"
        else:
            summary_error = str(exc)
    if summary_error:
        log.error("Job %s: summary generation failed: %s", job.id, summary_error)

    questions, questions_error = [], None
    try:
        questions = await extract.run(transcript_text, job.meeting, settings)
    except Exception as exc:
        questions_error = str(exc)
        log.error("Job %s: question extraction failed: %s", job.id, questions_error)

    store.update(
        job,
        summary=summary if summary is not None else MeetingSummary(),
        questions=questions,
        summaryError=summary_error,
        questionsError=questions_error,
        state=JobState.ready,
        progress=None,
    )


async def worker_loop(store: JobStore) -> None:
    log.info("Worker loop started")
    while True:
        job_id = await queue.get()
        try:
            # "summarize:<id>" re-runs ONLY the AI stages on the stored
            # transcript (POST /jobs/{id}/summarize) — transcript generation
            # and summary generation are separate, retryable steps.
            if job_id.startswith("summarize:"):
                job = store.get(job_id.split(":", 1)[1])
                if job is None or job.transcript is None:
                    log.warning("Summarize request for unknown/transcript-less job %s", job_id)
                    continue
                store.update(job, state=JobState.summarizing, progress=None, error=None)
                try:
                    await run_ai_stages(store, job, job.transcript.text)
                    log.info("Job %s re-summarized", job.id)
                except Exception as exc:
                    log.exception("Job %s re-summarize failed", job.id)
                    store.update(job, state=JobState.ready, summaryError=str(exc))
                continue
            job = store.get(job_id)
            if job is None:
                log.warning("Dequeued unknown job id %s — skipping", job_id)
                continue
            await process(store, job)
        except Exception:
            # process() handles its own failures; this guards the loop itself.
            log.exception("Unexpected worker error for job %s", job_id)
        finally:
            queue.task_done()
