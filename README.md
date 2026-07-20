# Meeting Master

Meeting Master is a two-machine, self-hosted meeting-notes pipeline. In the
meeting room, a portable Electron app on the work laptop captures meeting
details and keyboard-driven Q&A cards while Vibe/OBS records the audio. After
the meeting, the app uploads the WAV over Tailscale to an always-on home PC,
where a FastAPI job service normalizes the audio with ffmpeg, transcribes it
with whisper.cpp (Vulkan build on an AMD RX 7900 XTX), and with a local Ollama
model (`gemma4:26b`) both writes a structured summary (Key Takeaways /
Decisions / Action Items / Key Figures / Topics) and extracts candidate Q&A pairs for the
operator to approve. The laptop then renders a print-perfect PDF locally (Neue
Haas Grotesk, medical-blue accent, ruled Q&A table + presentation-style summary
deck) and sends it back to the home PC, which emails it via Gmail SMTP to a
preset recipient list. No cloud AI, no third-party services — just your two
machines and your tailnet.

## How the two machines talk

```mermaid
sequenceDiagram
    autonumber
    actor U as You (meeting room)
    participant L as Laptop<br/>Meeting Master (Electron)
    participant H as Home PC<br/>FastAPI :8080 (Tailscale HTTPS)
    participant G as Gmail SMTP<br/>smtp.gmail.com:465

    U->>L: Enter details, capture Q&A cards (Q / Tab / Enter)
    U->>L: Pick the recorded WAV
    L->>H: POST /jobs (Bearer token, meeting JSON + WAV)
    H-->>L: 202 { id }
    Note over H: ffmpeg 16 kHz mono → whisper.cpp (Vulkan)<br/>→ Ollama gemma4:26b: summary + Q&A extraction (native /api/chat)
    loop poll every 3 s
        L->>H: GET /jobs/{id}
        H-->>L: queued → normalizing → transcribing → summarizing → ready
    end
    L->>L: Render PDF locally (Neue Haas Grotesk, printToPDF)
    L->>H: POST /jobs/{id}/pdf (the rendered PDF)
    H->>G: Email PDF to preset recipients (App Password)
    H-->>L: { ok: true, emailed: true }
```

Why the PDF makes a second round trip (laptop renders, home PC emails) is
explained in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Repeatable per-meeting workflow

**Before the meeting**

1. Start the Vibe/OBS audio recording.
2. Open Meeting Master and fill in the meeting details: title, date, time,
   attendees.

**During the meeting**

3. Press **Q** anywhere → the question modal opens.
4. Type the question, **Tab** → type the answer, **Tab** → type/select the
   participant who answered (attendees are suggested), **Enter** → the card is
   saved. (**Shift+Enter** adds a newline inside the answer; **Escape**
   cancels.)
5. Repeat for every notable Q&A. Click any card to edit it in place.

**After the meeting**

6. Stop the recording and note where the WAV was saved.
7. In Meeting Master, click **Pick audio & start AI** and select the WAV. The
   app uploads it to the home server and polls progress
   (queued → normalizing → transcribing → summarizing → ready).
