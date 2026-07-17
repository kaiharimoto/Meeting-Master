"""Single background worker that processes uploaded jobs one at a time.

Upload handlers only enqueue a job id (never process inline — a ~600 MB WAV
takes minutes of GPU time); this loop pulls ids off the queue and runs the
normalize -> transcribe -> summarize pipeline sequentially, which also keeps
the GPU to one whisper/Ollama job at a time.
"""

import asyncio
import logging

from .config import get_settings
from .models import JobState
from .pipeline import normalize, summarize, transcribe
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

        store.update(job, state=JobState.summarizing, progress=None)
        summary = await summarize.run(transcript.text, job.meeting, settings)

        store.update(job, summary=summary, state=JobState.ready, progress=None)
        log.info("Job %s ready", job.id)
    except Exception as exc:
        log.exception("Job %s failed", job.id)
        store.update(job, state=JobState.failed, error=str(exc))


async def worker_loop(store: JobStore) -> None:
    log.info("Worker loop started")
    while True:
        job_id = await queue.get()
        try:
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
