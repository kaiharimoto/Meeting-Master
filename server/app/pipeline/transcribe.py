"""Stage 2: transcribe the normalized WAV with whisper.cpp (shelled out).

whisper-cli is a Vulkan build on the target machine (AMD 7900 XTX). We ask for
JSON output (-oj -of <base> writes <base>.json) and parse whisper.cpp's shape:

    {"transcription": [{"offsets": {"from": <ms>, "to": <ms>}, "text": "..."}]}

NOTE: offsets are in MILLISECONDS — divide by 1000 for the contract's seconds.
"""

import asyncio
import json
import logging
import re
import shlex
from pathlib import Path

from .. import config
from ..config import Settings
from ..models import MeetingMeta, Transcript, TranscriptSegment
from . import resolve_tool

log = logging.getLogger(__name__)

# Model names become file names (ggml-<model>.bin) — restrict to safe chars so
# a hostile meeting JSON can't turn into a path traversal.
_MODEL_NAME_RE = re.compile(r"^[A-Za-z0-9._-]+$")

# whisper.cpp with --print-progress emits lines like
#   "whisper_print_progress_callback: progress =  40%"
_PROGRESS_RE = re.compile(r"progress\s*=\s*(\d{1,3})\s*%")

# A phrase repeated this many times IN A ROW is a transcription loop, not a
# meeting. Six is comfortably above anything real speech does ("yeah yeah yeah"
# tops out well below it) and well below the dozens a loop produces.
_LOOP_RUN = 6


def detect_repetition_loop(segments: list[TranscriptSegment]) -> str | None:
    """Describe the worst repetition loop in a transcript, or None if clean.

    Whisper hallucinates a filler phrase over quiet or non-speech audio and,
    with prompt carry-over enabled, repeats it — sometimes for pages. The
    transcript still LOOKS like a transcript, so it flows into the summary and
    the Q&A extraction as if it were speech. Saying so is the difference
    between "the notes are strangely thin" and knowing why.
    """
    longest_run, longest_text = 0, ""
    run_text, run_len = None, 0
    for seg in segments:
        text = seg.text.strip().casefold()
        if not text:
            continue
        if text == run_text:
            run_len += 1
        else:
            run_text, run_len = text, 1
        if run_len > longest_run:
            longest_run, longest_text = run_len, seg.text.strip()
    if longest_run < _LOOP_RUN:
        return None
    return (
        f'The transcript repeats "{longest_text}" {longest_run} times in a row — '
        "that is a transcription loop over quiet or unclear audio, not speech. "
        "The notes from it will be poor. Check the recording's levels around "
        "that point; if the audio is fine, lower whisper's max-context "
        "(WHISPER_MAX_CONTEXT) or try the fallback model."
    )


def _pick_model_file(settings: Settings, meeting: MeetingMeta) -> Path:
    requested = None
    if isinstance(meeting.options, dict):
        candidate = meeting.options.get("whisperModel")
        if isinstance(candidate, str) and _MODEL_NAME_RE.match(candidate):
            requested = candidate
    model = requested or settings.WHISPER_MODEL_DEFAULT
    model_dir = Path(settings.WHISPER_MODEL_DIR)
    model_file = model_dir / f"ggml-{model}.bin"
    if model_file.exists():
        return model_file
    # Requested/default model not downloaded — try the configured fallback.
    fallback_file = model_dir / f"ggml-{settings.WHISPER_MODEL_FALLBACK}.bin"
    if fallback_file.exists():
        log.warning(
            "Whisper model %s not found; falling back to %s",
            model_file.name, fallback_file.name,
        )
        return fallback_file
    # Neither file exists. Pass the original path through anyway: the real
    # whisper-cli will fail with a clear message, and test stubs ignore -m.
    log.warning(
        "Neither %s nor fallback %s exists in %s — proceeding anyway",
        model_file.name, fallback_file.name, model_dir,
    )
    return model_file


async def run(
    settings: Settings,
    meeting: MeetingMeta,
    norm_path: Path,
    job_dir: Path,
    on_progress=None,
) -> Transcript:
    model_file = _pick_model_file(settings, meeting)
    out_base = job_dir / "transcript"  # whisper writes <out_base>.json
    cmd = [
        *resolve_tool(settings.WHISPER_CLI),
        "-m", str(model_file),
        "-f", str(norm_path),
        "-oj",
        "-of", str(out_base),
        "-l", settings.WHISPER_LANGUAGE,
        "--print-progress",  # emit "progress = N%" to stderr for the UI
        # See WHISPER_MAX_CONTEXT: 0 breaks the feedback loop that turns a quiet
        # stretch of a meeting into "I don't know." repeated for pages.
        "-mc", str(max(0, int(settings.WHISPER_MAX_CONTEXT))),
    ]
    if settings.WHISPER_EXTRA_ARGS.strip():
        cmd += shlex.split(settings.WHISPER_EXTRA_ARGS)
    log.info("Transcribing %s with %s", norm_path.name, model_file.name)
    # stdout goes to the JSON file (-oj -of); read stderr line-by-line so we can
    # surface live progress instead of blocking silently in communicate().
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE,
        **config.subprocess_flags(),  # no flashing console window (windowed app)
    )

    stderr_chunks: list[str] = []

    async def _pump() -> None:
        assert proc.stderr is not None
        while True:
            raw = await proc.stderr.readline()
            if not raw:
                break
            line = raw.decode("utf-8", "replace")
            stderr_chunks.append(line)
            match = _PROGRESS_RE.search(line)
            if match and on_progress is not None:
                try:
                    on_progress(int(match.group(1)))
                except Exception:  # a bad callback must not stop transcription
                    log.debug("on_progress callback raised", exc_info=True)

    try:
        await asyncio.wait_for(_pump(), timeout=float(settings.WHISPER_TIMEOUT_SEC))
        await proc.wait()
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        raise RuntimeError(
            f"whisper.cpp timed out after {settings.WHISPER_TIMEOUT_SEC}s"
        )
    except asyncio.CancelledError:
        # Worker task cancelled (server shutdown) — don't orphan the child.
        proc.kill()
        raise
    if proc.returncode != 0:
        tail = "".join(stderr_chunks)[-2000:].strip()
        raise RuntimeError(f"whisper.cpp failed (exit {proc.returncode}): {tail}")

    json_path = Path(f"{out_base}.json")
    data = json.loads(json_path.read_text(encoding="utf-8"))
    if "transcription" not in data:
        raise RuntimeError(
            f"whisper.cpp output {json_path} has no 'transcription' key — "
            "unexpected JSON shape (is this really whisper.cpp -oj output?)"
        )

    segments: list[TranscriptSegment] = []
    texts: list[str] = []
    for seg in data["transcription"]:
        text = (seg.get("text") or "").strip()
        offsets = seg.get("offsets") or {}
        segments.append(
            TranscriptSegment(
                start=float(offsets.get("from", 0)) / 1000.0,  # ms -> s
                end=float(offsets.get("to", 0)) / 1000.0,      # ms -> s
                text=text,
            )
        )
        if text:
            texts.append(text)
    warning = detect_repetition_loop(segments)
    if warning:
        log.warning("Transcript quality: %s", warning)
    return Transcript(text=" ".join(texts), segments=segments, warning=warning)
