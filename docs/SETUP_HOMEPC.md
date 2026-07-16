# Home PC setup (Windows, always on, AMD RX 7900 XTX)

The home PC runs the AI job service: FastAPI on port 8080, ffmpeg for audio
normalization, whisper.cpp (Vulkan build) for transcription, native Ollama for
summarization, and the Gmail SMTP send. Work through the steps in order — the
last step gives you the `https://…ts.net` URL and the bearer token the laptop
needs.

Commands are PowerShell unless noted. Use `curl.exe` (bundled with Windows
10/11), not plain `curl`, which PowerShell aliases to `Invoke-WebRequest`.

## 1. ffmpeg

```powershell
winget install Gyan.FFmpeg
```

Open a **new** terminal (winget updates PATH) and verify:

```powershell
ffmpeg -version
```

If you install ffmpeg somewhere not on PATH, set `FFMPEG_PATH` in
`server\server.env` to the full path of `ffmpeg.exe`.

## 2. whisper.cpp (Vulkan build)

whisper.cpp is built with **Vulkan**, not ROCm — on Windows the Vulkan backend
is the reliable way to run the RX 7900 XTX.

Prerequisites (once):

- The current **AMD Adrenalin** driver (includes the Vulkan runtime).
- **Vulkan SDK**: `winget install KhronosGroup.VulkanSDK`
- **Visual Studio 2022** with the "Desktop development with C++" workload
  (or the standalone VS Build Tools), **CMake**, and **git**.

Build (full command reference with troubleshooting notes:
[`scripts/homepc/build_whisper_vulkan.md`](../scripts/homepc/build_whisper_vulkan.md)):

```powershell
git clone https://github.com/ggml-org/whisper.cpp C:\tools\whisper.cpp
cd C:\tools\whisper.cpp
cmake -B build -DGGML_VULKAN=ON
cmake --build build --config Release
```

Binaries land in `build\bin\Release\` (notably `whisper-cli.exe`).

Download the models — default and fallback. Model files are named
`ggml-<model>.bin` inside the models directory:

```powershell
cd C:\tools\whisper.cpp\models
.\download-ggml-model.cmd large-v3-turbo
.\download-ggml-model.cmd large-v3
```

Verify with the bundled sample (look for `ggml_vulkan: Found 1 Vulkan devices`
followed by a transcript of the JFK quote):

```powershell
cd C:\tools\whisper.cpp
.\build\bin\Release\whisper-cli.exe -m models\ggml-large-v3-turbo.bin -f samples\jfk.wav
```

These paths become `WHISPER_CLI` and `WHISPER_MODEL_DIR` in step 4.

## 3. Ollama (native Windows — NOT WSL2)

> **Warning: install Ollama natively on Windows. Do NOT use WSL2.**
> ROCm inside WSL2 needs the `/dev/kfd` kernel device, which WSL2 does not
> expose — Ollama in WSL2 silently falls back to CPU. The native Windows
> installer bundles its own ROCm libraries and officially supports the
> RX 7900 XTX (gfx1100).

Install from <https://ollama.com/download/windows> (or
`winget install Ollama.Ollama`), then pull the model:

```powershell
ollama pull qwen2.5:14b-instruct-q6_K
```

Verify GPU use — run a prompt, then check `ollama ps` **while the model is
loaded**; the `PROCESSOR` column must say `100% GPU`:

```powershell
ollama run qwen2.5:14b-instruct-q6_K "Reply with one word: ready"
ollama ps
```

If it says CPU (or a CPU/GPU split), see
[TROUBLESHOOTING.md](TROUBLESHOOTING.md#ollama-ps-shows-cpu-not-gpu) before
continuing.

Ollama's Windows installer registers itself to start at login, so the API at
`http://127.0.0.1:11434` is available after reboots.

## 4. Python server + configuration

