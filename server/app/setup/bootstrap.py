"""Dependency detection and guided install for first-run setup.

Everything here is safe to import and call on any OS: the actual Windows-only
installs are guarded by ``sys.platform`` and every external command is funneled
through :func:`_run`, so unit tests monkeypatch that single seam instead of
spawning real processes or hitting the network.

Each guided install is a background task tracked in the module-level
``TASKS`` dict::

    TASKS[name] = {"state": "idle"|"running"|"done"|"failed",
                   "progress": 0..100 | None,
                   "message": str}

The web UI polls ``/setup/state`` (which embeds ``TASKS``) to animate progress.

SECURITY: nothing here logs BEARER_TOKEN or SMTP_APP_PASSWORD.
"""

import asyncio
import json
import logging
import os
import re
import shutil
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

import httpx

from .. import config

log = logging.getLogger(__name__)

# Well-known Windows install locations for tools that are NOT reliably on PATH
# for an already-running process: Tailscale's installer doesn't add itself to
# PATH at all, and Ollama's PATH entry isn't visible to a process that started
# before Ollama was installed. Checked as a fallback after shutil.which.
_WINDOWS_LOCATIONS = {
    "ollama": [
        r"%LOCALAPPDATA%\Programs\Ollama\ollama.exe",
        r"%PROGRAMFILES%\Ollama\ollama.exe",
    ],
    "tailscale": [
        r"%PROGRAMFILES%\Tailscale\tailscale.exe",
        r"%PROGRAMFILES(X86)%\Tailscale\tailscale.exe",
    ],
}


def _which(name: str) -> str:
    """Resolve an executable to a full path via PATH, then known locations.

    Returns the bare name as a last resort so the caller still gets a clean
    "not launched" RunResult if the tool truly is not installed.
    """
    found = shutil.which(name)
    if found:
        return found
    if sys.platform == "win32":
        for template in _WINDOWS_LOCATIONS.get(name, []):
            candidate = os.path.expandvars(template)
            if "%" not in candidate and os.path.exists(candidate):
                return candidate
    return name

# --- Download URLs (kept here so they are easy to audit / update) -----------
OLLAMA_INSTALLER_URL = "https://ollama.com/download/OllamaSetup.exe"
OLLAMA_HELP_URL = "https://ollama.com/download"
TAILSCALE_INSTALLER_URL = "https://pkgs.tailscale.com/stable/tailscale-setup-latest.exe"
TAILSCALE_HELP_URL = "https://tailscale.com/download/windows"
WHISPER_MODEL_URL = (
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-{model}.bin"
)

# The `/setup/install/{component}` names the UI POSTs to, mapped to coroutines.
# Superset of the required set so the "AI transcription model" row has a target.
_COMPONENTS = {
    "ollama": "install_ollama",
    "model": "pull_model",
    "whisper-model": "download_whisper_model",
    "tailscale": "install_tailscale",
    "tailscale-up": "tailscale_up",
    "tailscale-serve": "tailscale_serve",
}

_PERCENT_RE = re.compile(r"(\d{1,3})\s*%")
_TSNET_URL_RE = re.compile(r"https://[A-Za-z0-9.\-]+\.ts\.net\S*")
_LOGIN_URL_RE = re.compile(r"https://\S*tailscale\.com/\S+")

# Set once ``tailscale serve`` succeeds; the connection code and /setup/state
# prefer it over the bare hostname URL.
_SERVE_URL: str | None = None


# --- Task state -------------------------------------------------------------
TASKS: dict[str, dict] = {}
_UNSET = object()


def _set(name: str, *, state=None, progress=_UNSET, message=None) -> dict:
    """Merge fields into a task's state, creating it if needed."""
    task = TASKS.setdefault(name, {"state": "idle", "progress": None, "message": ""})
    if state is not None:
        task["state"] = state
    if progress is not _UNSET:
        task["progress"] = progress
    if message is not None:
        task["message"] = message
    return task


def task_state(name: str) -> dict:
    return dict(TASKS.get(name, {"state": "idle", "progress": None, "message": ""}))


def all_task_states() -> dict[str, dict]:
    return {name: dict(state) for name, state in TASKS.items()}


