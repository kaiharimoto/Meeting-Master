#!/usr/bin/env python3
"""argv-compatible whisper-cli stub for tests.

Finds the '-of <base>' argument and writes <base>.json with a canned payload
in whisper.cpp's -oj output shape (offsets in MILLISECONDS). A '-m <model>'
argument may or may not be present — and the model file need not exist —
this stub does not care, just like the tests require.

It also imitates the three behaviours transcribe.py's fallback ladder is built
around, so the ladder is tested through real subprocesses rather than mocks:

  * ``--help`` prints a usage block naming the long flags, because that is how
    the pipeline decides whether a flag is safe to pass.
  * an unknown argument prints "error: unknown argument" and exits **0** with
    no output file — whisper.cpp's genuinely surprising behaviour.
  * ``FAKE_WHISPER_CRASH_ON`` (a comma-separated list of flags/env keys) makes
    the stub die the way a shader bug dies when the run matches, so a test can
    crash the GPU rungs and check the CPU rung picks it up.
  * ``FAKE_WHISPER_FAIL_ON`` matches the same way but produces an ordinary
    non-zero exit — the failure that must NOT be retried.
  * ``FAKE_WHISPER_LOG`` names a file each run appends its argv and the ggml
    environment to, so a test can assert what was actually invoked.
"""

import json
import os
import signal
import sys

PAYLOAD = {
    "transcription": [
        {
            "offsets": {"from": 0, "to": 4200},
            "text": " This is a stub transcript segment.",
        },
        {
            "offsets": {"from": 4200, "to": 9000},
            "text": " It covers the whole fake meeting.",
        },
    ]
}

# The long flags this stub claims to understand — the same set a whisper.cpp
# v1.8.0+ build advertises for the paths the pipeline steers with.
KNOWN_LONG = (
    "--help",
    "--model",
    "--file",
    "--output-json",
    "--output-file",
    "--language",
    "--print-progress",
    "--max-context",
    "--flash-attn",
    "--no-flash-attn",
    "--no-gpu",
    "--prompt",
)

KNOWN_SHORT = ("-m", "-f", "-oj", "-of", "-l", "-mc", "-h", "-fa", "-nfa", "-ng", "-np")

# Flags that take a value, so the stub can skip past it while validating.
TAKES_VALUE = ("-m", "-f", "-of", "-l", "-mc", "--prompt")

# STATUS_ILLEGAL_INSTRUCTION — the code the AMD Vulkan flash-attention crash
# produced on the operator's machine. Exercised via FAKE_WHISPER_CRASH_ON.
CRASH_EXIT = 0xC000001D


def print_usage() -> None:
    print("usage: whisper-cli [options] file0 file1 ...", file=sys.stderr)
    for flag in KNOWN_LONG:
        print(f"  {flag}", file=sys.stderr)


def matches(spec: str, argv: list[str]) -> bool:
    """True when this run matches a comma-separated condition list.

    Each condition is matched against the argv AND the environment, so a test
    can single out "every run carrying --flash-attn", or — with a leading '!' —
    "every run that is NOT carrying --no-gpu", which is how one rung of the
    fallback ladder is made the only one that works. '*' matches every run.
    """
    conditions = [c.strip() for c in spec.split(",") if c.strip()]
    for condition in conditions:
        if condition == "*":
            return True
        negated = condition.startswith("!")
        name = condition[1:] if negated else condition
        present = name in argv or name in os.environ
        if present != negated:
            return True
    return False


def crash() -> int:
    """Die the way a Vulkan shader bug dies: no error, just a dead process.

    Windows reports the unhandled exception as its NTSTATUS code; POSIX has no
    equivalent (exit statuses are 8 bits, so returning one would arrive as 29),
    so raise the matching signal instead and let the parent see returncode -4.
    """
    print("ggml_vulkan: Found 1 Vulkan devices:", file=sys.stderr)
    print("whisper_backend_init_gpu: using Vulkan0 backend", file=sys.stderr)
    sys.stderr.flush()
    if sys.platform == "win32":
        return CRASH_EXIT
    signal.signal(signal.SIGILL, signal.SIG_DFL)
    os.kill(os.getpid(), signal.SIGILL)
    return CRASH_EXIT  # not reached


def record_run(argv: list[str]) -> None:
    """Append this invocation to FAKE_WHISPER_LOG, if a test asked for one."""
    log_path = os.environ.get("FAKE_WHISPER_LOG")
    if not log_path:
        return
    entry = {
        "argv": argv,
        "env": {k: v for k, v in os.environ.items() if k.startswith("GGML_")},
    }
    with open(log_path, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(entry) + "\n")


def main() -> int:
    argv = sys.argv[1:]

    if "-h" in argv or "--help" in argv:
        print_usage()
        return 0

    record_run(argv)

    # whisper.cpp prints usage and exits 0 on an argument it does not know —
    # the reason the pipeline probes --help instead of guessing.
    index = 0
    while index < len(argv):
        arg = argv[index]
        if arg.startswith("-") and arg not in KNOWN_LONG and arg not in KNOWN_SHORT:
            print(f"error: unknown argument: {arg}", file=sys.stderr)
            print_usage()
            return 0
        index += 2 if arg in TAKES_VALUE else 1

    if matches(os.environ.get("FAKE_WHISPER_CRASH_ON", ""), argv):
        return crash()

    if matches(os.environ.get("FAKE_WHISPER_FAIL_ON", ""), argv):
        # An error whisper.cpp understood and reported — a missing model file,
        # unreadable audio. Identical on every rung, so it must not be retried.
        print("error: failed to initialize whisper context", file=sys.stderr)
        return 3

    try:
        out_base = argv[argv.index("-of") + 1]
    except (ValueError, IndexError):
        print("fake_whisper: missing -of <base> argument", file=sys.stderr)
        return 2
    with open(out_base + ".json", "w", encoding="utf-8") as fh:
        json.dump(PAYLOAD, fh)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
