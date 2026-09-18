"""AI backend that shells out to the Claude Code CLI on the home PC.

WHY THIS EXISTS. The operator's workplace network blocks AI services, so the
external-AI escape hatch has meant carrying the prompt to a phone on cellular
and pasting it into a chatbot by hand. The home PC has no such restriction —
it already reaches GitHub for updates and Gmail for delivery — so it can do
the round trip itself and the phone stops being on the critical path.

WHY THE CLI AND NOT THE API. Authentication. The CLI can sign in with an
existing Claude subscription (`claude login`, once, interactively on the home
PC), which is what the operator has. Talking to the Messages API directly
would need an API key — a separate account with separate per-token billing.

WHAT THAT COSTS. Two things worth being honest about:

  * Subscription plans have usage limits. A long meeting summarized at a busy
    time can hit one, and it surfaces here as a stage failure. That is why
    Ollama stays the default and this is opt-in: the local model always works,
    and the fallback is one setting away.
  * It depends on an interactive login persisting on that machine, under the
    account the SERVER runs as — a sign-in in another desktop session does not
    carry over. When it lapses the CLI says so and the error is passed through
    intact rather than reduced to "the AI stage failed". It says so on STDOUT,
    not stderr: see _failure_message, which is where believing otherwise cost
    a meeting.

The prompts are unchanged. summarize.py and extract.py build exactly the same
system + user text they hand Ollama, which is the same text external_prompt()
packages for a chatbot — one prompt, three transports.
"""

import asyncio
import logging
import os
import shutil
import sys

from ..config import Settings, subprocess_flags

log = logging.getLogger(__name__)

# Where the CLI installs itself when it is not on the service's PATH. A Windows
# service inherits a different environment from the desktop session that ran
# the installer, so PATH alone is not enough.
_WINDOWS_LOCATIONS = (
    r"%LOCALAPPDATA%\Programs\claude\claude.exe",
    r"%APPDATA%\npm\claude.cmd",
    r"%ProgramFiles%\Claude\claude.exe",
)

_POSIX_LOCATIONS = (
    "/usr/local/bin/claude",
    "/opt/homebrew/bin/claude",
    os.path.expanduser("~/.local/bin/claude"),
    os.path.expanduser("~/.claude/local/claude"),
)


def resolve_cli(settings: Settings) -> str | None:
    """Absolute path to the Claude CLI, or None when it isn't installed.

    Unlike bootstrap._which this returns None rather than the bare name: the
    caller needs to tell "not installed" (a setup problem, with a setup fix)
    apart from "ran and failed" (a usage problem), and a bare name that fails
    to spawn blurs the two.
    """
    configured = (settings.CLAUDE_CLI_PATH or "").strip()
    if configured:
        return configured if os.path.exists(configured) else shutil.which(configured)

    found = shutil.which("claude")
    if found:
        return found

    candidates = _WINDOWS_LOCATIONS if sys.platform == "win32" else _POSIX_LOCATIONS
    for template in candidates:
        candidate = os.path.expandvars(template)
        if "%" not in candidate and os.path.exists(candidate):
            return candidate
    return None


class ClaudeCliError(RuntimeError):
    """The CLI is missing, not logged in, or exited non-zero."""


# The CLI's own wording, mapped to the operator's next step. Matching is on
# lowercased fragments of whatever the CLI printed; anything unrecognized falls
# through and is reported verbatim, which is still an answer.
#
# MATCH STEMS, NOT SENTENCES, and prefer a string someone has actually SEEN.
# The first cut of this table guessed "oauth token has expired". What the CLI
# really says is "Failed to authenticate: OAuth session expired and could not
# be refreshed" — so on 2026-09-18 the operator got the reason with no next
# step attached, one release after the entry in CLAUDE.md about stubs encoding
# assumed behaviour. Observed strings are marked; the rest are still guesses
# and should be replaced by real ones as they are seen.
_HINTS = (
    (
        ("usage limit reached", "rate limit", "out of credits", "quota"),
        "This is the subscription's usage limit, not a broken setup — see the "
        "module docstring. It resets on its own. Either wait and press Start AI "
        "again, or set the AI provider back to Ollama on the Settings tab to "
        "get the notes now.",
    ),
    (
        (
            "authenticat",  # OBSERVED 2026-09-18: "Failed to authenticate: …"
            "oauth",  # OBSERVED 2026-09-18: "… OAuth session expired …"
            "/login",
            "log in",
            "login",
            "sign in",
            "signed in",
            "api key",
            "credential",
            "unauthorized",
            "401",
        ),
        "The Claude sign-in on this machine has lapsed — re-authorizing is the "
        "whole fix. Open a terminal on this PC, AS THE ACCOUNT THE SERVER RUNS "
        "AS, and run `claude login`. The account matters: a sign-in done in "
        "your own desktop session does not reach a service running as another "
        "user, because the credentials live in that user's profile. Until then, "
        "set the AI provider back to Ollama on the Settings tab to get this "
        "meeting's notes now — the transcript is already saved, so Start AI "
        "will redo just the AI stages.",
    ),
    (
        ("issue with the selected model", "may not exist or you may not have access"),
        "The CLI rejected the model name. Clear the Claude model box on the "
        "Settings tab to fall back to whatever the CLI is configured to use.",
    ),
)


