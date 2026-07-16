# Troubleshooting

Organized by symptom. Server-side problems usually show up in the server
terminal (the FastAPI process logs every stage transition and failure) and in
the job record itself — `GET /jobs/{id}` puts the pipeline error in the
`error` field when `state` is `failed`.

## PDF renders in the wrong font

The PDF should be Neue Haas Grotesk; if it comes out as Arial (or a mix):

1. **Check the warning.** `renderPdf()` returns
   `{pdfPath, fontUsed, warning}` and the app prints the warning on the
   status line right after "Generate PDF". `fontUsed: false` means the font
   files were not found at all.
2. **Check the filenames.** They must be exactly
   `NeueHaasGrotesk-Roman.woff2|.otf|.ttf` and `NeueHaasGrotesk-Bold.*` — see
   [FONTS.md](FONTS.md). A single missing weight produces a
   synthesized/substituted weight and its own warning.
3. **Check the location.** Dev: `app/assets/fonts/`. Packaged: the fonts must
   have been in `app/assets/fonts/` when `npm run dist` ran — they are baked
   into the exe's `resources/fonts`. Rebuild if you added them later.
4. **Mixed/partial wrong font with the files present** points at the
   `document.fonts.ready` gate in `app/src/main/pdf.js`: `printToPDF` must
   only run after fonts have loaded. The code awaits explicit
   `fonts.load()` calls plus `document.fonts.ready` before printing — if
   you've modified `pdf.js`, restore that ordering.

## Colors/backgrounds missing in the PDF

Answer boxes, participant chips, and accent rules are painted as CSS
backgrounds/borders. Chromium **silently drops backgrounds** when printing
unless `printToPDF` is called with `printBackground: true` (the code also
passes `preferCSSPageSize: true` to keep the `@page` margins). If you've
touched `app/src/main/pdf.js`, check those options are still there;
`print.css` additionally sets `print-color-adjust: exact` as belt-and-braces.

## Summary covers only the end of the meeting

Classic silent-truncation symptom: the model only ever saw the tail of the
transcript because the context window was too small.

- The server must call Ollama's **native `/api/chat`** endpoint with
  `options.num_ctx` (it does — `server/app/pipeline/summarize.py`). The
  OpenAI-compatible `/v1` endpoint **ignores** `num_ctx` and truncates at the
  default 2048 tokens. If you've pointed anything at `/v1`, that's the bug.
- Check `NUM_CTX=32768` in `server/server.env`.
- **Verify what Ollama actually loaded:** while a summarize stage is running,
  run `ollama ps` on the home PC — the `CONTEXT` column must show `32768`. If
  it shows `2048`/`4096`, the `num_ctx` option is not reaching Ollama
  (old Ollama version, or a modified request payload).
- Note that a bigger context needs more VRAM; if `ollama ps` shows a CPU/GPU
  split after raising `NUM_CTX`, the model no longer fits — see the next
  section.
- Transcripts that still exceed the 32k window are handled by the chunked
  map-reduce fallback in `summarize.py` (summarize portions, then summarize
  the summaries) — slower, but nothing is dropped.

## Transcription failed or produced garbage

- **Check the server logs and the job record** (`GET /jobs/{id}` → `error`).
  whisper.cpp's exit code and last stderr lines are included in the error.
- **The normalize step must run first.** whisper.cpp expects 16 kHz mono
  16-bit PCM; the server converts every upload with
  `ffmpeg -ar 16000 -ac 1 -c:a pcm_s16le` before transcribing. If
  transcription is garbage, first confirm the `normalizing` stage succeeded
  and that `ffmpeg -version` works on the server (see `FFMPEG_PATH` in
  `server.env`).
- **Try the fallback model.** `large-v3-turbo` is the fast default;
  `WHISPER_MODEL_FALLBACK=large-v3` is slower but more accurate, and is used
  automatically when the default model file is missing. To force it for one
  meeting, the meeting JSON's `options.whisperModel` may name any model whose
  `ggml-<model>.bin` exists in `WHISPER_MODEL_DIR`.
- **Wrong language?** `WHISPER_LANGUAGE=auto` detects per file; pin it (e.g.
  `en`) if detection misfires on short or mixed-language audio.