8. When the job is **ready**, the AI may surface a **"detected questions"**
   prompt in the Q&A panel. Click **Review & add** to approve the Q&A pairs it
   found — keep the good ones (low-confidence answerers are flagged), fix the
   answerer, and they become normal cards (nothing is added automatically).
   Optionally click **Edit summary** to tweak the Key Takeaways, Decisions,
   Action Items, Key Figures, and Topics before printing. Then click
   **Generate PDF** — saved under `Documents\MeetingMaster\`; click **Open PDF**
   to review it.
9. Click **Send email**. The home server emails the PDF to the preset
   recipient list using the preset template. Done.

Past meetings are saved automatically (and via **History → Save current**);
reopen any of them from the **History** button to review, regenerate, or re-send.

**Updates are automatic** (v0.2.1+): the home server watches GitHub for new
releases (add a read-only GitHub token on its dashboard while the repo is
private) and updates itself with one click; the laptop app downloads updates
from the home server in the background and applies them on restart. Licensed
fonts live in an update-proof folder (laptop **Settings → Open fonts folder**).

## Quickstart

Two installers, one per machine — do the home PC first (it produces the
**Connection Code** the laptop needs). Download both `.exe` files from the
[latest release](../../releases/latest) (or from the **build-installers**
[Actions](../../actions) run: artifacts `homeserver-installer` and
`laptop-installer`).

1. **Home PC** — run `MeetingMaster-HomeServer-Setup.exe`. It installs
   per-user, launches, and opens the **server dashboard** in your browser
   (Overview · Jobs · Logs · Settings, light/dark). On first run, enter your
   Gmail App Password + recipients under **Settings**, click **Install** for
   Ollama / Tailscale / the AI models on **Overview** (wait for green checks),
   sign in to Tailscale, then **Save & Finish** and copy the **Connection
   Code**. After setup, launching the app opens the same dashboard for
   monitoring jobs and logs.
2. **Laptop** — run `MeetingMaster-Setup-<version>.exe`, install Tailscale and
   sign in to the **same** account, then open Meeting Master → **Settings** and
   **paste the Connection Code**. Done.

Full walk-throughs: [docs/SETUP_HOMEPC.md](docs/SETUP_HOMEPC.md) and
[docs/SETUP_LAPTOP.md](docs/SETUP_LAPTOP.md). Also see
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md),
[docs/FONTS.md](docs/FONTS.md), and
[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).

## Repo layout

| Path | What it is |
| --- | --- |
| `app/` | Electron laptop app (`npm start`; NSIS setup exe via `npm run dist`) |
| `app/src/main/` | Main process: config, IPC, PDF rendering, home-server client, SMTP |
| `app/src/preload/` | `contextBridge` — the only bridge to `window.api` |
| `app/src/renderer/` | UI: sidebar app shell (Meeting · Activity · History · Settings), dark/light themes, live server monitoring + print template |
| `app/src/shared/schema.js` | Single source of truth for IPC channel names + job states |
| `app/assets/fonts/` | Licensed Neue Haas Grotesk files (git-ignored, see `docs/FONTS.md`) |
| `app/test/e2e/` | Playwright test suite |
| `server/` | FastAPI home AI server (port 8080; `python -m app.main` in a dev checkout) |
| `server/app/pipeline/` | normalize (ffmpeg) → transcribe (whisper.cpp) → summarize + extract Q&A (Ollama) |
| `server/app/routes/` | `/health`, `/jobs`, and live-monitoring endpoints (`/events` SSE, `/logs/tail`) |
| `server/app/mailer/` | Gmail SMTP sender |
| `server/tests/` | pytest suite (with fake ffmpeg/whisper stubs) |
| `installer/` | Home-server packaging: PyInstaller spec, Inno Setup script, bundled `bin/` |
| `.github/workflows/` | `build-installers.yml` — builds both Windows installers, publishes releases |
| `config/` | `*.example` configuration templates (dev/reference only) |
| `docs/` | Setup, architecture, fonts, troubleshooting |
| `scripts/` | Dev helpers (`laptop/dev.ps1`, `homepc/build_whisper_vulkan.md`) — not needed for install |

## Configuration overview

For normal use you configure nothing by hand. The home server's **Setup page**
(`http://127.0.0.1:8080/setup`) writes its settings to
`%APPDATA%\MeetingMaster\server.env`, and the laptop gets the server URL and the
shared bearer token from the **Connection Code** you paste into Settings — the
two `BEARER_TOKEN`s always match because they come from the same code.

The committed `config/*.example` files are **dev/reference only** — they
document the keys the setup page manages:

| Template (reference) | Where the real values live | Used by |
| --- | --- | --- |
| `config/server.env.example` | `%APPDATA%\MeetingMaster\server.env` (written by the setup page) | Home server — token, models, SMTP |
| `config/recipients.example.json` | `%APPDATA%\MeetingMaster\recipients.json` (set on the setup page) | Home server — preset recipient list |
| `config/email_template.example.txt` | `%APPDATA%\MeetingMaster\email_template.txt` (set on the setup page) | Home server — email subject/body template |
| `config/laptop.env.example` | app Settings (from the Connection Code); dev: `app/laptop.env` | Laptop app — server URL, token, email mode, page size |

## Development

Everything runs on Linux/macOS too for development; Windows is the deployment
target.

**Laptop app** (Electron):

```bash
cd app
npm install
npm start
```

Dev nicety: press **Ctrl+Shift+M** in the running app to load the mock meeting
fixture (`app/test/fixtures/mockMeeting.json`) — details, cards, transcript,
and summary — so you can exercise PDF rendering without a home server.

**Home server** (FastAPI):

```bash
cd server
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python -m app.main   # serves on 0.0.0.0:8080
```

With no `BEARER_TOKEN` configured the server starts in **setup mode** — open
`http://127.0.0.1:8080/setup` to configure it (the same page the installed app
shows on first run). Settings are written to the config home
(`$XDG_CONFIG_HOME/MeetingMaster` on Linux/macOS, `%APPDATA%\MeetingMaster` on
Windows); override it with `MEETING_MASTER_HOME`. In a dev checkout, ffmpeg and
`whisper-cli` are taken from `PATH`; the packaged server bundles them.

**Test suites:**

```bash
cd app && npx playwright test
cd server && python -m pytest tests/ -q
```
