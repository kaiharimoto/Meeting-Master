# Meeting Master — Home Server installer

These files turn the FastAPI home server into a double-click Windows installer,
`MeetingMaster-HomeServer-Setup.exe`. CI runs both steps automatically on a
Windows runner; the notes below are for reproducing a build by hand.

## Files

- `meeting-master-server.spec` — PyInstaller spec. Freezes
  `server/app/desktop.py` into a windowed onedir app, `MeetingMasterServer`,
  bundling the setup page and the native tools from `bin/`.
- `meeting-master-server.iss` — Inno Setup script. Wraps the frozen output in a
  per-user (no-admin) installer with Start Menu + auto-start-at-login shortcuts.
- `bin/` — CI drops `ffmpeg.exe`, `whisper-cli.exe` and the whisper DLLs here
  before the PyInstaller step (see `bin/README.md`). Only `.gitkeep` is tracked.

## Build (Windows)

Step 1 — freeze with PyInstaller:

```bat
cd installer\server
python -m pip install -r ..\..\server\requirements.txt ^
                       -r ..\..\server\requirements-desktop.txt ^
                       -r ..\..\server\requirements-build.txt
:: CI copies ffmpeg.exe / whisper-cli.exe / whisper*.dll into .\bin first
pyinstaller --noconfirm --clean meeting-master-server.spec
```

Produces `dist\MeetingMasterServer\MeetingMasterServer.exe`.

Step 2 — package with Inno Setup (ISCC):

```bat
iscc /DMyAppVersion=1.2.3 meeting-master-server.iss
```

Produces `Output\MeetingMaster-HomeServer-Setup.exe`.

## What the installed app does

`MeetingMasterServer.exe` starts uvicorn on the configured port, and on first
run (no `BEARER_TOKEN` yet) opens the loopback-only setup wizard at
`http://127.0.0.1:8080/setup`. From there the user configures email, installs
Ollama / Tailscale / the AI model with one click each, and copies a connection
code into the laptop app. A tray icon reopens setup, opens the data folder, or
quits. Settings live in `%APPDATA%\MeetingMaster` and survive reinstalls.
