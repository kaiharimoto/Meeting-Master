"""Server configuration.

Settings come from (in order of precedence): environment variables, then a
``server.env`` file in the config home, then built-in defaults. The config home
is a writable per-user directory — NOT the (read-only when installed) program
folder — so the first-run setup page can save settings there:

  * Windows:  %APPDATA%\\MeetingMaster
  * other:    $XDG_CONFIG_HOME/MeetingMaster (or ~/.config/MeetingMaster)
  * override: the MEETING_MASTER_HOME environment variable

When the server runs as a PyInstaller-bundled .exe, ffmpeg and whisper-cli are
shipped inside the bundle (``<bundle>/bin``) and used automatically; in a dev
checkout they fall back to whatever is on PATH.

SECURITY: never log a Settings instance — it holds BEARER_TOKEN and
SMTP_APP_PASSWORD in plain text.
"""

import os
import sys
from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# server/ — the dev checkout root (contains app/). Only used as a path anchor
# for relative overrides in a source checkout.
SERVER_DIR = Path(__file__).resolve().parents[1]

# Surfaced by /health and the dashboards. Keep in step with app/package.json.
APP_VERSION = "0.20.0"


def config_home() -> Path:
    """The writable directory holding server.env, models/, data/, etc."""
    override = os.environ.get("MEETING_MASTER_HOME")
    if override:
        return Path(override)
    if sys.platform == "win32":
        base = os.environ.get("APPDATA") or str(Path.home() / "AppData" / "Roaming")
        return Path(base) / "MeetingMaster"
    base = os.environ.get("XDG_CONFIG_HOME") or str(Path.home() / ".config")
    return Path(base) / "MeetingMaster"


def subprocess_flags() -> dict:
    """Keyword args for subprocess spawns that suppress a console window.

    The server runs as a windowed (no-console) app, so every child process it
    launches (ollama, tailscale, ffmpeg, whisper-cli) would otherwise briefly
    flash a console window — many per second while the setup page polls for
    dependency status. CREATE_NO_WINDOW prevents that on Windows; no-op elsewhere.
    """
    if sys.platform == "win32":
        return {"creationflags": 0x08000000}  # subprocess.CREATE_NO_WINDOW
    return {}


def bundle_dir() -> Path | None:
    """The PyInstaller bundle root when frozen, else None (dev checkout)."""
    if getattr(sys, "frozen", False):
        return Path(getattr(sys, "_MEIPASS", str(Path(sys.executable).parent)))
    return None


def _bundled_tool(command: str, exe: str) -> str:
    """Absolute path to a bundled tool when frozen, else the bare command."""
    root = bundle_dir()
    if root is not None:
        candidate = root / "bin" / exe
        if candidate.exists():
            return str(candidate)
    return command


_HOME = config_home()
ENV_FILE = _HOME / "server.env"


