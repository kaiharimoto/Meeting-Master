"""Stage 2: transcribe the normalized WAV with whisper.cpp (shelled out).

whisper-cli is a Vulkan build on the target machine (AMD 7900 XTX). We ask for
JSON output (-oj -of <base> writes <base>.json) and parse whisper.cpp's shape:

    {"transcription": [{"offsets": {"from": <ms>, "to": <ms>}, "text": "..."}]}

NOTE: offsets are in MILLISECONDS — divide by 1000 for the contract's seconds.

CI compiles whisper-cli from upstream source, so this stage's real dependency
is a moving target and has broken underneath a release once already — see
"Surviving a GPU path that crashes" below, which is why an attempt here is a
LADDER rather than a single subprocess call.
"""

import asyncio
import json
import logging
import os
import re
import shlex
from pathlib import Path
from typing import NamedTuple

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


# --- Surviving a GPU path that crashes ---------------------------------------
#
# whisper.cpp v1.8.0 turned flash attention ON by default and added -nfa to
# turn it back off. On the machine this pipeline was written for — an AMD RX
# 7900 XTX on the proprietary Windows driver, whose Vulkan device advertises
# KHR_coopmat — that path takes the process down inside whisper_init_state,
# before a single sample of audio is read:
#
#   whisper_backend_init_gpu: using Vulkan0 backend
#   RuntimeError: whisper.cpp failed (exit 3221225501): ...
#
# 3221225501 is 0xC000001D, STATUS_ILLEGAL_INSTRUCTION. The child did not
# report an error, it DIED. Because CI builds whisper.cpp from upstream at
# release time, the day that default flipped an ordinary app update turned
# every transcription into a failed job (v0.20.0/v0.20.1) with nothing in this
# repository having changed.
#
# Three things answer that, and all three are needed:
#
#   1. CI pins WHISPER_CPP_REF to a tag, so upstream cannot change what we ship
#      without someone choosing it (.github/workflows/build-installers.yml).
#   2. WHISPER_FLASH_ATTN defaults to OFF — what the builds that worked did.
#   3. A crash is not a verdict. When whisper-cli dies rather than fails, the
#      SAME audio is re-run with each accelerator path switched off in turn and
#      finally on the CPU. A driver or shader bug then costs a slow transcript,
#      not the meeting.

# Windows reports an unhandled exception as its NTSTATUS code, which is always
# 0xC0000000 or above (0xC0000005 access violation, 0xC000001D illegal
# instruction, 0xC0000409 stack overrun...). An ordinary whisper-cli error exit
# is a small number, so the two never overlap.
_WINDOWS_EXCEPTION_MIN = 0xC0000000

# stderr from a GPU that gave up rather than crashed outright. Deliberately
# narrow: "vulkan" alone appears in the device banner of every healthy run.
# Matched against stderr with punctuation squeezed out, so one spelling covers
# "device lost", "VK_ERROR_DEVICE_LOST" and "vk::DeviceLostError" alike.
_GPU_FAILURE_MARKERS = (
    "devicelost",
    "outofdevicememory",
    "failedtoallocatememoryonthedevice",
)

_SQUASH_RE = re.compile(r"[^a-z0-9]+")

# Long-form spellings of the flags this stage may pass. Long forms on purpose:
# they read as English in server.log and in a reproduction command pasted into
# a terminal, and they are what --help advertises.
_FLAG_FLASH_ATTN = "--flash-attn"
_FLAG_NO_FLASH_ATTN = "--no-flash-attn"
_FLAG_NO_GPU = "--no-gpu"

# What to assume when the binary cannot be asked (see _supported_flags). Both
# have been in whisper.cpp for years; --no-flash-attn arrived in v1.8.0 and is
# exactly the flag that must not be guessed at.
_LONG_STANDING_FLAGS = frozenset({_FLAG_FLASH_ATTN, _FLAG_NO_GPU})

