"""Audio -> transcript -> summary pipeline stages."""

import sys


def resolve_tool(path: str) -> list[str]:
    """Turn a configured tool path into an argv prefix.

    If the configured path is a Python script (ends with '.py'), run it through
    the current interpreter. This exists so tests — and any dev machine without
    the real ffmpeg / whisper-cli binaries — can point FFMPEG_PATH / WHISPER_CLI
    at argv-compatible Python stubs: a .py file is not directly executable via
    exec() on Windows (no shebang support), and we never use shell=True.
    """
    if path.endswith(".py"):
        return [sys.executable, path]
    return [path]


def stderr_tail(stderr: bytes, limit: int = 2000) -> str:
    """Last `limit` chars of a subprocess's stderr, for readable error messages."""
    return stderr.decode("utf-8", errors="replace")[-limit:].strip()
