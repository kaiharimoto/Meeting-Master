# Building whisper.cpp with Vulkan (Windows, AMD RX 7900 XTX)

Command reference for the transcription engine on the home PC. Vulkan — not
ROCm — is the supported way to run whisper.cpp on an AMD GPU under Windows;
the Vulkan backend is built into whisper.cpp behind a single CMake flag.

## Prerequisites

Install once, before building:

- **Visual Studio Build Tools** (or full VS 2022) with the
  **"Desktop development with C++"** workload — supplies MSVC and the Windows
  SDK.
- **CMake** — `winget install Kitware.CMake` (or it ships with the VS
  workload).
- **git** — `winget install Git.Git`.
- **Vulkan SDK** — `winget install KhronosGroup.VulkanSDK`. The build needs
  the SDK (headers + `glslc`); the runtime comes with the AMD Adrenalin
  driver, which should also be current.

Open a **new** terminal after installing so PATH updates apply.

## Build

```powershell
git clone https://github.com/ggml-org/whisper.cpp C:\tools\whisper.cpp
cd C:\tools\whisper.cpp
cmake -B build -DGGML_VULKAN=ON
cmake --build build --config Release
```

Binaries land in `build\bin\Release\` — the one the server shells out to is
`whisper-cli.exe`.

If CMake cannot find Vulkan, check that the `VULKAN_SDK` environment variable
is set (the SDK installer sets it; a terminal restart or reboot may be
needed).

## Download the models

Model files are named `ggml-<model>.bin`. Download the default and the
fallback:

```powershell
cd C:\tools\whisper.cpp\models
.\download-ggml-model.cmd large-v3-turbo
.\download-ggml-model.cmd large-v3
```

This produces `models\ggml-large-v3-turbo.bin` (~1.6 GB) and
`models\ggml-large-v3.bin` (~3.1 GB).

## Test run

```powershell
cd C:\tools\whisper.cpp
.\build\bin\Release\whisper-cli.exe -m models\ggml-large-v3-turbo.bin -f samples\jfk.wav
```

Success looks like:

- an init line similar to `ggml_vulkan: Found 1 Vulkan devices` naming the
  `AMD Radeon RX 7900 XTX`, and
- the transcribed JFK quote ("And so my fellow Americans…") with timestamps.

If the Vulkan device line is missing, the binary was built without
`-DGGML_VULKAN=ON` or the driver/SDK is missing — rebuild after fixing.

## Point the server at it

In `server\server.env` (copied from `config\server.env.example`):

```ini
WHISPER_CLI=C:\tools\whisper.cpp\build\bin\Release\whisper-cli.exe
WHISPER_MODEL_DIR=C:\tools\whisper.cpp\models
WHISPER_MODEL_DEFAULT=large-v3-turbo
WHISPER_MODEL_FALLBACK=large-v3
```

The server invokes `whisper-cli.exe -m <WHISPER_MODEL_DIR>\ggml-<model>.bin`
with JSON output (`-oj`) and parses the millisecond offsets itself — nothing
else to configure here. Updating whisper.cpp later is just `git pull` and the
same two `cmake` commands.