def _resolve(path_str: str) -> Path:
    """Resolve a possibly-relative path. Relative paths anchor to the config
    home (or, in a dev checkout, still work against server/ for the old
    ``../config`` style)."""
    path = Path(path_str)
    if path.is_absolute():
        return path
    return (_HOME / path).resolve()


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=str(ENV_FILE),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # Shared secret checked by auth.verify_token (must match the laptop's
    # token). EMPTY means "not configured yet" — the server runs in setup mode.
    BEARER_TOKEN: str = ""

    # Where job data (audio, transcripts, PDFs, job.json records) is stored.
    DATA_DIR: str = str(_HOME / "data")

    # --- Audio normalization (bundled ffmpeg when frozen) ---
    FFMPEG_PATH: str = _bundled_tool("ffmpeg", "ffmpeg.exe")

    # --- Transcription (whisper.cpp, Vulkan build, shelled out) ---
    WHISPER_CLI: str = _bundled_tool("whisper-cli", "whisper-cli.exe")
    WHISPER_MODEL_DIR: str = str(_HOME / "models")
    WHISPER_MODEL_DEFAULT: str = "large-v3-turbo"
    WHISPER_MODEL_FALLBACK: str = "large-v3"
    WHISPER_LANGUAGE: str = "auto"
    WHISPER_TIMEOUT_SEC: int = 3600
    # Tokens of PREVIOUS transcript whisper.cpp carries into the next window.
    # 0 disables it, and 0 is the default here on purpose: carry-over is the
    # engine of whisper's repetition loops. Once it emits "I don't know", that
    # text is in the prompt for the next window, which makes "I don't know"
    # likelier again — and a stretch of quiet audio turns into pages of it.
    # whisper.cpp's own default (-1, keep everything) trades exactly this risk
    # for slightly better continuity across window boundaries; for meeting
    # audio with real silences in it, that is the wrong side of the trade.
    WHISPER_MAX_CONTEXT: int = 0
    # Extra whisper-cli flags, appended verbatim (shell-style splitting). An
    # escape hatch for tuning thresholds (-et, -lpt, …) or enabling VAD on a
    # build that has it, without waiting for a release.
    WHISPER_EXTRA_ARGS: str = ""

    # --- Which model writes the notes ---
    # "ollama" (default) or "claude_cli". Ollama is the default because it
    # needs no account, no internet, and no sign-in that can lapse — the
    # premise of a self-hosted pipeline. "claude_cli" shells out to the Claude
    # Code CLI on this machine, authenticated once with `claude login` against
    # an existing subscription; it exists because the operator's WORK network
    # blocks AI services while this machine's does not, so the home PC can do
    # the round trip that otherwise means retyping a prompt on a phone.
    # See pipeline/_claude_cli.py for the trade-offs (usage limits, sign-in).
    AI_PROVIDER: str = "ollama"
    # Blank = find it on PATH, then the usual install locations. Set this when
    # the service's PATH differs from the desktop session that installed it,
    # which on Windows it usually does.
    CLAUDE_CLI_PATH: str = ""
    # Blank = whatever the CLI is configured to use.
    CLAUDE_MODEL: str = ""
    # Generous: a whole-meeting summary is one long call, and the cost of
    # waiting is lower than the cost of giving up on a finished meeting.
    CLAUDE_CLI_TIMEOUT_SEC: int = 900

    # --- Summarization + Q&A extraction (native Ollama /api/chat, NOT /v1) ---
    OLLAMA_URL: str = "http://127.0.0.1:11434"
    OLLAMA_MODEL: str = "gemma4:26b"
    NUM_CTX: int = 32768
    # Structured summary output (Key Takeaways / Key Insights / Decisions /
    # Action Items / Key Figures / Topics) — six sections including a table need
    # real room.
    SUMMARY_NUM_PREDICT: int = 1400
    SUMMARY_TEMPERATURE: float = 0.3
    # Q&A extraction returns a JSON list — size it for a meeting's worth of
    # question/answer pairs; keep the temperature low for faithful extraction.
    EXTRACT_NUM_PREDICT: int = 1500
    EXTRACT_TEMPERATURE: float = 0.2
    # Turn a reasoning model's thinking OFF for these calls. Every stage asks
    # for strict JSON with a small output budget, and a thinking model spends
    # that budget on reasoning instead — which looks like "the summary failed"
    # when the model is working fine. Only sent to models that advertise the
    # capability (Ollama errors on the rest), so this is safe to leave on.
    OLLAMA_DISABLE_THINKING: bool = True

    # --- Mid-meeting live suggestions (POST /live/questions) ---
    # Q&A pairs AND key insights the operator can approve while the meeting is
    # still running. The LAPTOP asks this server how to drive the loop (GET
    # /live/config), so the whole feature is configured HERE, in one place, on
    # the dashboard's Settings tab.
    LIVE_SUGGESTIONS: bool = True
    # Blank means "use OLLAMA_MODEL". Point this at a SMALLER installed model
    # when the summary model can't answer inside a meeting — a tick that takes
    # longer than the interval is a tick the operator never sees.
    LIVE_MODEL: str = ""
    # How often the laptop asks (seconds), and how much of its rough live
    # transcript it sends. A small window keeps the round-trip in seconds.
    LIVE_INTERVAL_SEC: int = 45
    LIVE_WINDOW_CHARS: int = 4000
    # Server-side budget for one live call. The laptop derives its own HTTP
    # timeout from this (this + margin) so the client can never give up on a
    # request the server is still working on — the bug that made live
    # suggestions look permanently broken.
    LIVE_TIMEOUT_SEC: int = 90
    # Keep the live model resident in VRAM between ticks. A cold model load is
    # the single biggest reason a mid-meeting call blows its budget.
    LIVE_KEEP_ALIVE_MIN: int = 30
    # A small answer budget so results come back while the conversation is
    # still on the same subject.
    LIVE_EXTRACT_NUM_PREDICT: int = 600

    # --- Email (Gmail SMTP with an App Password) ---
    SMTP_HOST: str = "smtp.gmail.com"
    SMTP_PORT: int = 465
    SMTP_USE_SSL: bool = True
    SMTP_USER: str = ""
    SMTP_APP_PASSWORD: str = ""
    SMTP_FROM: str = ""

    # Preset recipients + email template (default to the config home).
    RECIPIENTS_PATH: str = str(_HOME / "recipients.json")
    EMAIL_TEMPLATE_PATH: str = str(_HOME / "email_template.txt")

    # --- Networking (surfaced on the setup page) ---
    SERVER_PORT: int = 8080

    # --- Auto-updates ---
    # GitHub repo the release installers come from, and an optional token for
    # private repos (fine-grained PAT with contents:read on that one repo —
    # set it on the dashboard's Settings tab; not needed if releases are
    # public). The server checks/downloads; the laptop updates FROM the server.
    UPDATE_REPO: str = "kaiharimoto/Meeting-Master"
    GITHUB_TOKEN: str = ""
    UPDATE_CHECK_HOURS: float = 6.0

    # Resolved-path accessors — always use these instead of the raw strings.
    @property
    def data_dir(self) -> Path:
        return _resolve(self.DATA_DIR)

    @property
    def models_dir(self) -> Path:
        return _resolve(self.WHISPER_MODEL_DIR)

    @property
    def recipients_path(self) -> Path:
        return _resolve(self.RECIPIENTS_PATH)

    @property
    def email_template_path(self) -> Path:
        return _resolve(self.EMAIL_TEMPLATE_PATH)

    @property
    def live_model(self) -> str:
        """The model the mid-meeting live path uses (falls back to the summary
        model). Always read the live model through here."""
        return self.LIVE_MODEL.strip() or self.OLLAMA_MODEL

    @property
    def live_keep_alive(self) -> str:
        """Ollama ``keep_alive`` for live calls, as a duration string."""
        return f"{max(0, int(self.LIVE_KEEP_ALIVE_MIN))}m"

    @property
    def is_configured(self) -> bool:
        """Configured enough to leave setup mode and accept jobs."""
        return bool(self.BEARER_TOKEN.strip())


