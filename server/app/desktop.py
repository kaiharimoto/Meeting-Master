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

from .config import config_home, get_settings

log = logging.getLogger(__name__)

_HOST = "0.0.0.0"  # binds loopback + LAN/Tailscale; setup routes stay loopback-only


def _serve() -> None:
    import uvicorn

    settings = get_settings()
    uvicorn.run("app.main:app", host=_HOST, port=settings.SERVER_PORT, log_level="info")


def _setup_url() -> str:
    return f"http://127.0.0.1:{get_settings().SERVER_PORT}/setup"


def _open_setup() -> None:
    try:
        webbrowser.open(_setup_url())
    except Exception:
        log.warning("Could not open a browser for %s", _setup_url(), exc_info=True)


def _open_data_folder() -> None:
    path = str(get_settings().data_dir)
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

    image = Image.new("RGB", (64, 64), (23, 26, 35))
    draw = ImageDraw.Draw(image)
    draw.ellipse((14, 14, 50, 50), fill=(91, 140, 255))

    def _on_setup(icon, item):
        _open_setup()

    def _on_data(icon, item):
        _open_data_folder()

    def _on_quit(icon, item):
        icon.stop()
        os._exit(0)

    menu = pystray.Menu(
        pystray.MenuItem("Open setup / settings", _on_setup, default=True),
        pystray.MenuItem("Open data folder", _on_data),
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
    logging.basicConfig(level=logging.INFO)
    config_home().mkdir(parents=True, exist_ok=True)

    server_thread = threading.Thread(target=_serve, daemon=True, name="uvicorn")
    server_thread.start()

    # Give the server a beat to bind, then open setup on first run.
    time.sleep(1.0)
    if not get_settings().is_configured:
        log.info("Server not configured yet — opening setup at %s", _setup_url())
        _open_setup()

    _run_tray()


if __name__ == "__main__":
    main()