def get_serve_url() -> str | None:
    return _SERVE_URL


# --- The single external-command seam --------------------------------------
@dataclass
class RunResult:
    returncode: int
    stdout: str
    stderr: str
    launched: bool = True  # False if the executable could not even be started

    @property
    def ok(self) -> bool:
        return self.launched and self.returncode == 0


async def _run(
    cmd: list[str],
    *,
    timeout: float = 60.0,
    cwd: str | None = None,
    on_line=None,
) -> RunResult:
    """Run an external command. The one seam tests monkeypatch.

    When ``on_line`` is given, stdout+stderr are merged and each decoded line
    is passed to it as it arrives (for progress parsing); otherwise output is
    collected in one shot with the streams kept separate.
    """
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=(
                asyncio.subprocess.STDOUT if on_line else asyncio.subprocess.PIPE
            ),
            cwd=cwd,
        )
    except (FileNotFoundError, NotADirectoryError, OSError, NotImplementedError) as exc:
        return RunResult(returncode=127, stdout="", stderr=str(exc), launched=False)

    try:
        if on_line is not None and proc.stdout is not None:
            collected: list[str] = []

            async def _pump() -> None:
                assert proc.stdout is not None
                while True:
                    raw = await proc.stdout.readline()
                    if not raw:
                        break
                    line = raw.decode("utf-8", "replace")
                    collected.append(line)
                    try:
                        on_line(line)
                    except Exception:  # a bad callback must not kill the install
                        log.debug("on_line callback raised", exc_info=True)

            await asyncio.wait_for(_pump(), timeout=timeout)
            await proc.wait()
            return RunResult(proc.returncode or 0, "".join(collected), "")

        raw_out, raw_err = await asyncio.wait_for(
            proc.communicate(), timeout=timeout
        )
        return RunResult(
            proc.returncode or 0,
            raw_out.decode("utf-8", "replace"),
            raw_err.decode("utf-8", "replace"),
        )
    except asyncio.TimeoutError:
        try:
            proc.kill()
        except ProcessLookupError:
            pass
        return RunResult(124, "", "command timed out", launched=True)


async def _download(url: str, dest: Path, task_name: str, *, timeout: float = 900.0) -> None:
    """Stream ``url`` to ``dest`` with percent progress into the task state."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    async with httpx.AsyncClient(follow_redirects=True, timeout=timeout) as client:
        async with client.stream("GET", url) as resp:
            resp.raise_for_status()
            total = int(resp.headers.get("Content-Length") or 0)
            done = 0
            with tmp.open("wb") as fh:
                async for chunk in resp.aiter_bytes(256 * 1024):
                    fh.write(chunk)
                    done += len(chunk)
                    if total:
                        _set(task_name, progress=min(100, int(done * 100 / total)))
    tmp.replace(dest)


# --- Detection --------------------------------------------------------------
async def detect() -> dict:
    """The ``deps`` sub-object of /setup/state — never raises."""
    settings = config.get_settings()
    return {
        "ollama": await _detect_ollama(settings),
        "tailscale": await _detect_tailscale(settings),
        "whisperModel": _detect_whisper_model(settings),
    }


async def _detect_ollama(settings) -> dict:
    model = settings.OLLAMA_MODEL
    try:
        res = await _run([_which("ollama"), "list"], timeout=15)
    except Exception:
        log.debug("ollama detection failed", exc_info=True)
        return {"installed": False, "modelPresent": False, "model": model}
    installed = res.ok
    model_present = bool(installed and model and model in res.stdout)
    return {"installed": installed, "modelPresent": model_present, "model": model}


async def _detect_tailscale(settings) -> dict:
    result = {"installed": False, "loggedIn": False, "serveUrl": _SERVE_URL}
    try:
        status = await _run([_which("tailscale"), "status", "--json"], timeout=15)
    except Exception:
        log.debug("tailscale detection failed", exc_info=True)
        return result
    if not status.launched:
        return result  # not installed; keep any serve URL we already have
    result["installed"] = True
    data: dict = {}
    try:
        data = json.loads(status.stdout or "{}")
    except json.JSONDecodeError:
        data = {}
    result["loggedIn"] = data.get("BackendState") == "Running"
    result["serveUrl"] = _SERVE_URL or await _resolve_serve_url(settings, status_data=data)
    return result


def _detect_whisper_model(settings) -> dict:
    model = settings.WHISPER_MODEL_DEFAULT
    present = (settings.models_dir / f"ggml-{model}.bin").exists()
    return {"present": present, "name": model}


async def _resolve_serve_url(settings, *, status_data: dict | None = None) -> str | None:
    """Best-effort https://<host>.<tailnet>.ts.net URL for the served port."""
    try:
        serve = await _run([_which("tailscale"), "serve", "status"], timeout=15)
    except Exception:
        serve = RunResult(127, "", "", launched=False)
    if serve.launched and serve.stdout:
        match = _TSNET_URL_RE.search(serve.stdout)
        if match:
            return match.group(0).rstrip("/")
    if status_data is None:
        try:
            status = await _run([_which("tailscale"), "status", "--json"], timeout=15)
            status_data = json.loads(status.stdout or "{}") if status.launched else {}
        except Exception:
            status_data = {}
    dns_name = (status_data or {}).get("Self", {}).get("DNSName") or ""
    dns_name = dns_name.rstrip(".")
    if dns_name:
        return f"https://{dns_name}"
    return None


