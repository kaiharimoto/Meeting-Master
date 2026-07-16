"""Stage 1: normalize the uploaded audio with ffmpeg.

whisper.cpp expects 16 kHz mono 16-bit PCM WAV; feeding it anything else
degrades or breaks transcription, so we always re-encode
(-ar 16000 -ac 1 -c:a pcm_s16le) regardless of what the laptop sent.
"""

import asyncio
import logging
from pathlib import Path

from ..config import Settings
from . import resolve_tool, stderr_tail

log = logging.getLogger(__name__)


async def run(settings: Settings, raw_path: Path, norm_path: Path) -> None:
    cmd = [
        *resolve_tool(settings.FFMPEG_PATH),
        "-y",  # overwrite an existing output (job retried on the same dir)
        "-i", str(raw_path),
        "-ar", "16000",
        "-ac", "1",
        "-c:a", "pcm_s16le",
        str(norm_path),
    ]
    log.info("Normalizing %s -> %s", raw_path.name, norm_path.name)
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        _, stderr = await proc.communicate()
    except asyncio.CancelledError:
        # Worker task cancelled (server shutdown) — don't orphan the child.
        proc.kill()
        raise
    if proc.returncode != 0:
        raise RuntimeError(
            f"ffmpeg failed (exit {proc.returncode}): {stderr_tail(stderr)}"
        )
