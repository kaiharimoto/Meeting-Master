# Troubleshooting

Organized by symptom. The first four entries cover first-time install; the rest
cover the running system. Server-side pipeline problems show up in the job
record — the app surfaces the error, and `GET /jobs/{id}` puts it in the
`error` field when `state` is `failed`.

## The setup page didn't open

After the home-server installer finishes it should open
`http://127.0.0.1:8080/setup` in your browser automatically. If it didn't:

- **Just browse to it:** open `http://127.0.0.1:8080/setup` yourself.
- **Server not running?** Look for the Meeting Master **tray icon**. If it's
  missing, launch Meeting Master Home Server from the Start menu — it starts the
  service and reopens the setup page. It also auto-starts at every login.
- **Port already in use:** if something else owns port 8080, the setup page lets
  you change the port; then browse to `http://127.0.0.1:<new-port>/setup`.

## A dependency install failed

The setup page installs Ollama, Tailscale, and the AI models with **Install**
buttons. If one doesn't turn green:

- **Re-click Install.** Downloads (especially the ~9 GB Ollama model and the
  ~1.6 GB whisper model) can be interrupted; clicking again resumes/retries.
- **Install it yourself, then Detect.** You can install the tool from its own
  site — Ollama (<https://ollama.com/download/windows>, the **native Windows**
  build, never WSL2) or Tailscale (<https://tailscale.com/download/windows>) —
  and then click **Detect** on the setup page so it picks up the existing
  install.
- **Model pulls** run through Ollama/whisper; if a pull keeps failing, check
  free disk space (the two models need ~11 GB combined) and your internet
  connection, then retry.

## Connection code rejected

The **Connection Code** carries the home server's tailnet URL and shared
secret. If the laptop app rejects it or later shows `401`:

1. On the **home PC**, open the setup page from the tray icon and **regenerate**
   the Connection Code (or just re-copy the one shown).
2. On the **laptop**, open **Settings**, **re-paste** the fresh code, and
   **Save**.

A stale code (copied before the server finished setup, or after the tailnet URL
changed) is the usual cause. Regenerating and re-pasting fixes it.

## Windows SmartScreen blocks the installer

Both installers are **unsigned**, so on a new machine the first run shows
"Windows protected your PC". Click **More info → Run anyway**. This is expected
and safe for a self-built app.

If policy forbids running unsigned executables, the fix is Authenticode
code-signing: sign the laptop `.exe` via electron-builder's `win` signing
options and the home-server `.exe` with `signtool` in the Inno Setup step. Both
need a code-signing certificate (a yearly fee) and are optional.

## 401 Unauthorized

The bearer token the laptop is sending doesn't match the home server's. Because
the token now travels inside the **Connection Code**, the fix is the same as a
rejected code: regenerate the code on the home PC's setup page and re-paste it
on the laptop (see
[Connection code rejected](#connection-code-rejected) above). Note that a home
server still in setup mode (no token saved yet) rejects every request by design
— finish the setup page first.

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
3. **Check the location.** In an installed app the fonts go in the
   `resources\fonts\` folder next to the app executable; in a source checkout
   they go in `app/assets/fonts/`. See [FONTS.md](FONTS.md) for both.
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
  default 2048 tokens.
- The server sets `NUM_CTX=32768`. **Verify what Ollama actually loaded:** while
  a summarize stage is running, run `ollama ps` on the home PC — the `CONTEXT`
  column must show `32768`. If it shows `2048`/`4096`, an old Ollama version or
  a modified request payload is dropping the option.
- A bigger context needs more VRAM; if `ollama ps` shows a CPU/GPU split, the
  model no longer fits — see the next section.
- Transcripts that still exceed the 32k window are handled by the chunked
  map-reduce fallback in `summarize.py` (summarize portions, then summarize
  the summaries) — slower, but nothing is dropped.

## Transcription failed or produced garbage

- **Check the job record** (the app shows the error; `GET /jobs/{id}` → `error`).
  whisper.cpp's exit code and last stderr lines are included.
- **The normalize step must run first.** whisper.cpp expects 16 kHz mono
  16-bit PCM; the server converts every upload with
  `ffmpeg -ar 16000 -ac 1 -c:a pcm_s16le` before transcribing (the installer
  bundles ffmpeg). If transcription is garbage, first confirm the
  `normalizing` stage succeeded.
- **Try the fallback model.** `large-v3-turbo` is the fast default;
  `large-v3` is slower but more accurate and is used automatically when the
  default model file is missing. To force it for one meeting, the meeting JSON's
  `options.whisperModel` may name any downloaded model.
- **Wrong language?** The server auto-detects language per file; pin it (e.g.
  `en`) via the setup page's advanced settings if detection misfires on short
  or mixed-language audio.
- **Reproduce by hand** (advanced): the bundled `whisper-cli.exe` lives in the
  installed app's `bin\` folder and the normalized audio is at
  `%APPDATA%\MeetingMaster\data\<job-id>\norm.wav`:

  ```
  whisper-cli.exe -m "%APPDATA%\MeetingMaster\models\ggml-large-v3-turbo.bin" -f norm.wav
  ```

## `ollama ps` shows CPU, not GPU

`ollama ps` must report `100% GPU` in the `PROCESSOR` column while the model
is loaded. If it says `CPU` or a split like `40%/60% CPU/GPU`:

- **Are you inside WSL2?** Don't be. ROCm needs `/dev/kfd`, which WSL2 does
  not expose, so Ollama-in-WSL2 silently runs on CPU. The setup page installs
  the **native Windows** Ollama, which bundles ROCm and officially supports the
  RX 7900 XTX (gfx1100) — if you installed Ollama some other way, remove it and
  let the setup page install it.
- **Driver:** install/update the AMD Adrenalin driver, then restart Ollama
  (quit it from the tray, start it again). Check Ollama's server log
  (`%LOCALAPPDATA%\Ollama`) for lines about detected GPUs.
- **A CPU/GPU split** usually means VRAM ran out — e.g. another app is holding
  VRAM. Close the other app, or lower the context in the setup page.

## Upload fails or is very slow

A one-hour WAV is ~600 MB, so the laptop→home path matters.

- **Direct vs relayed:** run `tailscale ping homepc` from the laptop. `pong
  via DERP` means traffic is being relayed through Tailscale's servers (slow);
  `pong via <ip:port>` means a direct connection. To get direct: check
  `tailscale netcheck` on both ends, allow UDP 41641, and enable UPnP/NAT-PMP
  on the home router.
- **Total failures:** confirm both machines are signed in to the **same**
  Tailscale account, and that the home server's tray icon is present (the
  service is running). If the tailnet URL changed, regenerate the Connection
  Code on the setup page and re-paste it on the laptop.
- **Mid-upload drops:** the app's polling shows "Waiting for the home
  server…" on transient blips, but a failed `POST /jobs` must simply be
  retried — pick the WAV again.

## Email fails

- **App Password, not account password.** Gmail SMTP rejects normal account
  passwords ("Username and Password not accepted"). Create an App Password —
  which requires **2-Step Verification** to be enabled — at
  <https://myaccount.google.com/apppasswords> and enter it on the setup page's
  email section.
- **Corporate SMTP blocks:** the send is done by the **home** server by design,
  precisely so a work network that blocks outbound port 465 can't break it. If
  you switched the app to send email from the laptop instead, the work network
  is the likely blocker — switch back to sending from home.
- **"stored the PDF but could not send the email":** the job is in
  `pdf_received`; the audio and PDF are safe on the server. Fix the email
  settings on the setup page, then click **Send email** again — the PDF is
  re-posted and the send retried, no re-upload of the audio needed.
- **Recipients/template:** the recipient list and email template are set on the
  setup page and stored under `%APPDATA%\MeetingMaster`. Re-open the setup page
  to review them.

## Managed laptop can't install Tailscale

Last resorts, in order of preference — both trade the tailnet's device
authentication for "anyone who finds the URL can knock":

1. **Tailscale Funnel** on the home PC instead of the normal serve. Funnel
   publishes the same HTTPS URL **to the public internet**, so no software is
   needed on the laptop. Understand the exposure: the endpoint becomes
   reachable by anyone, `/health` answers without auth, and the bearer token
   becomes the **only** thing protecting `/jobs` (uploads, transcripts,
   summaries). If you do this: keep the token long and random (the setup page
   generates one), rotate it periodically, and switch back to serve when
   possible.
2. **Cloudflare Tunnel** (`cloudflared`) pointed at `localhost:8080` —
   equivalent public exposure, but adds Cloudflare Access policies if you
   want a second gate in front of the token.

Both are documented as last resorts only — an on-tailnet server is simply
unreachable for the rest of the internet, which no bearer token can match.

## Server restarted mid-job

Jobs are persisted per-id (`%APPDATA%\MeetingMaster\data\<id>\job.json`), but
the work queue and any running ffmpeg/whisper/Ollama processes are not. On
startup the server marks every job that was still in flight
(`queued`/`normalizing`/`transcribing`/`summarizing`) as `failed` with the
error "Server restarted while the job was in progress — re-upload the
audio." The fix is exactly that: pick the WAV again on the laptop and start a
new job. Finished jobs (`ready`/`pdf_received`/`emailed`) survive restarts
untouched.
