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