# --- Guided installs (each is a background task) ---------------------------
async def install_ollama() -> None:
    name = "ollama"
    if sys.platform != "win32":
        _set(
            name,
            state="failed",
            progress=None,
            message=(
                "Automatic install is Windows-only on this build. Install Ollama "
                f"manually: {OLLAMA_HELP_URL}"
            ),
        )
        return
    try:
        _set(name, state="running", progress=None, message="Downloading Ollama installer…")
        dest = Path(tempfile.gettempdir()) / "OllamaSetup.exe"
        await _download(OLLAMA_INSTALLER_URL, dest, name)
        _set(name, progress=None, message="Running the Ollama installer…")
        res = await _run([str(dest), "/VERYSILENT", "/NORESTART"], timeout=1200)
        if not res.ok:
            _set(
                name,
                state="failed",
                message=f"Installer did not finish. Install manually: {OLLAMA_HELP_URL}",
            )
            return
        _set(name, state="done", progress=100, message="Ollama installed.")
    except Exception as exc:
        _set(name, state="failed", message=f"{exc} — install manually: {OLLAMA_HELP_URL}")


async def pull_model() -> None:
    name = "model"
    settings = config.get_settings()
    model = settings.OLLAMA_MODEL
    _set(name, state="running", progress=0, message=f"Downloading AI model {model}…")

    def on_line(line: str) -> None:
        match = _PERCENT_RE.search(line)
        if match:
            try:
                _set(name, progress=min(100, int(match.group(1))))
            except ValueError:
                pass

    try:
        res = await _run([_which("ollama"), "pull", model], timeout=7200, on_line=on_line)
    except Exception as exc:
        _set(name, state="failed", message=str(exc))
        return
    if not res.launched:
        _set(
            name,
            state="failed",
            message=f"Ollama is not installed yet — install it first. {OLLAMA_HELP_URL}",
        )
        return
    if res.returncode != 0:
        tail = (res.stderr or res.stdout or "").strip()[-300:]
        _set(name, state="failed", message=f"'ollama pull {model}' failed. {tail}")
        return
    _set(name, state="done", progress=100, message=f"AI model {model} is ready.")


async def install_tailscale() -> None:
    name = "tailscale"
    if sys.platform != "win32":
        _set(
            name,
            state="failed",
            progress=None,
            message=(
                "Automatic install is Windows-only on this build. Install Tailscale "
                f"manually: {TAILSCALE_HELP_URL}"
            ),
        )
        return
    try:
        _set(name, state="running", progress=None, message="Downloading Tailscale installer…")
        dest = Path(tempfile.gettempdir()) / "tailscale-setup.exe"
        await _download(TAILSCALE_INSTALLER_URL, dest, name)
        _set(name, progress=None, message="Running the Tailscale installer…")
        res = await _run([str(dest), "/S"], timeout=1200)
        if not res.ok:
            _set(
                name,
                state="failed",
                message=f"Installer did not finish. Install manually: {TAILSCALE_HELP_URL}",
            )
            return
        _set(
            name,
            state="done",
            progress=100,
            message="Tailscale installed. Next: sign in and enable remote access.",
        )
    except Exception as exc:
        _set(name, state="failed", message=f"{exc} — install manually: {TAILSCALE_HELP_URL}")


