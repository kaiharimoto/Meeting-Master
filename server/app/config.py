"""Server configuration.

Reads environment variables and (optionally) ``server/server.env`` — the
git-ignored copy of ``config/server.env.example``. Environment variables take
precedence over the env file, which is what the tests rely on.

SECURITY: never log a Settings instance — it contains BEARER_TOKEN and
SMTP_APP_PASSWORD in plain text.
"""

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# server/ — the directory that contains app/, server.env, and (by default) data/.
SERVER_DIR = Path(__file__).resolve().parents[1]


def _resolve(path_str: str) -> Path:
    """Resolve a possibly-relative path against the server/ directory.

    Relative paths in server.env (e.g. ``./data``, ``../config/recipients.json``)
    must not depend on the process working directory.
    """
    path = Path(path_str)
    if path.is_absolute():
        return path
    return (SERVER_DIR / path).resolve()


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=str(SERVER_DIR / "server.env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # Shared secret checked by auth.verify_token (must match the laptop's token).
    BEARER_TOKEN: str

    # Where job data (audio, transcripts, PDFs, job.json records) is stored.
    DATA_DIR: str = "./data"

    # --- Audio normalization ---
    FFMPEG_PATH: str = "ffmpeg"

    # --- Transcription (whisper.cpp, Vulkan build, shelled out) ---
    WHISPER_CLI: str
    WHISPER_MODEL_DIR: str
    WHISPER_MODEL_DEFAULT: str = "large-v3-turbo"
    WHISPER_MODEL_FALLBACK: str = "large-v3"
    WHISPER_LANGUAGE: str = "auto"
    WHISPER_TIMEOUT_SEC: int = 3600

    # --- Summarization (native Ollama /api/chat — NOT the /v1 endpoint) ---
    OLLAMA_URL: str = "http://127.0.0.1:11434"
    OLLAMA_MODEL: str = "qwen2.5:14b-instruct-q6_K"
    NUM_CTX: int = 32768
    SUMMARY_NUM_PREDICT: int = 700
    SUMMARY_TEMPERATURE: float = 0.3

    # --- Email (Gmail SMTP with an App Password) ---
    SMTP_HOST: str = "smtp.gmail.com"
    SMTP_PORT: int = 465
    SMTP_USE_SSL: bool = True
    SMTP_USER: str = ""
    SMTP_APP_PASSWORD: str = ""
    SMTP_FROM: str = ""

    # Preset recipients + email template (relative paths resolve against server/).
    RECIPIENTS_PATH: str = "../config/recipients.json"
    EMAIL_TEMPLATE_PATH: str = "../config/email_template.txt"

    # Resolved-path accessors — always use these instead of the raw strings.
    @property
    def data_dir(self) -> Path:
        return _resolve(self.DATA_DIR)

    @property
    def recipients_path(self) -> Path:
        return _resolve(self.RECIPIENTS_PATH)

    @property
    def email_template_path(self) -> Path:
        return _resolve(self.EMAIL_TEMPLATE_PATH)


@lru_cache
def get_settings() -> Settings:
    """Cached settings accessor (tests call get_settings.cache_clear())."""
    return Settings()  # type: ignore[call-arg]  # values come from env / env file
