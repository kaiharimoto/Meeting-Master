"""whisper.cpp crashing on the GPU must cost a slow transcript, not the meeting.

The incident these tests pin: whisper.cpp v1.8.0 turned flash attention on by
default, CI builds whisper.cpp from upstream at release time, and so an app
update that changed nothing in this repository made every transcription fail
with

    RuntimeError: whisper.cpp failed (exit 3221225501): ...
    whisper_backend_init_gpu: using Vulkan0 backend

3221225501 is 0xC000001D — the child did not report an error, it died. The
pipeline now (a) does not ask for flash attention, (b) only passes flags the
binary advertises, and (c) re-runs a CRASHED job on progressively safer paths.

The stub (tests/stubs/fake_whisper.py) imitates a real whisper-cli closely
enough that all of this runs through actual subprocesses: it answers --help, it
exits 0 on an unknown argument the way whisper.cpp really does, and its
FAKE_WHISPER_* variables choose which rungs die and log what was invoked.
"""

import asyncio
import json
import sys
from pathlib import Path

import pytest

from app.config import Settings
from app.models import MeetingMeta
from app.pipeline import transcribe

STUB = str(Path(__file__).resolve().parent / "stubs" / "fake_whisper.py")

# What the stub's --help advertises — i.e. a whisper.cpp v1.8.0+ build.
MODERN_FLAGS = frozenset({"--flash-attn", "--no-flash-attn", "--no-gpu"})


@pytest.fixture(autouse=True)
def isolated_probe(monkeypatch):
    """The --help probe is cached per binary; every test starts clean, and no
    test inherits another's crash instructions."""
    transcribe._help_cache.clear()
    for name in ("FAKE_WHISPER_CRASH_ON", "FAKE_WHISPER_FAIL_ON", "FAKE_WHISPER_LOG"):
        monkeypatch.delenv(name, raising=False)
    yield
    transcribe._help_cache.clear()


def settings_for(**overrides) -> Settings:
    values = {"WHISPER_CLI": STUB}
    values.update(overrides)
    return Settings(**values)


def a_meeting() -> MeetingMeta:
    return MeetingMeta(details={"title": "T", "date": "2026-08-13", "time": "10:00"})


def transcribe_wav(tmp_path, **overrides):
    """Run the real stage over a throwaway WAV; returns (transcript, runs)."""
    norm = tmp_path / "norm.wav"
    norm.write_bytes(b"RIFF" + b"\0" * 64)
    return asyncio.run(
        transcribe.run(settings_for(**overrides), a_meeting(), norm, tmp_path)
    )


def runs_from(log_path: Path) -> list[dict]:
    if not log_path.exists():
        return []
    return [json.loads(line) for line in log_path.read_text().splitlines() if line]


# --- classifying the failure -------------------------------------------------

def test_the_windows_crash_code_from_the_incident_is_a_crash():
    """0xC000001D as an unsigned DWORD — copied from the failing job."""
    assert transcribe._is_crash(transcribe._Run(3221225501, ""))
    # ...and its siblings: access violation, stack overrun, heap corruption.
    for code in (3221225477, 3221226505, 3221226356):
        assert transcribe._is_crash(transcribe._Run(code, ""))


def test_a_signal_death_is_a_crash():
    assert transcribe._is_crash(transcribe._Run(-11, ""))  # SIGSEGV
    assert transcribe._is_crash(transcribe._Run(-4, ""))   # SIGILL


def test_an_ordinary_error_exit_is_not_a_crash():
    """The distinction the whole ladder rests on: a model file that isn't there
    fails identically on the CPU, so retrying it only wastes the meeting."""
    stderr = "error: failed to initialize whisper context\n"
    assert not transcribe._is_crash(transcribe._Run(1, stderr))
    assert not transcribe._is_crash(transcribe._Run(3, stderr))


