# -*- mode: python ; coding: utf-8 -*-
#
# PyInstaller spec — freezes the Meeting Master home server into a windowed
# (no-console) one-directory app named "MeetingMasterServer".
#
# BUILD (on Windows, in CI):
#   cd installer\server
#   python -m pip install -r ..\..\server\requirements.txt ^
#                          -r ..\..\server\requirements-desktop.txt ^
#                          -r ..\..\server\requirements-build.txt
#   # CI first copies ffmpeg.exe, whisper-cli.exe and the whisper DLLs into .\bin
#   pyinstaller --noconfirm --clean meeting-master-server.spec
#
# Result: installer\server\dist\MeetingMasterServer\MeetingMasterServer.exe
# (a onedir bundle). CI copies that folder into app/sidecar/, and
# electron-builder ships it as resources/server inside the ONE app installer.
#
# The entry point is server/app/desktop.py. Standalone it runs uvicorn in a
# thread, opens /setup on first run and shows a tray icon; spawned by the app
# with MM_SIDECAR=1 it just serves (the app owns tray/window/updates).

import os

from PyInstaller.utils.hooks import collect_submodules

# Directory containing this spec (installer/server). PyInstaller injects
# SPECPATH into the spec namespace; fall back to cwd just in case.
SPEC_DIR = os.path.abspath(globals().get("SPECPATH", os.getcwd()))
SERVER_DIR = os.path.abspath(os.path.join(SPEC_DIR, "..", "..", "server"))
ENTRY = os.path.join(SERVER_DIR, "app", "desktop.py")
BIN_DIR = os.path.join(SPEC_DIR, "bin")

# Bundle the setup page (a package data file that is not auto-collected) and the
# native tools CI places in ./bin. dest 'bin' matches app.config._bundled_tool,
# which looks for <bundle>/bin/<exe>.
datas = [
    (os.path.join(SERVER_DIR, "app", "setup", "static", "*"), os.path.join("app", "setup", "static")),
    (os.path.join(BIN_DIR, "*"), "bin"),
]

# uvicorn loads its loop/protocol/lifespan implementations dynamically, so their
# submodules must be pulled in explicitly. httpx (used by the guided installer)
# and python-multipart (form uploads) are imported the usual way but listed for
# safety across environments.
hiddenimports = (
    collect_submodules("uvicorn")
    + collect_submodules("httpx")
    + [
        "app.main",
        "app.desktop",
        "anyio",
        "multipart",
        "pystray",
        "PIL.Image",
        "PIL.ImageDraw",
    ]
)


a = Analysis(
    [ENTRY],
    pathex=[SERVER_DIR],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["tkinter", "pytest"],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="MeetingMasterServer",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,          # windowed app — no console window
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    # Brand icon for the exe (taskbar/explorer). Committed binary generated
    # from app/assets/icon/icon.svg by app/scripts/build-icons.js.
    icon=os.path.join(SPEC_DIR, "icon.ico"),
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name="MeetingMasterServer",
)
