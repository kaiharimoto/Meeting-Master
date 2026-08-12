# Home PC setup (Windows, always on, AMD RX 7900 XTX)

The home PC runs the AI job service: transcription (whisper.cpp, Vulkan),
summarization (Ollama), and the Gmail send. Setup is a single installer plus a
guided setup page in your browser — **no PowerShell, no Python, no manual
config-file editing.** ffmpeg and the whisper.cpp engine are already inside the
installer; Ollama, Tailscale, and the AI models are installed for you from that
setup page.

At the end you copy one **Connection Code** — that is everything the laptop
needs.

## 1. Install

1. Download **`MeetingMaster-Setup-<version>.exe`** — the ONE Meeting Master
   installer, same file as the laptop — from the
   [latest release](../../releases/latest). (No release yet? Open the
   **build-installers** run under the repo's **Actions** tab and download the
   **`app-installer`** artifact.)
2. Double-click it and click through the installer. **No admin rights are
   required** — it installs per-user.
3. Launch Meeting Master and choose **Home server** mode on the first-run
   screen. The bundled AI server starts and the app window shows the **server
   dashboard** — tabs for **Overview** (health, software, connection code),
   **Jobs** (every meeting processed, updating live), **Logs**, and
   **Settings**. On first run it lands on Settings so you can finish setup.
   (The same dashboard is always available in a browser at
   `http://127.0.0.1:8080/setup` — see
   [TROUBLESHOOTING.md](TROUBLESHOOTING.md#the-dashboard-didnt-open-home-server-mode)
   if it doesn't come up.)

Closing the window keeps the server running in the **tray**, and the app
**auto-starts at login** from now on, so the whole stack comes back after a
reboot with nothing to do.

> **Upgrading from v0.2.x?** Uninstall the old "Meeting Master Home Server"
> app first — your settings and data carry over automatically. See
> [TROUBLESHOOTING.md](TROUBLESHOOTING.md#migrating-from-v02x-two-installers-to-v030-one-app).

## 2. Work through setup on the dashboard

Everything below happens on the `http://127.0.0.1:8080/setup` dashboard —
email settings live in the **Settings** tab, software installs and the
connection code in **Overview**.

### a. Email

- Enter your **Gmail address**, a **Gmail App Password**, and the **recipient
  list** (who receives the meeting PDFs).
- An App Password is **not** your normal Google password. Create one at
  <https://myaccount.google.com/apppasswords> (you must have **2-Step
  Verification** enabled first — App Passwords only appear once 2FA is on).
  Google shows a 16-character password once; paste it into the App Password
  field. The setup page links to these steps too.

### a2. Live suggestions during meetings (optional)

The **Settings** tab's **Live suggestions** card controls what the laptop is
offered *while a meeting is running*: questions the AI hears being answered, and
key insights worth carrying forward. This is the only place it is configured —
the laptop asks this server for these settings at the start of each meeting.

Defaults work, with one thing worth checking: the summary model (`gemma4:26b`)
is sized for quality after the meeting, not for answering inside one. If
suggestions arrive late or not at all:

1. Click **Test live suggestions**. It runs the real request over a fixed sample
   conversation that contains one answered question and one lesson, and reports
   what came back and how long it took — including "slower than the interval",
   which means asks would pile up on each other.
2. If it is slow, put a **smaller installed model** in the **Live model** field
   (blank = use the summary model) and test again, or raise **Ask every**.
3. Leave **Keep the model loaded** at 30 minutes. A cold model load is the
   usual reason a mid-meeting ask runs out of time.

Untick **Send live suggestions to the laptop during meetings** to switch the
feature off; the laptop then says so in its rail instead of looking broken, and
the post-meeting AI still finds everything.

### a2b. Letting Claude write the notes instead (optional)

The **Who writes the notes** card picks which model writes the summary and
finds the Q&A pairs. **Ollama** — running on this machine — is the default, and
it is the right default: no account, no internet, nothing that can expire.

**Claude** is worth switching to when the local model can't do a meeting
justice, and it is especially worth it if the machine you paste prompts from is
locked down. This machine reaches the internet freely, so it can make the call
that otherwise means carrying the prompt to a phone.

Set it up once:

1. Install Claude Code on this machine.
2. Run `claude login` in a terminal here and sign in. It uses your existing
   Claude subscription — there is no API key to create and no per-token bill.
3. On **Settings**, set **AI provider** to *Claude*, then click **Test AI now**.
   The card tells you whether the CLI was found; the test tells you whether the
   sign-in works.

If the CLI isn't found automatically — likely on Windows, where the service and
your desktop session have different PATHs — put its full path in **Claude CLI
path**.

Two limits worth knowing before you rely on it. Subscription plans have usage
caps, and a long meeting summarized at a busy time can hit one. The sign-in can
also lapse. Neither costs you the meeting: the transcript is already stored, so
switch **AI provider** back to *Ollama* and press **Start AI** again.

The **AI models** card below configures Ollama only. Claude ignores those
settings — its context is large enough that the chunking they size is skipped.

### a3. Choosing a model for your GPU

Open **Settings → Fit to your GPU**, enter your card's memory, and click
**Measure my models**. It reads each installed model's real layer and head
counts and works out the largest context window that fits, then lets you apply
the answer in one click. Use that rather than any rule of thumb below — it is
measuring *your* models on *your* card.

**Why a parameter count tells you nothing useful.** Two things fill graphics
memory:

| | Size |
| --- | --- |
| **Weights** | Fixed per model + quantization. A 4-bit ~30B model is roughly 16–20 GB. |
| **KV cache** | `2 x layers x kv_heads x head_dim x bytes` **per token of context**. |

The second one is why "a 27B model needs a 16k context" is not a real rule: the
cache cost per token depends on the model's attention shape, and two models of
identical size can differ **four-fold**. A model with many key/value heads can
easily want more memory for a 32k context than for its own weights. The panel
prints that number per model ("MB per 1k ctx") so you can see which side of
your budget is the problem.

**Picking a quantization.** Every stage of this pipeline demands strictly
structured JSON, and instruction-following is the first thing to degrade as
quantization gets aggressive:

- **Q4_K_M** — the sensible default. Best quality per gigabyte, and reliable at
  producing the JSON these prompts ask for.
- **Q5_K_M / Q6_K** — a little better, noticeably larger. Only worth it if the
  panel still says "fits comfortably" afterwards.
- **Q3 and below** — avoid. It saves memory by damaging exactly the ability
  this program depends on; a summary stage that returns malformed JSON is worse
  than a smaller model that returns good JSON.

**On a 24 GB card** (an RX 7900 XTX, say) two configurations work well, and the
panel will tell you which of your installed models land where:

1. **One mid-size model** in the ~14–32B class at Q4_K_M (~9–20 GB), with
   whatever context is left over. Best summary quality.
2. **A mid-size model for the summary plus a small fast one for live
   suggestions** (Settings → Live suggestions → Live model). The live path runs
   *during* the meeting and is judged on latency, not depth, so a 7–8B model
   there is usually the right trade — and it stops the big model being asked to
   answer inside 45 seconds.

**A smaller context is not worse notes.** Transcripts longer than the window are
summarized in overlapping chunks and merged, so lowering the context costs time
on a long recording, not accuracy. Given the choice between a big context that
spills onto the CPU and a smaller one that fits entirely in VRAM, the smaller
one is faster *and* better.

**Getting more context out of the same card.** Setting these two in Ollama's own
environment (Windows user variables, then restart Ollama) roughly halves the
cache:

```
OLLAMA_FLASH_ATTENTION=1
OLLAMA_KV_CACHE_TYPE=q8_0
```

Both are required — without flash attention Ollama keeps an f16 cache. Support
varies by GPU backend, so treat it as something to verify rather than assume:
select `q8_0` in the panel's **KV cache precision** dropdown to see what it
would buy, apply the change, then use **Test AI now** and check the
"Loaded right now" line reports 100% on the GPU.

**The line that tells you the truth.** Everything above is arithmetic. The
"Loaded right now" readout under the panel is a measurement — it reports what
Ollama actually did, including the percentage of the model sitting on the GPU.
Anything below 100% means layers spilled to the CPU, which is the real cause of
almost every "the AI is so slow" report.

### b. Install the dependencies (guided)

The page has **Install** buttons for each dependency. Click them and wait for
the green checks — the first two are quick; the model downloads are large:

- **Ollama** — the local LLM runtime (installed natively for Windows, which is
  what the AMD RX 7900 XTX needs — never WSL2).
- **Tailscale** — the private network that links this PC to the laptop.
- **AI model** — the summarization/question-extraction model `gemma4:26b`
  (**~16 GB** download) plus the transcription model `large-v3-turbo`
  (**~1.6 GB** download). Expect this to take a while on a normal connection;
  the page shows progress and turns green when each is ready. (Gemma 4 26B is a
  fast mixture-of-experts model that fits the RX 7900 XTX's 24 GB with room for
  the 32K context — swap it for another Ollama model any time from the setup
  page's **AI model** field.)

If an install button fails, just click it again, or install that one tool
yourself from its own website and click **Detect** — see
[TROUBLESHOOTING.md](TROUBLESHOOTING.md#a-dependency-install-failed).

### c. Sign in to Tailscale

When prompted, **sign in to Tailscale**. Use the account you will also sign the
laptop into — the two machines must be on the **same tailnet**. The setup page
publishes the server on the tailnet for you once you're signed in.

### d. Finish and copy the Connection Code

Click **Save & Finish**. The page shows a **Connection Code** — a single string
that bundles the server's tailnet URL and its shared secret. **Copy it.** That
code is the only thing you paste on the laptop (see
[SETUP_LAPTOP.md](SETUP_LAPTOP.md)). You can reopen the setup page any time from
the tray icon to view or regenerate it.

## 3. Where your data and settings live

Everything the server writes lives under **`%APPDATA%\MeetingMaster`**:

- `server.env` — settings the setup page saves (never edit by hand unless you
  have to; prefer the setup page).
- `models\` — the downloaded whisper models.
- `data\<job-id>\` — per-job audio, transcript, and PDF records.

Ollama stores its model separately under its own data directory. Reopen the
setup page from the tray icon whenever you want to change email settings, the
recipient list, or the Connection Code.

## 4. What to expect (performance)

On the RX 7900 XTX, a **1-hour meeting** takes roughly:

- **~2–3 minutes** to transcribe with `large-v3-turbo`,
- **~1–2 minutes** to summarize and extract the Q&A with `gemma4:26b`,
- plus the WAV upload time, which depends on the laptop→home link (a ~600 MB
  WAV transfers in a few minutes over a direct Tailscale connection; slower if
  traffic is relayed — see
  [TROUBLESHOOTING.md](TROUBLESHOOTING.md#upload-fails-or-is-very-slow)).

The first meeting after setup is the only slow one for models — after the
one-time downloads above, nothing else is fetched.

---

**Developers** running the server from a source checkout instead of the
installer: see the Development section of the [README](../README.md#development).
The Vulkan whisper.cpp build the installer ships is produced by CI; the manual
build steps are kept as a reference in
[`scripts/homepc/build_whisper_vulkan.md`](../scripts/homepc/build_whisper_vulkan.md).