def test_a_healthy_vulkan_banner_is_not_read_as_a_gpu_failure():
    """Every successful run on this machine mentions Vulkan; only a device that
    was actually lost counts as one."""
    banner = (
        "ggml_vulkan: Found 1 Vulkan devices:\n"
        "ggml_vulkan: 0 = AMD Radeon RX 7900 XTX (AMD proprietary driver)\n"
    )
    assert not transcribe._is_crash(transcribe._Run(1, banner))
    assert transcribe._is_crash(transcribe._Run(1, banner + "vk::DeviceLostError"))


# --- which flags get passed --------------------------------------------------

def test_the_probe_reads_the_binarys_own_help():
    flags = asyncio.run(transcribe._supported_flags([sys.executable, STUB]))
    assert "--no-flash-attn" in flags
    assert "--no-gpu" in flags


def test_a_binary_that_cannot_be_asked_gets_only_long_standing_flags():
    """An unrunnable path must not make the stage guess: --no-flash-attn only
    exists in v1.8.0+, and guessing it wrong produces a silent no-op run."""
    flags = asyncio.run(transcribe._supported_flags(["/nonexistent/whisper-cli"]))
    assert flags == transcribe._LONG_STANDING_FLAGS
    assert "--no-flash-attn" not in flags


def test_flash_attention_is_switched_off_by_default():
    """The regression itself: v1.8.0+ defaults it ON, and that kills this GPU."""
    attempts = transcribe._plan_attempts(settings_for(), MODERN_FLAGS)
    assert attempts[0].args == ("--no-flash-attn",)


def test_a_build_without_no_flash_attn_is_passed_nothing():
    """Pre-v1.8.0 whisper-cli defaults flash attention off already, and would
    answer '-nfa' with 'error: unknown argument' and then exit 0 — a success
    that transcribed nothing. Never pass a flag --help did not advertise."""
    attempts = transcribe._plan_attempts(
        settings_for(), transcribe._LONG_STANDING_FLAGS
    )
    assert attempts[0].args == ()
    assert attempts[-1].args == ("--no-gpu",)


def test_asking_for_flash_attention_still_falls_back_to_off():
    attempts = transcribe._plan_attempts(
        settings_for(WHISPER_FLASH_ATTN=True), MODERN_FLAGS
    )
    assert attempts[0].args == ("--flash-attn",)
    assert attempts[1].args == ("--no-flash-attn",)


def test_the_ladder_sheds_coopmat_before_it_sheds_the_gpu():
    attempts = transcribe._plan_attempts(settings_for(), MODERN_FLAGS)
    assert attempts[-1].args == ("--no-gpu",)
    assert attempts[-2].env == {
        "GGML_VK_DISABLE_COOPMAT": "1",
        "GGML_VK_DISABLE_COOPMAT2": "1",
    }


def test_gpu_off_means_only_the_cpu_is_tried():
    attempts = transcribe._plan_attempts(settings_for(WHISPER_GPU=False), MODERN_FLAGS)
    assert [a.label for a in attempts] == ["CPU"]


# --- the ladder, end to end --------------------------------------------------

def test_the_happy_path_runs_once_and_says_nothing(tmp_path, monkeypatch):
    log = tmp_path / "runs.jsonl"
    monkeypatch.setenv("FAKE_WHISPER_LOG", str(log))
    transcript = transcribe_wav(tmp_path)
    assert "stub transcript segment" in transcript.text
    assert transcript.notice is None
    runs = runs_from(log)
    assert len(runs) == 1, "a healthy GPU must pay for exactly one run"
    assert "--no-flash-attn" in runs[0]["argv"]


def test_a_gpu_crash_finishes_the_job_on_the_cpu(tmp_path, monkeypatch):
    """The incident, reproduced: every GPU rung dies, the CPU rung delivers."""
    log = tmp_path / "runs.jsonl"
    monkeypatch.setenv("FAKE_WHISPER_LOG", str(log))
    monkeypatch.setenv("FAKE_WHISPER_CRASH_ON", "!--no-gpu")
    transcript = transcribe_wav(tmp_path)
    assert "stub transcript segment" in transcript.text
    assert "CPU" in (transcript.notice or "")
    # The TEXT is fine — `warning` means damaged transcript and must not be
    # borrowed to mean "the machine is broken".
    assert transcript.warning is None
    runs = runs_from(log)
    assert [("--no-gpu" in r["argv"]) for r in runs] == [False, False, True]