```powershell
cd C:\path\to\Meeting-Master\server
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

Create the real config files from the committed templates (all three are
git-ignored):

```powershell
Copy-Item ..\config\server.env.example .\server.env
Copy-Item ..\config\recipients.example.json ..\config\recipients.json
Copy-Item ..\config\email_template.example.txt ..\config\email_template.txt
```

Generate a long random bearer token:

```powershell
python -c "import secrets;print(secrets.token_urlsafe(32))"
```

Edit `server\server.env`:

- `BEARER_TOKEN` — the token you just generated. The laptop's `laptop.env`
  must use the **same** string.
- `WHISPER_CLI=C:\tools\whisper.cpp\build\bin\Release\whisper-cli.exe`
- `WHISPER_MODEL_DIR=C:\tools\whisper.cpp\models`
- `WHISPER_MODEL_DEFAULT=large-v3-turbo`, `WHISPER_MODEL_FALLBACK=large-v3`
  (the defaults) match the models downloaded in step 2.
- Leave `OLLAMA_URL`, `OLLAMA_MODEL`, and `NUM_CTX=32768` as-is unless you
  know why you're changing them (see
  [TROUBLESHOOTING.md](TROUBLESHOOTING.md#summary-covers-only-the-end-of-the-meeting)).
- The `SMTP_*` values come from step 5.

Edit `config\recipients.json` (the preset recipient list) and
`config\email_template.txt` (first line `Subject: …`, then the body;
`{{title}}`, `{{date}}`, `{{time}}`, `{{attendees}}` are substituted).

## 5. Gmail App Password

Gmail requires an **App Password** for SMTP — your normal account password
will not work and must never go in a config file.

1. Enable **2-Step Verification** on the Google account
   (<https://myaccount.google.com/security>) — App Passwords are only
   available with 2FA on.
2. Go to <https://myaccount.google.com/apppasswords>.
3. Create an app password named e.g. `Meeting Master`. Google shows a
   16-character password **once** — copy it (spaces don't matter; the server
   accepts it either way, but pasting it without spaces is tidiest).
4. In `server\server.env` set:

   ```ini
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=465
   SMTP_USE_SSL=true
   SMTP_USER=you@gmail.com
   SMTP_APP_PASSWORD=abcdabcdabcdabcd
   SMTP_FROM=you@gmail.com
   ```

## 6. Run the server and smoke-test it

Start the server (creates/updates the venv automatically):

```powershell
C:\path\to\Meeting-Master\scripts\homepc\run_server.ps1
```

In a second terminal, hit the unauthenticated health endpoint:

```powershell
curl.exe http://localhost:8080/health
```

Expected: `{"status":"ok"}`.

Now an authenticated end-to-end job with a short WAV (whisper.cpp's
`samples\jfk.wav` works well). Write the meeting JSON to a file first — it
sidesteps PowerShell/cmd quote-escaping entirely:

```powershell
cd C:\path\to\Meeting-Master
Copy-Item C:\tools\whisper.cpp\samples\jfk.wav test.wav
'{"schemaVersion":1,"details":{"title":"Smoke test","date":"2026-07-16","time":"10:00","attendees":["Kai"]},"cards":[],"recipients":[],"options":{"whisperModel":"large-v3-turbo","emailMode":"home"}}' | Set-Content meeting.json
```

Upload it (`-F "meeting=<meeting.json"` tells curl to read the form-field
value from the file; replace `YOUR_TOKEN` with your `BEARER_TOKEN`):

```powershell
curl.exe -X POST http://localhost:8080/jobs -H "Authorization: Bearer YOUR_TOKEN" -F "meeting=<meeting.json" -F "file=@test.wav"
```

Expected: `{"id":"20260716-101502-a1b2c3"}` (HTTP 202). Poll it with the id
you got back:

```powershell
curl.exe -H "Authorization: Bearer YOUR_TOKEN" http://localhost:8080/jobs/20260716-101502-a1b2c3
```

The `state` field should advance `queued → normalizing → transcribing →
summarizing → ready` within a minute or so for an 11-second WAV, and the final
record contains the transcript and summary. A `401` here means the token
doesn't match; a `failed` state carries the pipeline error in `error`.

## 7. Tailscale

```powershell
winget install Tailscale.Tailscale
```

Sign in (this machine and the laptop must join the **same** tailnet), then
publish the service over HTTPS on the tailnet:

```powershell
tailscale serve --bg 8080
tailscale serve status
```

`tailscale serve status` prints the URL, e.g.
`https://homepc.tail-xxxx.ts.net`. That URL is the laptop's
`HOME_SERVER_URL`. Verify from another device on the tailnet:

```powershell
curl.exe https://homepc.tail-xxxx.ts.net/health
```

The serve configuration is persistent — it survives reboots and only needs
re-running after a `tailscale serve reset`
(see [`scripts/homepc/tailscale_serve.ps1`](../scripts/homepc/tailscale_serve.ps1)).

## 8. Auto-start on boot

Two things must come up after a reboot:

1. **Tailscale** — nothing to do. It runs as a Windows service, and the
   `serve` config from step 7 persists across reboots.
2. **The job server** — create a Task Scheduler entry that runs
   `run_server.ps1` at logon:

   ```powershell
   schtasks /Create /TN "MeetingMaster Server" /SC ONLOGON /TR "powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\path\to\Meeting-Master\scripts\homepc\run_server.ps1"
   ```

   (Or via the Task Scheduler GUI: *Create Task…* → trigger **At log on** →
   action *Start a program* → `powershell.exe` with the arguments above. Tick
   "Run whether user is logged on or not" if the PC sits at the lock screen.)

   Alternative: [NSSM](https://nssm.cc) can wrap the same script as a real
   Windows service if you prefer service semantics (auto-restart on crash).

Since Ollama also starts at login (step 3), a reboot brings the whole stack
back without manual steps.

## 9. What to expect (performance)

On the RX 7900 XTX, a **1-hour meeting** takes roughly:

- **~2–3 minutes** to transcribe with `large-v3-turbo` (the `large-v3`
  fallback is noticeably slower but slightly more accurate),
- **under 1 minute** to summarize with `qwen2.5:14b-instruct-q6_K`,
- plus the WAV upload time, which depends on the laptop→home link (a ~600 MB
  WAV transfers in a few minutes over a direct Tailscale connection; much
  slower if traffic is relayed — see
  [TROUBLESHOOTING.md](TROUBLESHOOTING.md#upload-fails-or-is-very-slow)).
