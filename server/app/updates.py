"""Auto-updates: the home server is the update hub for the whole system.

- check_updates(): queries GitHub Releases for the configured repo (private
  repos need GITHUB_TOKEN — a fine-grained PAT with contents:read, entered on
  the dashboard; public repos work tokenless), picks the newest non-draft
  release (our releases are pre-releases, so /releases/latest is useless),
  and caches its installers + latest.yml under <config home>/updates/<tag>/.
- The LAPTOP updates itself from this cache via the bearer-gated
  /updates/laptop/* endpoints (electron-updater generic feed) — the laptop
  never needs GitHub access.
- apply_server_update(): silently installs the cached server installer and
  restarts (frozen Windows builds only).

Both long-running operations run through the setup task machinery
(bootstrap.TASKS + register_component) so the dashboard's existing progress
bars and install buttons drive them unchanged. A background loop re-checks
every UPDATE_CHECK_HOURS.
"""

import asyncio
import logging
import os
import re
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

import httpx

from . import config
from .config import APP_VERSION, get_settings
from .setup import bootstrap

log = logging.getLogger(__name__)

CHECK_TASK = "update-check"
APPLY_TASK = "server-update"

LAPTOP_YML = "latest.yml"
SERVER_ASSET = "MeetingMaster-HomeServer-Setup.exe"
# Installer + its .blockmap (electron-updater downloads the blockmap first to
# do a differential update; a 404 there forces a slow full re-download).
_LAPTOP_EXE_RE = re.compile(r"^MeetingMaster-Setup-[\w.\-]+\.exe(\.blockmap)?$")
_VERSION_RE = re.compile(r"v?(\d+)\.(\d+)\.(\d+)")

# Latest known-release info (refreshed by check_updates; safe to serve stale).
_info: dict = {
    "current": APP_VERSION,
    "latest": None,       # e.g. "0.3.0" once known
    "tag": None,          # e.g. "v0.3.0"
    "checkedAt": None,
    "serverReady": False, # server installer cached and newer than current
    "laptopReady": False, # laptop latest.yml + exe cached
    "error": None,
}


def parse_version(text: str) -> tuple | None:
    m = _VERSION_RE.search(text or "")
    return tuple(int(g) for g in m.groups()) if m else None


def updates_dir() -> Path:
    return config.config_home() / "updates"


def _tag_dir(tag: str) -> Path:
    return updates_dir() / tag


def laptop_dir() -> Path | None:
    """Newest cached update dir that contains the laptop feed (latest.yml)."""
    root = updates_dir()
    if not root.is_dir():
        return None
    best: tuple | None = None
    best_dir: Path | None = None
    for child in root.iterdir():
        version = parse_version(child.name)
        if version is None or not (child / LAPTOP_YML).is_file():
            continue
        if best is None or version > best:
            best, best_dir = version, child
    return best_dir


def is_sidecar() -> bool:
    """True when the Meeting Master app spawned this server as its sidecar —
    the app then owns installing updates (electron-updater), not us.
    Exactly "1", matching what the app's serverManager sets."""
    return os.environ.get("MM_SIDECAR") == "1"


def snapshot() -> dict:
    """The `updates` object embedded in /setup/state."""
    return {**_info, "laptopReady": laptop_dir() is not None,
            "sidecar": is_sidecar()}


# ---- GitHub ----------------------------------------------------------------

def _github_headers(settings) -> dict:
    headers = {
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "MeetingMaster-HomeServer",
    }
    if settings.GITHUB_TOKEN:
        headers["Authorization"] = f"Bearer {settings.GITHUB_TOKEN}"
    return headers