- Reproduce by hand on the server to take FastAPI out of the loop:

  ```powershell
  C:\tools\whisper.cpp\build\bin\Release\whisper-cli.exe -m C:\tools\whisper.cpp\models\ggml-large-v3-turbo.bin -f norm.wav
  ```

  (`norm.wav` lives in `server\data\<job-id>\`.)

## `ollama ps` shows CPU, not GPU

`ollama ps` must report `100% GPU` in the `PROCESSOR` column while the model
is loaded. If it says `CPU` or a split like `40%/60% CPU/GPU`:

- **Are you inside WSL2?** Don't be. ROCm needs `/dev/kfd`, which WSL2 does
  not expose, so Ollama-in-WSL2 silently runs on CPU. Uninstall it there and
  install the **native Windows** Ollama, which bundles ROCm and officially
  supports the RX 7900 XTX (gfx1100).
- **Driver:** install/update the AMD Adrenalin driver, then restart Ollama
  (quit it from the tray, start it again). Check Ollama's server log
  (`%LOCALAPPDATA%\Ollama`) for lines about detected GPUs.
- **A CPU/GPU split** usually means VRAM ran out — e.g. `NUM_CTX` raised
  beyond what fits alongside the q6_K weights, or another app is holding
  VRAM. Lower `NUM_CTX`, close the other app, or drop to a smaller quant.

## Upload fails or is very slow

A one-hour WAV is ~600 MB, so the laptop→home path matters.

- **Direct vs relayed:** run `tailscale ping homepc` from the laptop. `pong
  via DERP` means traffic is being relayed through Tailscale's servers (slow);
  `pong via <ip:port>` means a direct connection. To get direct: check
  `tailscale netcheck` on both ends, allow UDP 41641, and enable UPnP/NAT-PMP
  on the home router.
- **Total failures:** confirm `https://…ts.net/health` answers from the
  laptop's browser; confirm `tailscale serve status` on the home PC still
  lists port 8080 (re-run `scripts/homepc/tailscale_serve.ps1` after a
  `tailscale serve reset`); confirm the server process is running.
- **Mid-upload drops:** the app's polling shows "Waiting for the home
  server…" on transient blips, but a failed `POST /jobs` must simply be
  retried — pick the WAV again.
- **Future optimization (not built):** transcode WAV → FLAC before upload —
  lossless, roughly half the bytes, and ffmpeg on the server would decode it
  in the normalize step anyway. Worth doing if you're stuck on a relayed
  path.

## 401 Unauthorized

The bearer tokens don't match. `BEARER_TOKEN` in the laptop's `laptop.env`
must be byte-for-byte identical to `BEARER_TOKEN` in the home PC's
`server/server.env` (watch for trailing whitespace or a half-pasted token).
Restart the server after editing `server.env`; the laptop re-reads
`laptop.env` on reload. Note that a **blank** `BEARER_TOKEN` on the server
makes auth always fail by design — an empty shared secret is not a valid
configuration.

## Email fails

- **App Password, not account password.** Gmail SMTP rejects normal account
  passwords ("Username and Password not accepted"). Create an App Password —
  which requires **2-Step Verification** to be enabled — at
  <https://myaccount.google.com/apppasswords> and put it in
  `SMTP_APP_PASSWORD`. Host/port must be `smtp.gmail.com` / `465` with
  `SMTP_USE_SSL=true`.
- **Corporate SMTP blocks:** if you're on `EMAIL_MODE=laptop`, the work
  network is probably blocking outbound 465. That's exactly why
  `EMAIL_MODE=home` is the default — the home server does the send. Switch
  back.
- **"stored the PDF but could not send the email":** the job is in
  `pdf_received`; the audio and PDF are safe on the server. Fix the SMTP
  config, then click **Send email** again — the PDF is re-posted and the
  send retried, no re-upload of the audio needed.
- Check `config/recipients.json` exists and is a JSON array of addresses, and
  `config/email_template.txt` exists (both are created from the `*.example`
  files during setup).

## Managed laptop can't install Tailscale

Last resorts, in order of preference — both trade the tailnet's device
authentication for "anyone who finds the URL can knock":

1. **`tailscale funnel 8080`** on the home PC instead of `serve`. Funnel
   publishes the same HTTPS URL **to the public internet**, so no software is
   needed on the laptop. Understand the exposure: the endpoint becomes
   reachable by anyone, `/health` answers without auth, and the bearer token
   becomes the **only** thing protecting `/jobs` (uploads, transcripts,
   summaries). If you do this: use a long random token (32+ bytes), rotate it
   periodically, and switch back to `serve` when possible.
2. **Cloudflare Tunnel** (`cloudflared`) pointed at `localhost:8080` —
   equivalent public exposure, but adds Cloudflare Access policies if you
   want a second gate in front of the token.

Both are documented as last resorts only — on-tailnet `tailscale serve` means
the service is simply unreachable for the rest of the internet, which no
bearer token can match.

## Server restarted mid-job

Jobs are persisted per-id (`server/data/<id>/job.json`), but the work queue
and any running ffmpeg/whisper/Ollama processes are not. On startup the
server marks every job that was still in flight
(`queued`/`normalizing`/`transcribing`/`summarizing`) as `failed` with the
error "Server restarted while the job was in progress — re-upload the
audio." The fix is exactly that: pick the WAV again on the laptop and start a
new job. Finished jobs (`ready`/`pdf_received`/`emailed`) survive restarts
untouched.
