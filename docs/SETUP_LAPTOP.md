# Laptop setup (Windows work laptop)

The laptop runs the Meeting Master app. Setup is: install the app, install
Tailscale, paste the **Connection Code** from the home PC. Set up the
[home PC](SETUP_HOMEPC.md) first — its setup page gives you the Connection Code
you'll paste in step 3.

## 1. Install the app

1. Download **`MeetingMaster-Setup-<version>.exe`** — the ONE Meeting Master
   installer, same file as the home PC — from the
   [latest release](../../releases/latest). (No release yet? Open the
   **build-installers** run under the repo's **Actions** tab and download the
   **`app-installer`** artifact.)
2. Double-click it and click through the installer. It installs per-user — **no
   admin rights required.**
3. Launch Meeting Master and choose **Operator** mode on the first-run screen.

**SmartScreen note:** the installer is unsigned, so the first launch may show
"Windows protected your PC". Click **More info → Run anyway**. (Optional fix:
Authenticode code-signing — see
[TROUBLESHOOTING.md](TROUBLESHOOTING.md#windows-smartscreen-blocks-the-installer).)

## 2. Tailscale

Install **Tailscale** on the laptop and **sign in to the same account** you
used on the home PC — both machines must be on the same tailnet. Download it
from <https://tailscale.com/download/windows>.

If the laptop is locked down and you cannot install Tailscale, see the
last-resort options in
[TROUBLESHOOTING.md](TROUBLESHOOTING.md#managed-laptop-cant-install-tailscale).

## 3. Pair with the home PC

1. Open **Meeting Master** → **Settings**.
2. **Paste the Connection Code** from the home PC's setup page (the string it
   showed after *Save & Finish*).
3. Click **Save**.

That's it — the code carries both the home server's tailnet URL and the shared
secret, so there is nothing else to type. If the app later reports the code was
rejected, regenerate it on the home PC's setup page and paste the new one
([TROUBLESHOOTING.md](TROUBLESHOOTING.md#connection-code-rejected)).

## 4. Fonts (Neue Haas Grotesk)

The PDF is rendered with your licensed **Neue Haas Grotesk** files. Open the
app's fonts folder from **Settings → Open fonts folder** and drop them in
using the exact filenames in [FONTS.md](FONTS.md)
(`NeueHaasGrotesk-Roman.woff2`/`.otf`/`.ttf` and `NeueHaasGrotesk-Bold.*`).
The folder survives app updates.

Without them the app still works — PDFs fall back to Arial and the app shows a
non-blocking warning.

## 5. First-run check

1. Launch the app; confirm **Settings** shows a configured server (a green /
   "connected" indicator) after pasting the Connection Code.
2. Fill in a dummy meeting, press **Q**, and capture a test card
   (Q → question, Tab → answer, Tab → participant, Enter).
3. Click **Generate PDF** (works even without an AI job — the summary shows a
   placeholder) and check the PDF opens in the right font with color fills.
4. Full dress rehearsal with a short WAV: **Pick audio & start AI**, wait for
   **ready**, **Generate PDF**, **Send email** — then check the recipients'
   inbox.

The day-to-day flow is the "Repeatable per-meeting workflow" in the
[README](../README.md#repeatable-per-meeting-workflow).

## 6. Finding your way around the app

- The **sidebar** switches between **Meeting** (capture + generate), **Activity**
  (live pipeline for the current job, the home server's recent jobs, and its
  streaming log), **History** (reopen past meetings), and **Settings**.
- The **server pill** at the bottom of the sidebar shows home-server
  reachability at a glance (green = online, amber = not configured, red =
  unreachable) — click it for details.
- The **sun/moon button** toggles light/dark; the app follows your Windows
  theme until you choose one explicitly. Press <kbd>?</kbd> anywhere for the
  keyboard-shortcut list.

---

**Developers** running the app from source (`npm start`): see the Development
section of the [README](../README.md#development).