async def _fetch_releases(settings) -> list[dict]:
    url = f"https://api.github.com/repos/{settings.UPDATE_REPO}/releases?per_page=10"
    timeout = httpx.Timeout(30.0, connect=10.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.get(url, headers=_github_headers(settings))
        resp.raise_for_status()
        data = resp.json()
        return data if isinstance(data, list) else []


def pick_best_release(releases: list[dict]) -> dict | None:
    """Newest non-draft release by semver tag (pre-releases count — all of
    this project's releases are marked pre-release)."""
    best = None
    best_version: tuple | None = None
    for release in releases:
        if release.get("draft"):
            continue
        version = parse_version(release.get("tag_name") or "")
        if version is None:
            continue
        if best_version is None or version > best_version:
            best, best_version = release, version
    return best


def _wanted_assets(release: dict) -> list[dict]:
    wanted = []
    for asset in release.get("assets") or []:
        name = asset.get("name") or ""
        if name == LAPTOP_YML or name == SERVER_ASSET or _LAPTOP_EXE_RE.match(name):
            wanted.append(asset)
    return wanted


async def check_updates() -> None:
    """The `update-check` task: find the newest release and cache its assets."""
    settings = get_settings()
    bootstrap._set(CHECK_TASK, state="running", progress=None,
                   message=f"Checking {settings.UPDATE_REPO} for releases…")
    try:
        releases = await _fetch_releases(settings)
    except httpx.HTTPStatusError as exc:
        code = exc.response.status_code
        hint = (
            " — add a GitHub token on the Settings tab (the repo is private)"
            if code in (401, 403, 404) and not settings.GITHUB_TOKEN
            else " — check the GitHub token on the Settings tab" if code in (401, 403)
            else ""
        )
        _info["error"] = f"GitHub answered HTTP {code}{hint}"
        bootstrap._set(CHECK_TASK, state="failed", message=_info["error"])
        return
    except Exception as exc:
        _info["error"] = f"Could not reach GitHub: {exc}"
        bootstrap._set(CHECK_TASK, state="failed", message=_info["error"])
        return

    best = pick_best_release(releases)
    if best is None:
        _info["error"] = "No published releases found."
        bootstrap._set(CHECK_TASK, state="failed", message=_info["error"])
        return

    tag = best.get("tag_name") or ""
    latest = parse_version(tag)
    current = parse_version(APP_VERSION)
    _info.update({
        "latest": ".".join(map(str, latest)) if latest else None,
        "tag": tag,
        "checkedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "error": None,
    })

    # Cache the best release's assets even when it matches the server's own
    # version: a freshly-updated server must still be able to update laptops.
    dest = _tag_dir(tag)
    assets = _wanted_assets(best)
    if not assets:
        _info["error"] = f"Release {tag} has no installer assets."
        bootstrap._set(CHECK_TASK, state="failed", message=_info["error"])
        return

    # latest.yml is the feed marker laptop_dir() keys on — download it LAST so
    # a dir only ever becomes servable once every installer it names exists.
    missing = [a for a in assets if not (dest / a["name"]).is_file()]
    missing.sort(key=lambda a: a["name"] == LAPTOP_YML)
    try:
        for index, asset in enumerate(missing, start=1):
            bootstrap._set(CHECK_TASK, progress=None,
                           message=f"Downloading {asset['name']} ({index}/{len(missing)})…")
            # Private repos need the API asset URL + octet-stream Accept; public
            # repos can use either (the API URL works tokenless too).
            headers = _github_headers(settings)
            headers["Accept"] = "application/octet-stream"
            await bootstrap._download(asset["url"], dest / asset["name"], CHECK_TASK,
                                      headers=headers)
    except Exception as exc:
        # A wedged "running" task would block every future check (periodic AND
        # the dashboard button) — always land in a terminal state.
        _info["error"] = f"Download failed: {exc}"
        bootstrap._set(CHECK_TASK, state="failed", message=_info["error"])
        return

    _prune_old_caches(keep=tag)

    _info["serverReady"] = bool(
        latest and current and latest > current and (dest / SERVER_ASSET).is_file()
    )
    if latest and current and latest > current:
        message = f"Update available: {tag} (you are on v{APP_VERSION}). Assets cached."
    else:
        message = f"Up to date (v{APP_VERSION}). Laptop update feed cached."
    bootstrap._set(CHECK_TASK, state="done", progress=100, message=message)


def _prune_old_caches(keep: str) -> None:
    root = updates_dir()
    if not root.is_dir():
        return
    for child in root.iterdir():
        if child.is_dir() and child.name != keep:
            try:
                for item in child.rglob("*"):
                    if item.is_file():
                        item.unlink()
                for item in sorted(child.rglob("*"), reverse=True):
                    item.rmdir()
                child.rmdir()
            except OSError:
                log.debug("Could not prune old update cache %s", child, exc_info=True)


# ---- Server self-update -----------------------------------------------------

def _active_jobs() -> int:
    from .main import get_store  # late import — main imports this module

    terminal = {"ready", "pdf_received", "emailed", "failed"}
    count = 0
    for record in get_store().list():
        state = record.state.value if hasattr(record.state, "value") else str(record.state)
        if state not in terminal:
            count += 1
    return count


async def apply_server_update() -> None:
    """The `server-update` task: silent-install the cached installer, restart."""
    if is_sidecar():
        bootstrap._set(APPLY_TASK, state="failed",
                       message="This server runs inside the Meeting Master app — "
                               "the app installs updates itself on restart.")
        return
    tag = _info.get("tag")
    if not tag:
        bootstrap._set(APPLY_TASK, state="failed",
                       message="Run 'Check for updates' first.")
        return
    installer = _tag_dir(tag) / SERVER_ASSET
    if not installer.is_file():
        bootstrap._set(APPLY_TASK, state="failed",
                       message="The server installer is not downloaded yet — run 'Check for updates'.")
        return
    if not getattr(sys, "frozen", False) or sys.platform != "win32":
        bootstrap._set(APPLY_TASK, state="failed",
                       message="Self-update only works in the installed Windows build.")
        return
    busy = _active_jobs()
    if busy:
        bootstrap._set(APPLY_TASK, state="failed",
                       message=f"{busy} job(s) still processing — try again when the pipeline is idle.")
        return

    # The running exe can't overwrite itself: hand off to a batch that waits
    # for this process to exit, installs silently, and relaunches.
    #
    # Gotchas encoded here:
    # - CREATE_NO_WINDOW only (never DETACHED_PROCESS: combining them strips
    #   the hidden console, and console-less `timeout`/stdin tools break).
    # - `ping -n` as the delay — unlike timeout.exe it needs no console stdin.
    # - "mbcs" encoding: cmd parses the file in the OEM codepage, and both
    #   paths contain the (possibly non-ASCII) Windows user name.
    exe = sys.executable
    bat = Path(tempfile.gettempdir()) / "meetingmaster-server-update.bat"
    bat.write_text(
        "@echo off\r\n"
        "ping -n 7 127.0.0.1 >nul\r\n"  # ~6s: comfortably after our os._exit
        f'"{installer}" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART\r\n'
        f'start "" "{exe}"\r\n',
        encoding="mbcs",
    )
    creationflags = 0x08000000  # CREATE_NO_WINDOW
    subprocess.Popen(["cmd", "/c", str(bat)], creationflags=creationflags,
                     close_fds=True)
    bootstrap._set(APPLY_TASK, state="done", progress=100,
                   message=f"Installing {tag} — the server restarts itself in a few seconds.")
    log.info("Self-update to %s launched — exiting for the installer", tag)
    # Long enough for the dashboard's 1.5s fast-poll to fetch the final task
    # state (and well inside the bat's ~6s pre-install delay).
    await asyncio.sleep(3.0)
    os._exit(0)


# ---- Periodic check ---------------------------------------------------------

async def periodic_check_loop() -> None:
    """Started from the app lifespan: check on boot, then every N hours."""
    await asyncio.sleep(20)  # let the server settle before the first check
    while True:
        try:
            current = bootstrap.task_state(CHECK_TASK)
            if current.get("state") != "running":
                await check_updates()
        except Exception:
            log.exception("Periodic update check crashed")
        hours = max(1.0, float(get_settings().UPDATE_CHECK_HOURS))
        await asyncio.sleep(hours * 3600)


# Plug into the dashboard's existing install-button/task machinery.
bootstrap.register_component(CHECK_TASK, check_updates)
bootstrap.register_component(APPLY_TASK, apply_server_update)