def _hint_for(detail: str) -> str | None:
    lowered = detail.lower()
    for fragments, hint in _HINTS:
        if any(f in lowered for f in fragments):
            return hint
    return None


def _failure_message(code: int, stdout: bytes, stderr: bytes) -> str:
    """Why the CLI exited non-zero, in terms the operator can act on.

    READ STDOUT. In `-p` mode the CLI reports a FAILED turn the same way it
    reports a successful one — as its output, on stdout — and exits non-zero
    with stderr often completely empty. A handler that looked only at stderr
    therefore collapsed every ordinary failure (usage limit spent, sign-in
    lapsed, model rejected) into one useless line:

        Claude CLI failed (exit 1): no error output

    That is not a CLI that failed silently. That is a diagnosis thrown away on
    the floor. It cost a real meeting on 2026-09-16: both AI stages failed
    within seconds of each other, the reason was sitting in stdout both times,
    and the log recorded that there was no reason. Whatever this function is
    changed to do later, it must keep reading BOTH streams.
    """
    out = stdout.decode("utf-8", "replace").strip()
    err = stderr.decode("utf-8", "replace").strip()
    # stdout first: it carries the sentence written for a human to read. stderr,
    # when there is any, carries a lower-level diagnostic worth keeping behind it.
    detail = "\n".join(part for part in (out, err) if part)
    if not detail:
        return (
            f"Claude CLI failed (exit {code}) and printed nothing on either "
            "stream. Run it by hand on this machine, signed in as the account "
            "the server runs as, to see what it says: "
            "`claude -p --output-format text` with a prompt on stdin."
        )

    hint = _hint_for(detail)
    message = f"Claude CLI failed (exit {code}): {detail[-2000:]}"
    return f"{message}\n\n{hint}" if hint else message


async def _run(settings: Settings, system_prompt: str, user_prompt: str) -> str:
    exe = resolve_cli(settings)
    if not exe:
        raise ClaudeCliError(
            "The Claude CLI is not installed on this server. Install it and run "
            "`claude login` once, or set the AI provider back to Ollama on the "
            "Settings tab."
        )

    cmd = [exe, "-p", "--output-format", "text"]
    if system_prompt:
        cmd += ["--append-system-prompt", system_prompt]
    # CLAUDE_MODEL is the ONLY source of the model here. There is deliberately
    # no per-call override: the one that existed took an Ollama tag.
    chosen = (settings.CLAUDE_MODEL or "").strip()
    if chosen:
        cmd += ["--model", chosen]

    log.info("Claude CLI: %s (model=%s)", os.path.basename(exe), chosen or "default")
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            **subprocess_flags(),  # no console flash — the server is windowed
        )
    except FileNotFoundError as exc:
        raise ClaudeCliError(f"Could not launch the Claude CLI at {exe}: {exc}") from exc

    # The prompt goes on stdin, not argv: a meeting transcript is far past the
    # command-line length limit on Windows, and argv would also expose it to
    # anything that can list processes.
    try:
        stdout, stderr = await asyncio.wait_for(
            proc.communicate(user_prompt.encode("utf-8")),
            timeout=float(settings.CLAUDE_CLI_TIMEOUT_SEC),
        )
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        raise ClaudeCliError(
            f"The Claude CLI did not finish within {settings.CLAUDE_CLI_TIMEOUT_SEC}s."
        )
    except asyncio.CancelledError:
        proc.kill()  # server shutting down — don't orphan the child
        raise

    if proc.returncode != 0:
        raise ClaudeCliError(_failure_message(proc.returncode, stdout, stderr))

    text = stdout.decode("utf-8", "replace").strip()
    if not text:
        raise ClaudeCliError(
            "The Claude CLI returned nothing. If this persists, run `claude login` "
            "on this machine — an expired sign-in exits quietly."
        )
    return text


async def chat_text(
    client,  # unused: kept so the signature matches _ollama.chat_text
    settings: Settings,
    system_prompt: str,
    user_prompt: str,
    *,
    num_predict: int,  # noqa: ARG001 - Ollama sizing knobs have no CLI equivalent
    temperature: float,  # noqa: ARG001
) -> str:
    return await _run(settings, system_prompt, user_prompt)


async def chat_json(
    client,  # unused
    settings: Settings,
    system_prompt: str,
    user_prompt: str,
    *,
    num_predict: int,  # noqa: ARG001
    temperature: float,  # noqa: ARG001
):
    """One CLI turn whose reply is parsed as JSON.

    There is no `format: json` to ask for, so the instruction has to travel in
    the prompt — which every caller already does, because the same wording has
    to work for a human pasting into a chatbot. Parsing is _ollama._loads_loose,
    which strips code fences and finds the first balanced object: exactly the
    shape of a CLI answer that opens with a sentence of preamble.

    This takes NO `model` argument, matching chat_text. It used to, and callers
    passing an Ollama tag (run_live's settings.live_model) reached the CLI as
    `--model gemma4:26b`, which fails. The model for this backend comes from
    CLAUDE_MODEL and nowhere else; _provider strips the Ollama-only kwargs
    before dispatch, and this signature is the second line of defence.
    """
    from . import _ollama  # late import — sibling module, avoids a cycle

    text = await _run(settings, system_prompt, user_prompt)
    return _ollama._loads_loose(text)