# ggml's Vulkan backend reads these directly — there is no CLI flag for them.
# Cooperative-matrix (tensor-core) shaders are the other half of the AMD Vulkan
# crash surface, so they get a rung of their own.
_NO_COOPMAT_ENV = {"GGML_VK_DISABLE_COOPMAT": "1", "GGML_VK_DISABLE_COOPMAT2": "1"}

_HELP_TIMEOUT_SEC = 20.0
_LONG_FLAG_RE = re.compile(r"--[A-Za-z][A-Za-z0-9-]*")

# Keyed by (argv prefix, binary mtime+size) so an update to whisper-cli is
# never answered from the previous build's help text.
_help_cache: dict[tuple, frozenset[str]] = {}


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


def _help_cache_key(argv_prefix: list[str]) -> tuple:
    try:
        stat = Path(argv_prefix[-1]).stat()
        stamp = (stat.st_mtime_ns, stat.st_size)
    except OSError:
        stamp = None
    return (tuple(argv_prefix), stamp)


async def _supported_flags(argv_prefix: list[str]) -> frozenset[str]:
    """The long options this whisper-cli advertises in ``--help``.

    Worth one extra process per binary because of how whisper.cpp handles an
    argument it does not recognise: it prints "error: unknown argument" and
    then **exits 0**. A flag guessed wrong therefore does not fail loudly — it
    produces a successful-looking run that transcribed nothing, which is a far
    worse failure than the one being fixed. Asking first means this stage can
    use flags that only exist in newer builds (``--no-flash-attn``) while a
    developer's older whisper-cli on PATH keeps working.
    """
    key = _help_cache_key(argv_prefix)
    cached = _help_cache.get(key)
    if cached is not None:
        return cached

    flags = _LONG_STANDING_FLAGS
    try:
        proc = await asyncio.create_subprocess_exec(
            *argv_prefix, "--help",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,  # whisper.cpp prints usage to stderr
            **config.subprocess_flags(),
        )
    except OSError as exc:
        # Missing/unrunnable binary: say nothing here and let the real run
        # produce the error the operator needs to see.
        log.warning("Could not run %s --help (%s)", argv_prefix[-1], exc)
        _help_cache[key] = flags
        return flags

    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=_HELP_TIMEOUT_SEC)
        advertised = frozenset(_LONG_FLAG_RE.findall(out.decode("utf-8", "replace")))
        # A help text that mentions no options at all is not a help text.
        if advertised:
            flags = advertised
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        log.warning("%s --help did not answer in %.0fs", argv_prefix[-1], _HELP_TIMEOUT_SEC)
    except asyncio.CancelledError:
        proc.kill()
        raise

    _help_cache[key] = flags
    return flags


class _Attempt(NamedTuple):
    """One rung of the fallback ladder."""

    label: str                 # named in the log and in the operator's notice
    args: tuple[str, ...]      # appended last, so a rung always gets its way
    env: dict[str, str]        # ggml env overrides for the child
    notice: str | None         # shown to the operator when THIS rung is the one that worked


