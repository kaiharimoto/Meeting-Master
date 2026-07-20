# Meeting Master — bundled home server (sidecar) build

These files freeze the FastAPI home server into the PyInstaller onedir app
that ships INSIDE the unified Meeting Master installer (`resources/server/`).
Since v0.3.0 there is no separate home-server installer — one NSIS setup exe
covers both modes, and the Electron app launches this frozen server when the
machine is in **home server** mode.

CI runs everything automatically on a Windows runner (`sidecar` job in
`.github/workflows/build-installers.yml`); the notes below are for reproducing
a build by hand.

## Files

- `meeting-master-server.spec` — PyInstaller spec. Freezes
  `server/app/desktop.py` into a windowed onedir app, `MeetingMasterServer`,
  bundling the dashboard page and the native tools from `bin/`.
- `bin/` — CI drops `ffmpeg.exe`, `whisper-cli.exe` and the whisper DLLs here
  before the PyInstaller step (see `bin/README.md`). Only `.gitkeep` is tracked.
- `icon.ico` — brand icon for the frozen exe (generated from
  `app/assets/icon/icon.svg` by `app/scripts/build-icons.js`; committed).

## Build (Windows)

```bat
cd installer\server
python -m pip install -r ..\..\server\requirements.txt ^
                       -r ..\..\server\requirements-desktop.txt ^
                       -r ..\..\server\requirements-build.txt
:: CI copies ffmpeg.exe / whisper-cli.exe / whisper*.dll into .\bin first
pyinstaller --noconfirm --clean meeting-master-server.spec
```

Produces `dist\MeetingMasterServer\MeetingMasterServer.exe`. Copy that whole
folder's contents into `app/sidecar/` and run `npm run dist` in `app/` to get
the unified installer.

## How it runs in production

The Meeting Master app (home server mode) spawns `MeetingMasterServer.exe`
with `MM_SIDECAR=1`: the server then skips its own tray icon, browser-opening
and self-update logic (the app owns all three) and just serves. Settings live
in `%APPDATA%\MeetingMaster` and survive updates, reinstalls, and migration
from the old standalone MeetingMaster-HomeServer install.