def test_a_coopmat_crash_stays_on_the_gpu(tmp_path, monkeypatch):
    """Don't drop to the CPU when a cheaper rung would have done."""
    log = tmp_path / "runs.jsonl"
    monkeypatch.setenv("FAKE_WHISPER_LOG", str(log))
    monkeypatch.setenv("FAKE_WHISPER_CRASH_ON", "!GGML_VK_DISABLE_COOPMAT")
    transcript = transcribe_wav(tmp_path)
    assert "stub transcript segment" in transcript.text
    assert "cooperative-matrix" in (transcript.notice or "")
    runs = runs_from(log)
    assert len(runs) == 2
    assert runs[-1]["env"]["GGML_VK_DISABLE_COOPMAT"] == "1"
    assert "--no-gpu" not in runs[-1]["argv"]


def test_a_flash_attention_crash_is_survived_when_it_was_asked_for(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("FAKE_WHISPER_CRASH_ON", "--flash-attn")
    transcript = transcribe_wav(tmp_path, WHISPER_FLASH_ATTN=True)
    assert "stub transcript segment" in transcript.text
    assert "flash attention" in (transcript.notice or "")


def test_when_every_rung_crashes_the_error_says_so(tmp_path, monkeypatch):
    monkeypatch.setenv("FAKE_WHISPER_CRASH_ON", "*")
    with pytest.raises(RuntimeError) as excinfo:
        transcribe_wav(tmp_path)
    message = str(excinfo.value)
    assert "whisper.cpp failed" in message
    assert "it crashed" in message  # not "your recording is bad"
    assert "Every path was tried" in message  # and it names each of them


def test_an_ordinary_failure_is_reported_from_the_first_try(tmp_path, monkeypatch):
    """One run, no ladder, and no 'also tried' noise to read past."""
    log = tmp_path / "runs.jsonl"
    monkeypatch.setenv("FAKE_WHISPER_LOG", str(log))
    monkeypatch.setenv("FAKE_WHISPER_FAIL_ON", "*")
    with pytest.raises(RuntimeError) as excinfo:
        transcribe_wav(tmp_path)
    assert "failed to initialize whisper context" in str(excinfo.value)
    assert "Every path was tried" not in str(excinfo.value)
    assert len(runs_from(log)) == 1


def test_an_unknown_flag_is_not_mistaken_for_success(tmp_path):
    """whisper.cpp exits 0 on an argument it does not know. Handing back the
    PREVIOUS run's transcript.json at that point would put somebody else's
    meeting in these notes — so the file is cleared first and exit 0 with
    nothing written is rejected."""
    (tmp_path / "transcript.json").write_text(
        json.dumps(
            {"transcription": [{"offsets": {"from": 0, "to": 1}, "text": "stale text"}]}
        ),
        encoding="utf-8",
    )
    with pytest.raises(RuntimeError) as excinfo:
        transcribe_wav(tmp_path, WHISPER_EXTRA_ARGS="--invented-flag")
    assert "wrote no transcript.json" in str(excinfo.value)
    assert "unknown argument" in str(excinfo.value)


def test_a_rungs_own_flags_beat_whisper_extra_args(tmp_path, monkeypatch):
    """WHISPER_EXTRA_ARGS is a tuning escape hatch, not a way to disarm the
    ladder — '-fa' left in there must not survive into the fallback runs."""
    log = tmp_path / "runs.jsonl"
    monkeypatch.setenv("FAKE_WHISPER_LOG", str(log))
    monkeypatch.setenv("FAKE_WHISPER_CRASH_ON", "!--no-gpu")
    transcribe_wav(tmp_path, WHISPER_EXTRA_ARGS="-fa")
    argv = runs_from(log)[-1]["argv"]
    assert argv.index("-fa") < argv.index("--no-gpu")


# --- configuration -----------------------------------------------------------

def test_the_defaults_are_the_ones_that_worked():
    settings = Settings()
    assert settings.WHISPER_FLASH_ATTN is False
    assert settings.WHISPER_GPU is True
