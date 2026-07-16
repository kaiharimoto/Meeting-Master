"""In-memory job store with per-job JSON persistence.

Deliberately no database: jobs live in a dict and each job persists itself to
DATA_DIR/<id>/job.json so the record survives a server restart. On startup,
load_all() re-reads every job.json; anything that was mid-pipeline when the
process died is marked failed (the worker queue is not persisted).
"""

import logging
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from .config import Settings
from .models import JobRecord, JobState, MeetingMeta

log = logging.getLogger(__name__)

# States a job can legitimately be in after a restart.
_TERMINAL_STATES = frozenset(
    {JobState.ready, JobState.pdf_received, JobState.emailed, JobState.failed}
)


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class JobStore:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._jobs: dict[str, JobRecord] = {}

    @property
    def data_dir(self) -> Path:
        return self._settings.data_dir

    def job_dir(self, job_id: str) -> Path:
        return self.data_dir / job_id

    def create(self, meeting: MeetingMeta) -> JobRecord:
        now = _utcnow_iso()
        # Timestamp prefix keeps directories sorted by creation time; the uuid
        # suffix disambiguates jobs created within the same second.
        job_id = f"{datetime.now(timezone.utc):%Y%m%d-%H%M%S}-{uuid4().hex[:6]}"
        record = JobRecord(
            id=job_id,
            state=JobState.queued,
            createdAt=now,
            updatedAt=now,
            meeting=meeting,
        )
        self.job_dir(job_id).mkdir(parents=True, exist_ok=True)
        self._jobs[job_id] = record
        self.save(record)
        return record

    def save(self, record: JobRecord) -> None:
        path = self.job_dir(record.id) / "job.json"
        path.write_text(record.model_dump_json(indent=2), encoding="utf-8")

    def update(self, record: JobRecord, **changes) -> JobRecord:
        """Apply field changes, bump updatedAt, persist."""
        for field, value in changes.items():
            setattr(record, field, value)
        record.updatedAt = _utcnow_iso()
        self.save(record)
        return record

    def get(self, job_id: str) -> JobRecord | None:
        return self._jobs.get(job_id)

    def load_all(self) -> None:
        """Scan DATA_DIR/*/job.json into memory (called once at startup)."""
        if not self.data_dir.exists():
            return
        for job_file in sorted(self.data_dir.glob("*/job.json")):
            try:
                record = JobRecord.model_validate_json(
                    job_file.read_text(encoding="utf-8")
                )
            except Exception:  # corrupted/foreign file — skip, don't crash startup
                log.warning("Skipping unreadable job file %s", job_file, exc_info=True)
                continue
            if record.state not in _TERMINAL_STATES:
                # The in-flight work (queue position, subprocesses) is gone.
                record.state = JobState.failed
                record.error = (
                    "Server restarted while the job was in progress — "
                    "re-upload the audio."
                )
                record.updatedAt = _utcnow_iso()
                self._jobs[record.id] = record
                self.save(record)
            else:
                self._jobs[record.id] = record
        log.info("Loaded %d job(s) from %s", len(self._jobs), self.data_dir)
