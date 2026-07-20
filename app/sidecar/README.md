# Bundled home server (sidecar)

CI places the PyInstaller onedir build of the Python home server here
(`MeetingMasterServer.exe` + its `_internal/` tree) before packaging the app,
and electron-builder ships this folder as `resources/server/` inside the
installer — that is what home-server mode launches.

This folder is intentionally (almost) empty in git: everything except this
README is git-ignored. In a dev checkout, server mode falls back to running
the repo's Python server directly (`server/.venv` or `python3 -m app.desktop`)
— see `app/src/main/serverManager.js`.
