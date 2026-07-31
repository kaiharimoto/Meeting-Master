# Troubleshooting

Organized by symptom. The first entries cover first-time install and
migration; the rest cover the running system. Server-side pipeline problems
show up in the job record — the app surfaces the error, and `GET /jobs/{id}`
puts it in the `error` field when `state` is `failed`.

## Migrating from v0.2.x (two installers) to v0.3.0+ (one app)

Since v0.3.0 there is ONE installer for both machines; each machine picks its
role (Home server / Operator) on first launch.

- **Laptop:** nothing to do — the v0.2.x app auto-updates into the unified one
  and keeps working in operator mode (your saved server URL + token imply the
  mode; the chooser never appears).
- **Home PC:** one manual step. Quit + **uninstall "Meeting Master Home
  Server"** (Windows Settings → Apps), install `MeetingMaster-Setup-*.exe`,
  and choose **Home server** mode. All settings, recipients, models, job data
  and the connection code live in `%APPDATA%\MeetingMaster`, which the
  uninstaller leaves alone — everything carries over, and the laptops
  reconnect without any re-pairing.
- If you launch the new app in server mode **before** uninstalling the old
  server, it will find the old one still holding port 8080 and show an
  "Another server is already running" screen — uninstall the old app (or quit
  its tray icon), then click **Retry**.

## The dashboard didn't open (home server mode)