def _plan_attempts(settings: Settings, flags: frozenset[str]) -> list[_Attempt]:
    """The GPU first, then the same audio with each suspect path switched off.

    Only ever walked past the first rung when whisper-cli CRASHED, and a crash
    happens during model load — seconds in, before any transcription work — so
    the healthy case pays for exactly one run and the broken case pays a few
    wasted seconds per rung.
    """
    fa_on = _FLAG_FLASH_ATTN if _FLAG_FLASH_ATTN in flags else None
    fa_off = _FLAG_NO_FLASH_ATTN if _FLAG_NO_FLASH_ATTN in flags else None
    no_gpu = _FLAG_NO_GPU if _FLAG_NO_GPU in flags else None

    attempts: list[_Attempt] = []
    if settings.WHISPER_GPU:
        wanted = fa_on if settings.WHISPER_FLASH_ATTN else fa_off
        attempts.append(_Attempt("GPU", (wanted,) if wanted else (), {}, None))
        if settings.WHISPER_FLASH_ATTN and fa_off:
            attempts.append(_Attempt(
                "GPU with flash attention off",
                (fa_off,),
                {},
                "The GPU crashed with flash attention on, so this meeting was "
                "transcribed with it off. Set WHISPER_FLASH_ATTN=false in "
                "server.env to stop paying for that crash on every job.",
            ))
        attempts.append(_Attempt(
            "GPU without cooperative-matrix shaders",
            attempts[-1].args,
            dict(_NO_COOPMAT_ENV),
            "The GPU crashed until its cooperative-matrix (tensor-core) shaders "
            "were switched off, so this meeting was transcribed without them. "
            "That is a graphics-driver bug — update the AMD driver, and see "
            "docs/TROUBLESHOOTING.md if it persists.",
        ))
    if no_gpu:
        attempts.append(_Attempt(
            "CPU",
            (no_gpu,),
            {},
            "The GPU could not run whisper.cpp at all, so this meeting was "
            "transcribed on the CPU — correct, but many times slower. See "
            'docs/TROUBLESHOOTING.md, "Transcription crashes instead of '
            'failing", before the next meeting.',
        ))
    if not attempts:
        # WHISPER_GPU is off but this build has no --no-gpu to honour it with.
        log.warning("WHISPER_GPU=false, but this whisper-cli has no %s flag", _FLAG_NO_GPU)
        attempts.append(_Attempt("GPU", (), {}, None))
    return attempts


def _child_env(overrides: dict[str, str]) -> dict[str, str] | None:
    """A child environment, or None to inherit ours unchanged."""
    if not overrides:
        return None
    env = os.environ.copy()
    env.update(overrides)
    return env


class _Run(NamedTuple):
    returncode: int
    stderr: str


def _is_crash(run: _Run) -> bool:
    """Did whisper-cli DIE, rather than exit with an error it understood?

    Only a crash earns a retry. A model file that isn't there, audio ffmpeg
    mangled, an unreadable argument — none of those get better on the CPU, and
    re-running them would burn an hour of a meeting's turnaround to reach the
    same message.
    """
    if run.returncode < 0:
        return True  # POSIX: killed by a signal (SIGSEGV / SIGILL / SIGABRT)
    if run.returncode >= _WINDOWS_EXCEPTION_MIN:
        return True  # Windows: unhandled exception, reported as its NTSTATUS
    squashed = _SQUASH_RE.sub("", run.stderr.lower())
    return any(marker in squashed for marker in _GPU_FAILURE_MARKERS)


def _exit_description(returncode: int) -> str:
    if returncode < 0:
        return f"killed by signal {-returncode}"
    if returncode >= _WINDOWS_EXCEPTION_MIN:
        return f"crashed, exit {returncode} (0x{returncode:08X})"
    return f"exit {returncode}"


async def _run_once(
    settings: Settings,
    cmd: list[str],
    attempt: _Attempt,
    on_progress,
) -> _Run:
    """One whisper-cli invocation. Raises only for a timeout or cancellation —
    every other outcome comes back as a _Run for the ladder to judge."""
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.DEVNULL,  # the transcript goes to <-of>.json
        stderr=asyncio.subprocess.PIPE,
        env=_child_env(attempt.env),
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
        # NOT a crash: the GPU is working, just not fast enough. Re-running the
        # same audio on the CPU would take longer still, so this one is final.
        raise RuntimeError(
            f"whisper.cpp timed out after {settings.WHISPER_TIMEOUT_SEC}s"
        )
    except asyncio.CancelledError:
        # Worker task cancelled (server shutdown) — don't orphan the child.
        proc.kill()
        raise

    returncode = proc.returncode
    return _Run(
        returncode=returncode if returncode is not None else 0,
        stderr="".join(stderr_chunks),
    )