# Keys the setup page is allowed to write to server.env, in file order.
WRITABLE_KEYS = (
    "BEARER_TOKEN",
    "AI_PROVIDER",
    "CLAUDE_CLI_PATH",
    "CLAUDE_MODEL",
    "CLAUDE_CLI_TIMEOUT_SEC",
    "OLLAMA_MODEL",
    "OLLAMA_URL",
    "NUM_CTX",
    "SUMMARY_NUM_PREDICT",
    "SUMMARY_TEMPERATURE",
    "EXTRACT_NUM_PREDICT",
    "EXTRACT_TEMPERATURE",
    "LIVE_SUGGESTIONS",
    "LIVE_MODEL",
    "LIVE_INTERVAL_SEC",
    "LIVE_WINDOW_CHARS",
    "LIVE_TIMEOUT_SEC",
    "LIVE_KEEP_ALIVE_MIN",
    "LIVE_EXTRACT_NUM_PREDICT",
    "WHISPER_MODEL_DEFAULT",
    "SMTP_USER",
    "SMTP_APP_PASSWORD",
    "SMTP_FROM",
    "SERVER_PORT",
    "GITHUB_TOKEN",
)


def write_env(values: dict) -> None:
    """Persist selected settings to the config home's server.env.

    Merges with any existing file so unrelated keys are preserved, then clears
    the settings cache so the running server picks the changes up immediately.
    """
    _HOME.mkdir(parents=True, exist_ok=True)
    existing: dict[str, str] = {}
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            existing[key.strip()] = val
    for key, val in values.items():
        existing[key] = "" if val is None else str(val)
    lines = [
        "# Meeting Master home server settings — written by the setup page.",
        "# Edit through the setup page (http://127.0.0.1:8080/setup) when possible.",
    ]
    lines += [f"{key}={existing[key]}" for key in existing]
    ENV_FILE.write_text("\n".join(lines) + "\n", encoding="utf-8")
    get_settings.cache_clear()


@lru_cache
def get_settings() -> Settings:
    """Cached settings accessor (tests call get_settings.cache_clear())."""
    return Settings()  # type: ignore[call-arg]  # values come from env / env file
