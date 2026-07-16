# Laptop setup (Windows work laptop)

The laptop runs the Meeting Master Electron app — a **portable single .exe**
that needs no installer and no admin rights. Set up the
[home PC](SETUP_HOMEPC.md) first: you need its `https://…ts.net` URL and the
shared `BEARER_TOKEN`.

## 1. Get the app

**Option A — portable exe (normal use).** Copy
`MeetingMaster-portable-0.1.0.exe` (built in step 5) anywhere on the laptop
and double-click it. Nothing is installed; settings live in
`%APPDATA%\MeetingMaster\`.

**Option B — run from source (development):**

```powershell
cd app
npm install
npm start
```

(or run [`scripts/laptop/dev.ps1`](../scripts/laptop/dev.ps1), which does the
same).

## 2. Tailscale

Install Tailscale on the laptop and sign in to the **same tailnet** as the
home PC:

```powershell
winget install Tailscale.Tailscale
```

Verify the home server is reachable by opening
`https://homepc.tail-xxxx.ts.net/health` in a browser — it should show
`{"status":"ok"}`.

If the laptop is managed and you cannot install Tailscale, see the last-resort
options in
[TROUBLESHOOTING.md](TROUBLESHOOTING.md#managed-laptop-cant-install-tailscale).

## 3. laptop.env

The app reads its config from `laptop.env`. It shows the exact path it is
using (and where to create the file if it doesn't exist yet) in its Settings
area — normally:

```text
C:\Users\<you>\AppData\Roaming\MeetingMaster\laptop.env
```

In development you can instead keep a `laptop.env` next to `app\package.json`
(the user-data location wins if both exist; real environment variables
override both).

Copy the template `config\laptop.env.example` there and fill in:

```ini
HOME_SERVER_URL=https://homepc.tail-xxxx.ts.net
BEARER_TOKEN=<same string as BEARER_TOKEN in the home PC's server.env>
EMAIL_MODE=home
PAGE_SIZE=Letter
```

- `EMAIL_MODE=home` (the default) keeps Gmail credentials off this laptop and
  works even where the corporate network blocks SMTP. Only set
  `EMAIL_MODE=laptop` (plus `SMTP_USER` / `SMTP_APP_PASSWORD`) if the home
  path is unavailable.
- `PAGE_SIZE` is `Letter` or `A4`.

## 4. Fonts (Neue Haas Grotesk)

The PDF is rendered with your licensed **Neue Haas Grotesk** files. Drop them
in with these exact names (details, expected filenames, and licensing notes:
[FONTS.md](FONTS.md)):

- **Development:** `app\assets\fonts\NeueHaasGrotesk-Roman.woff2` (or
  `.otf`/`.ttf`) and `NeueHaasGrotesk-Bold.*`.
- **Packaged app:** the files must be in `app\assets\fonts\` **at build
  time** — `npm run dist` copies them into the exe's `resources\fonts`
  folder (electron-builder `extraResources`), which is where the packaged app
  looks at runtime.

Without them the app still works — PDFs fall back to Arial and the app shows
a non-blocking warning.

## 5. Building the portable exe

On any machine with Node.js (the fonts must be in `app\assets\fonts\` first —
see step 4):

```powershell
cd app
npm install
npm run dist
```

Output: `app\dist\MeetingMaster-portable-0.1.0.exe`. Copy that single file to
the work laptop.

**SmartScreen note:** the exe is unsigned, so the first launch on a new
machine shows "Windows protected your PC". Click **More info → Run anyway**.
If that's unacceptable (or blocked by policy), the fix is Authenticode
code-signing with a certificate — electron-builder supports it via its `win`
signing options — but that is optional and costs a yearly cert fee.

## 6. First-run check

1. Launch the app; confirm the Settings area shows your config path and the
   `https://…ts.net` server URL (and that a token is configured).
2. Fill in a dummy meeting, press **Q**, and capture a test card
   (Q → question, Tab → answer, Tab → participant, Enter).
3. Click **Generate PDF** (works even without an AI job — the summary shows a
   placeholder) and check the PDF opens in the right font with color fills.
4. Full dress rehearsal with a short WAV: **Pick audio & start AI**, wait for
   **ready**, **Generate PDF**, **Send email** — then check the recipients'
   inbox.

The day-to-day flow is the "Repeatable per-meeting workflow" in the
[README](../README.md#repeatable-per-meeting-workflow).