async def tailscale_up() -> None:
    name = "tailscale-up"
    _set(name, state="running", progress=None, message="Starting Tailscale sign-in…")

    def on_line(line: str) -> None:
        match = _LOGIN_URL_RE.search(line)
        if match:
            _set(name, message=f"Open this link in a browser to sign in: {match.group(0)}")

    try:
        res = await _run([_which("tailscale"), "up"], timeout=600, on_line=on_line)
    except Exception as exc:
        _set(name, state="failed", message=str(exc))
        return
    if not res.launched:
        _set(
            name,
            state="failed",
            message=f"Tailscale is not installed yet — install it first. {TAILSCALE_HELP_URL}",
        )
        return
    if res.returncode != 0:
        tail = (res.stdout or res.stderr or "").strip()[-300:]
        _set(name, state="failed", message=f"'tailscale up' did not complete. {tail}")
        return
    _set(name, state="done", progress=100, message="Signed in to Tailscale.")


async def tailscale_serve() -> None:
    global _SERVE_URL
    name = "tailscale-serve"
    settings = config.get_settings()
    port = settings.SERVER_PORT
    _set(name, state="running", progress=None, message="Enabling secure remote access…")
    try:
        res = await _run([_which("tailscale"), "serve", "--bg", str(port)], timeout=120)
    except Exception as exc:
        _set(name, state="failed", message=str(exc))
        return
    if not res.launched:
        _set(
            name,
            state="failed",
            message=f"Tailscale is not installed yet — install it first. {TAILSCALE_HELP_URL}",
        )
        return
    if res.returncode != 0:
        tail = (res.stderr or res.stdout or "").strip()[-300:]
        _set(name, state="failed", message=f"'tailscale serve' failed. {tail}")
        return
    url = await _resolve_serve_url(settings)
    _SERVE_URL = url
    if url:
        _set(name, state="done", progress=100, message=f"Remote access ready at {url}")
    else:
        _set(name, state="done", progress=100, message="Remote access enabled.")


async def download_whisper_model() -> None:
    name = "whisper-model"
    settings = config.get_settings()
    model = settings.WHISPER_MODEL_DEFAULT
    dest = settings.models_dir / f"ggml-{model}.bin"
    url = WHISPER_MODEL_URL.format(model=model)
    _set(name, state="running", progress=0, message=f"Downloading transcription model {model}…")
    try:
        settings.models_dir.mkdir(parents=True, exist_ok=True)
        await _download(url, dest, name, timeout=7200)
    except Exception as exc:
        _set(name, state="failed", message=f"Download failed: {exc}")
        return
    _set(name, state="done", progress=100, message=f"Transcription model {model} is ready.")


# --- Background launcher ----------------------------------------------------
def start(component: str) -> tuple[bool, dict]:
    """Launch the install task for ``component`` (idempotent while running).

    Returns ``(started, task_state)``. ``started`` is False if the component is
    unknown or already running.
    """
    func_name = _COMPONENTS.get(component)
    if func_name is None:
        return False, {"state": "failed", "progress": None, "message": f"Unknown component: {component}"}

    current = TASKS.get(component)
    if current and current.get("state") == "running":
        return False, dict(current)

    coro_fn = globals()[func_name]
    _set(component, state="running", progress=None, message="Starting…")

    async def _runner() -> None:
        try:
            await coro_fn()
            if TASKS.get(component, {}).get("state") == "running":
                _set(component, state="done", progress=100)
        except Exception as exc:  # backstop — install functions handle their own
            log.exception("Setup task %s crashed", component)
            _set(component, state="failed", message=str(exc) or exc.__class__.__name__)

    asyncio.create_task(_runner())
    return True, dict(TASKS[component])