Launching the app in home server mode starts the bundled AI server and opens
the meeting UI (the dashboard is the sidebar's **Dashboard** tab, v0.5.0+).
If you see an error screen instead:

- **"Another server is already running"** — see the migration entry above.
- **"The home server could not start"** — click **Open server log** on that
  screen (it's `%APPDATA%\MeetingMaster\server.log`) for the reason; **Retry**
  after fixing. A stuck port can be changed later on the dashboard's Settings.
- The window closing is normal — the server keeps running in the **tray**
  (click the tray icon to reopen; it also starts at login).
- You can always browse to `http://127.0.0.1:8080/setup` directly.

## Updates

Everything updates from the **home server's dashboard** (Overview → Updates):

- The server checks GitHub for new releases automatically (every few hours and
  on startup). While the repo is private it needs a **GitHub token** — a
  fine-grained personal access token with read-only *Contents* permission —
  pasted once into the dashboard's Settings tab. "check failed" with an HTTP
  401/403/404 usually means the token is missing, expired, or lacks that
  permission.
- **Nothing waits for a restart unless you want it to.** Once a version is
  downloaded there are three ways to apply it *now*, and they all do the same
  thing: the dashboard's Updates card → **Install now**, the version label in
  the app's sidebar footer (it becomes a button reading
  "v0.18.0 → v0.19.0 — restart"), or tray → **Restart to update**. Leaving it
  alone is also fine — it installs whenever the app next quits.
- **Operator laptop:** downloads new versions from the home server in the
  background and shows an "Update ready" toast with an install action. Your
  licensed fonts are safe: they live in the update-proof fonts folder
  (Settings → Open fonts folder).
- **Home server machine (v0.3.0+):** the app installs the update and the
  bundled server comes back up with it, so the install restarts the app (a few
  seconds). Prefer doing it while no meeting is mid-pipeline — the app refuses
  while a job is still processing rather than killing it, and a job interrupted
  by a restart shows as failed and can simply be re-submitted.
- **A server running on its own** (not inside the app — an adopted or legacy
  standalone install) installs the cached installer itself and restarts only
  the server: dashboard → Updates → **Install now**. No app restart involved.
- **The Updates card shows no install button.** Before v0.19.1 it never
  appeared inside the app window (a stylesheet rule hid the only row that
  worked there) and appeared *unconditionally* in a browser, where clicking it
  only produced an explanation page. Update to v0.19.1+; until then use the
  sidebar version label or the tray.
- A laptop only sees an update **after** the home server has cached it, so
  if the laptop seems behind, run "Check for updates" on the dashboard first.

## Summary is empty or failed (e.g. a model context error) — use your own AI

Transcription and summarization are separate: even when the local model
chokes (context overflow on a long meeting, Ollama error), the **transcript
survives** and the job completes with an empty summary. The escape hatch
(v0.4.0+) lets any external model (Claude, ChatGPT, …) write the summary in
exactly the format Meeting Master needs:

1. **Get the prompt:** on the Meeting screen click **Copy AI prompt** (or on
   the dashboard's Jobs tab click **AI prompt**). It contains the full
   instructions + the transcript, ready to paste into your model. (**Copy
   transcript** / **Save transcript** / the dashboard's **transcript** link
   give you the raw text alone.)
2. **Run it** in your online model and copy its JSON reply.
3. **Import it:** back in Meeting Master, **Edit summary → Import AI output**,
   paste, **Apply import**, then **Save**. Generate the PDF and send the email
   as usual.

On the **home server machine** (v0.5.0+) the app window IS the full meeting
UI (with the dashboard as a sidebar tab): open the job from the Activity
screen (**Open in Meeting**), then follow the steps above. When a summary
fails you also get an error toast with a one-click **Retry summary** — worth
trying right after lowering the context window (Dashboard tab → Settings →
AI models).

## Email didn't send — send it yourself

If SMTP fails (blocked port, expired App Password), nothing is lost: click
**Email text** on the Meeting screen (enabled once the meeting has a job).
It shows the exact **To / Subject / Body** the server would have sent, with
copy buttons — paste into any mail client and attach the generated PDF (the
modal shows its path). Fix the App Password later on the dashboard's
Settings tab.

## A name is misspelled (or spelled three different ways)

Whisper guesses names from audio, so "Kai" can arrive as "Ky" and "Kye".
Since v0.7.0 the pipeline stops after transcription and the **Fix names**
review opens automatically: every candidate name harvested from the
transcript is listed with how often it appears, sound-alike spellings come
pre-suggested for merging into your attendee names, and Apply rewrites the
STORED transcript — so the AI summary and Q&A extraction only ever see the
corrected names. **Apply & start AI** does both in one click; **Fix names…**
reopens the review any time (it also fixes names in cards, detected
questions, and action-item owners).

## The laptop's server pill is red / "Server unreachable"

The pill in the laptop's sidebar is fed by a live event stream plus a
periodic `/health` probe. If it's red:

- Confirm the home PC is on and the Meeting Master tray icon is present.
- Check Tailscale is **Connected** on both machines.
- Click the pill for details (server URL, live-events state) — then open
  **Settings** from the popover to re-check the connection code if needed.
- A red pill doesn't block the workflow by itself — uploads and status polling
  retry independently — but jobs can't reach a server that's actually down.

The **Activity** screen's job list and server log come from the same stream:
if they stall while the pill is green, the server is up but the stream was
interrupted; it reconnects automatically with a few seconds' backoff.

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

## Live suggestions never appear during a meeting

The rail beside the Q&A panel now tells you which of these it is — read its
status line first (it is one quiet sentence under the heading, deliberately not
a popup).

- **"Live suggestions are switched off on the home server."** Turn them on:
  dashboard → **Settings** → **Live suggestions** → tick the box → **Save**.
- **"The home server's AI is not answering…" / "Last request failed…"** The ask
  reached the server and failed. Click **Test live suggestions** on that same
  card — it runs the real request over a fixed sample and reports the actual
  error, the model, and the latency.
- **"Live suggestions are paused — … Retrying every 2 minutes."** Three failures
  in a row. Almost always the model being too slow to answer inside a meeting.
- **"The home server's GPU is busy processing another meeting."** A previous
  meeting is still being transcribed or summarised on the same GPU. Nothing is
  broken: live suggestions stand aside so both aren't slowed down, and resume by
  themselves when the job finishes.
- **"Nothing new heard for N min — still listening."** The loop only asks when
  there is enough new draft transcript to be worth a GPU call, and it is telling
  you how long it has been quiet. If the meeting is definitely talking, the live
  *transcript* is the thing to check, not suggestions.
- **The rail never appears at all.** Suggestions ride on the live transcript, so
  **Live transcript (beta)** must be ticked in the Record panel (and its model
  downloaded via Settings → Live transcription). No live transcript, nothing to
  ask about.
- **Suggestions appear but you never see them.** The rail lives on the Meeting
  screen. While you are on Activity or the Dashboard, the count rides on the
  sidebar's **Meeting** item instead — click it to triage.
- **Nothing but "Listening…" for the whole meeting.** A real meeting often
  genuinely contains no answered questions for minutes at a time. After five
  quiet minutes the rail says how long it has been quiet, so a working-but-quiet
  loop is distinguishable from a stuck one.

Two settings do most of the work when it is slow (dashboard → Settings → Live
suggestions):

- **Live model** — blank means the summary model, which is sized for quality
  after the meeting, not for answering during one. Naming a smaller installed
  model here is the single most effective fix.
- **Ask every** — raise it above the measured latency. An ask that takes longer
  than the interval lands on top of the next one.

Historical note, in case you are reading an older build's behaviour: before
v0.19.0 the laptop gave up after 45 seconds while the server allowed itself 60,
so a home PC running a big model failed *every* ask from the client side while
answering perfectly well — and nothing on screen said so. The laptop now
derives its timeout from the server's (`GET /live/config`) and is always the
more patient of the two.

## Summary covers only the end of the meeting

Classic silent-truncation symptom: the model only ever saw the tail of the
transcript because the context window was too small.

- The server must call Ollama's **native `/api/chat`** endpoint with
  `options.num_ctx` (it does — `server/app/pipeline/summarize.py`). The
  OpenAI-compatible `/v1` endpoint **ignores** `num_ctx` and truncates at the
  default 2048 tokens.
- The server sets `NUM_CTX=32768`. **Verify what Ollama actually loaded:** the
  dashboard's Settings tab → **Fit to your GPU** shows a "Loaded right now" line
  with the context and the percentage of the model on the GPU (the same thing
  `ollama ps` reports, without the terminal). If the context shows `2048`/`4096`,
  an old Ollama version or a modified request payload is dropping the option.
- A bigger context needs more VRAM. **Anything under 100% on the GPU means
  layers spilled to the CPU** — that is the real cause of most "the AI is slow"
  reports, and the fix is a smaller context or a smaller model, both of which
  that panel will size for you.
- Transcripts that still exceed the 32k window are handled by the chunked
  map-reduce fallback in `summarize.py` (summarize portions, then summarize
  the summaries) — slower, but nothing is dropped.

## "The context window is too small for the … stage"

The three numbers have to add up: `NUM_CTX` must hold the tokens a stage
reserves for its **answer**, plus the prompt, plus some transcript. Lower the
context far enough (or raise a stage's max output tokens far enough) and there
is nothing left for the meeting.

The AI stage now fails immediately with a message naming all three numbers and
the minimum that would work, and the dashboard refuses to *save* such a
combination in the first place. Fix it by raising the context window (Settings →
Fit to your GPU suggests one that fits your card) or lowering that stage's max
output tokens.

Before v0.19.2 this did not error — it hung. The budget went negative, the
transcript was split into one-token pieces, and a 60,000-character meeting
became 20,000 sequential Ollama calls each seeing three characters. If you ever
saw an AI stage run for hours with the GPU busy and no progress, that was this.

## The transcript repeats a phrase over and over ("I don't know. I don't know…")

That is a whisper repetition loop over quiet or unclear audio, not something
anybody said. Two things drive it, and both are handled from v0.19.3:

- **Prompt carry-over.** whisper.cpp feeds the previous window's text into the
  next window as context. Once a filler phrase appears, it is in the prompt that
  produces the next window, which makes it likelier again — a self-sustaining
  loop. `WHISPER_MAX_CONTEXT=0` (the new default) switches carry-over off. Set
  it back to `-1` for whisper.cpp's own behaviour if you prefer.
- **The audio.** Loops start where there is little to transcribe: a long silence,
  a muted stretch, room noise, or a microphone that dropped out. Check the
  recording's level around the point where the repetition starts.

The server now detects it (a phrase repeated 6+ times in a row) and the laptop
raises **"This transcript looks damaged"** with the phrase and the count *before*
you press Start AI. A looped transcript makes genuinely bad notes, so it is worth
re-recording or trimming the dead audio rather than summarizing it.

**It is not the live transcript.** The live draft is never used for the notes —
see [ARCHITECTURE.md](ARCHITECTURE.md) ("Two transcripts, and which one becomes
the notes"). The notes always come from the home server's full-quality pass over
the uploaded recording, and that is enforced by a test rather than by convention.

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