def _failure_message(attempt: _Attempt, run: _Run, tried: list[str]) -> str:
    """The whole story of a failed stage: the last thing whisper-cli said, what
    kind of failure it was, and — when the ladder ran — every path that failed.

    ``tried`` ends with ``attempt``'s own label.
    """
    tail = run.stderr[-2000:].strip()
    detail = (
        f"whisper.cpp failed ({_exit_description(run.returncode)}) "
        f"on the {attempt.label} path: {tail}"
    )
    if _is_crash(run):
        detail += (
            "\n\nwhisper-cli did not report an error — it crashed. That points at "
            "the GPU driver or a shader path, not at the recording. See "
            'docs/TROUBLESHOOTING.md, "Transcription crashes instead of failing".'
        )
    if len(tried) > 1:
        detail += "\n\nEvery path was tried and every one failed: " + ", ".join(tried) + "."
    return detail


async def run(
    settings: Settings,
    meeting: MeetingMeta,
    norm_path: Path,
    job_dir: Path,
    on_progress=None,
) -> Transcript:
    model_file = _pick_model_file(settings, meeting)
    out_base = job_dir / "transcript"  # whisper writes <out_base>.json
    json_path = Path(f"{out_base}.json")
    argv_prefix = resolve_tool(settings.WHISPER_CLI)
    flags = await _supported_flags(argv_prefix)

    base_cmd = [
        *argv_prefix,
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
        base_cmd += shlex.split(settings.WHISPER_EXTRA_ARGS)

    if not settings.WHISPER_FLASH_ATTN and _FLAG_NO_FLASH_ATTN not in flags:
        # Pre-v1.8.0 whisper.cpp: flash attention was off unless asked for, so
        # there is nothing to switch off and nothing to warn about.
        log.info("This whisper-cli predates %s — flash attention is already off "
                 "by default", _FLAG_NO_FLASH_ATTN)

    attempts = _plan_attempts(settings, flags)
    log.info("Transcribing %s with %s", norm_path.name, model_file.name)

    used: _Attempt | None = None
    tried: list[str] = []
    for index, attempt in enumerate(attempts):
        if index:
            log.warning(
                "whisper-cli crashed on the %s path — retrying %s on the %s path",
                tried[-1], norm_path.name, attempt.label,
            )
            if on_progress is not None:
                try:
                    on_progress(0)
                except Exception:
                    log.debug("on_progress callback raised", exc_info=True)
        # A rung must never read the previous rung's output file.
        json_path.unlink(missing_ok=True)
        # Attempt args go LAST so a rung's safety flags beat WHISPER_EXTRA_ARGS
        # — otherwise a hand-tuned '-fa' in there would defeat the whole ladder.
        run_result = await _run_once(
            settings, base_cmd + list(attempt.args), attempt, on_progress
        )
        tried.append(attempt.label)

        if run_result.returncode == 0 and json_path.exists():
            used = attempt
            break

        if run_result.returncode == 0:
            # Exit 0 with nothing written is whisper.cpp's answer to an argument
            # it does not recognise (it prints usage and exits 0). Retrying with
            # more arguments cannot help, so say exactly what happened.
            raise RuntimeError(
                f"whisper.cpp exited cleanly but wrote no {json_path.name}. "
                f"Last output: {run_result.stderr[-2000:].strip()}"
            )

        if not _is_crash(run_result) or index == len(attempts) - 1:
            raise RuntimeError(_failure_message(attempt, run_result, tried))

    if used is None:  # unreachable: the loop either breaks with a rung or raises
        raise RuntimeError("whisper.cpp produced no transcript and no error")
    if used is not attempts[0]:
        log.warning("Transcribed %s on the %s path after a crash on the %s path",
                    norm_path.name, used.label, attempts[0].label)

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
    return Transcript(
        text=" ".join(texts),
        segments=segments,
        warning=warning,
        notice=used.notice,
    )
