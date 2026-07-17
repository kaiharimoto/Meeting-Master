# installer/server/bin

This folder is **populated by CI**, not committed with binaries.

Before running PyInstaller, CI drops the native tools the frozen server shells
out to here, so the spec's `('bin/*', 'bin')` datas entry bundles them into
`<app>/bin` (where `app.config._bundled_tool` looks for them at runtime):

- `ffmpeg.exe` — audio normalization
- `whisper-cli.exe` — whisper.cpp transcription CLI (Vulkan build)
- the whisper.cpp runtime DLLs that sit next to `whisper-cli.exe`
  (e.g. `whisper.dll`, `ggml*.dll`, and the Vulkan loader if statically required)

Only `.gitkeep` and this README are tracked; everything else here is a
build-time artifact and is git-ignored in practice.
