"""Frozen-app entry point — this is what PyInstaller builds into an .exe.

It runs the FastAPI server (app.main:app) in a background thread on the
configured port, opens the first-run setup page in the browser when the server
is not configured yet, and then shows a small system-tray icon so the operator
can reopen setup, open the data folder, or quit.

Everything degrades gracefully off Windows and without a display: the tray
depends on pystray + Pillow, both imported lazily and guarded, so if they are
missing (or there is no GUI) the process simply blocks and keeps serving.

Run directly for a dev smoke test:  python -m app.desktop
"""

import logging
import os
import subprocess
import sys
import threading
import time
import webbrowser

# Absolute (not relative) import: PyInstaller freezes THIS file as the entry
# point, so it runs as __main__ with no parent package — a `from .config`
# relative import fails there ("attempted relative import with no known parent
# package"). `server/` is on sys.path (pathex in the .spec / `python -m`), so the
# absolute form resolves both frozen and in a dev checkout.
from app.config import config_home, get_settings

log = logging.getLogger(__name__)

_HOST = "0.0.0.0"  # binds loopback + LAN/Tailscale; setup routes stay loopback-only


def _setup_logging():
    """Log to a file and make stdout/stderr safe in a windowed build.

    A no-console PyInstaller app has sys.stdout/sys.stderr set to None, so ANY
    library that writes to them — uvicorn logs a line on every startup — raises
    and silently kills the server thread. Point both streams and the logging
    root at <config home>\\server.log so nothing writes to a None stream and the
    operator has a real log to read (tray → Open data & settings folder).
    """
    home = config_home()
    home.mkdir(parents=True, exist_ok=True)
    log_path = home / "server.log"
    stream = open(log_path, "a", encoding="utf-8", buffering=1)
    # Replace only if missing (frozen windowed); never clobber a real console.
    if sys.stdout is None:
        sys.stdout = stream
    if sys.stderr is None:
        sys.stderr = stream
    handler = logging.StreamHandler(stream)
    handler.setFormatter(
        logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s")
    )
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    root.handlers = [handler]
    return log_path


def _serve() -> None:
    # Any failure here (import error, port in use, etc.) must be logged rather
    # than vanishing with the daemon thread — otherwise the browser opens onto a
    # dead port and the operator sees only ERR_CONNECTION_REFUSED.
    try:
        import asyncio

        import uvicorn

        # The setup page shells out (ollama/tailscale detection + installs) via
        # asyncio subprocesses. On Windows only the Proactor loop supports that,
        # so pin the policy before uvicorn creates its loop.
        if sys.platform == "win32":
            asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())

        # Pass the app OBJECT, not the "app.main:app" import string: uvicorn's
        # string-import path is fragile in a frozen bundle.
        from app.main import app as fastapi_app

        settings = get_settings()
        log.info("Starting uvicorn on %s:%s", _HOST, settings.SERVER_PORT)
        uvicorn.run(fastapi_app, host=_HOST, port=settings.SERVER_PORT, log_level="info")
    except Exception:
        log.exception("Server thread crashed — the setup page will be unreachable")


def _wait_for_port(host: str, port: int, timeout: float = 20.0) -> bool:
    """Return True once something accepts connections on host:port."""
    import socket

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.settimeout(1.0)
            if sock.connect_ex((host, port)) == 0:
                return True
        time.sleep(0.3)
    return False


def _dashboard_url() -> str:
    return f"http://127.0.0.1:{get_settings().SERVER_PORT}/setup"


def _open_dashboard() -> None:
    try:
        webbrowser.open(_dashboard_url())
    except Exception:
        log.warning("Could not open a browser for %s", _dashboard_url(), exc_info=True)


def _open_data_folder() -> None:
    # The config home holds server.env, server.log and the data/ + models/
    # folders — the one place worth opening when troubleshooting.
    path = str(config_home())
    try:
        os.makedirs(path, exist_ok=True)
        if sys.platform == "win32":
            os.startfile(path)  # type: ignore[attr-defined]  # Windows-only
        elif sys.platform == "darwin":
            subprocess.Popen(["open", path])
        else:
            subprocess.Popen(["xdg-open", path])
    except Exception:
        log.warning("Could not open data folder %s", path, exc_info=True)


def _run_tray() -> None:
    """Show a tray icon, or block forever if pystray/Pillow are unavailable."""
    try:
        import pystray
        from PIL import Image, ImageDraw
    except Exception:
        log.info("Tray unavailable (pystray/Pillow not installed) — serving headless.")
        _block_forever()
        return

    # Brand-matching tray mark: navy rounded square + white "M" strokes +
    # accent underline (mirrors app/assets/icon/icon.svg).
    image = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((2, 2, 62, 62), radius=14, fill=(26, 43, 74))
    m = [(18, 43), (18, 21), (32, 37), (46, 21), (46, 43)]
    draw.line(m, fill=(255, 255, 255), width=6, joint="curve")
    draw.rounded_rectangle((20, 50, 44, 55), radius=2, fill=(77, 139, 245))

    def _on_dashboard(icon, item):
        _open_dashboard()

    def _on_data(icon, item):
        _open_data_folder()

    def _on_quit(icon, item):
        icon.stop()
        os._exit(0)

    menu = pystray.Menu(
        pystray.MenuItem("Open dashboard", _on_dashboard, default=True),
        pystray.MenuItem("Open data & settings folder", _on_data),
        pystray.MenuItem("Quit", _on_quit),
    )
    icon = pystray.Icon("MeetingMaster", image, "Meeting Master Home Server", menu)
    try:
        icon.run()
    except Exception:
        log.warning("Tray icon failed to run — serving headless.", exc_info=True)
        _block_forever()


def _block_forever() -> None:
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        pass


def main() -> None:
    log_path = _setup_logging()
    log.info("Meeting Master Home Server starting (log: %s)", log_path)

    # Sidecar mode: the Meeting Master app spawned this process and owns the
    # whole desktop experience (window, tray, updates) — no tray, no browser.
    sidecar = bool(os.environ.get("MM_SIDECAR"))
    if sidecar:
        log.info("Running as a sidecar of the Meeting Master app.")

    server_thread = threading.Thread(target=_serve, daemon=True, name="uvicorn")
    server_thread.start()

    # Only open the dashboard once the server is actually accepting
    # connections — otherwise the browser lands on ERR_CONNECTION_REFUSED.
    # Configured or not, launching the app now always lands somewhere useful:
    # first run gets the setup flow, later runs get the monitoring dashboard.
    port = get_settings().SERVER_PORT
    if _wait_for_port("127.0.0.1", port):
        log.info("Server running on port %s (%s)", port, _dashboard_url())
        if not sidecar:
            _open_dashboard()
    else:
        log.error(
            "Server never started listening on port %s — see the log above. "
            "The port may be in use; the tray stays available.",
            port,
        )

    if sidecar:
        _block_forever()
    else:
        _run_tray()


if __name__ == "__main__":
    main()
