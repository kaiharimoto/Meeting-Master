# Fonts — Neue Haas Grotesk

The PDF's typography contract (24pt details and questions, 16pt summary) is
set in **Neue Haas Grotesk**. The font files are licensed and therefore never
committed — you supply them.

## Drop each weight into its folder — any file name (v0.4.0+)

Open the fonts folder from the app (**Settings → Open fonts folder**). Inside
are three weight folders; put ONE font file in each — **the file name does not
matter**, so foundry downloads work as-is:

| Folder | Weight it supplies |
| --- | --- |
| `roman/` | Roman (400) — body text |
| `bold/` | Bold (700) — headings |
| `medium/` | Medium (500) — **optional**; true weight for the small uppercase labels (synthesized without it) |

Formats accepted: `.woff2` (preferred), `.woff`, `.otf`, `.ttf`. If a folder
somehow contains several files, the best format (then alphabetical) wins.

Legacy exact-name files still work as a fallback — `NeueHaasGrotesk-Roman.*`,
`NeueHaasGrotesk-Bold.*`, `NeueHaasGrotesk-Medium.*` directly in the fonts
folder. (Lookup logic: `app/src/main/paths.js` → `findFont()`.)

## Where the files live

- **Installed app (the normal case):** the **user fonts folder** —
  `%APPDATA%\meeting-master-app\fonts` on Windows (Electron's `userData`
  directory + `fonts`). Open it from the app: **Settings → Open fonts
  folder**. This location **survives app updates** — the installer never
  touches it. Drop the files there once and every future version keeps them.
- **Development:** `app/assets/fonts/` (next to
  `app/assets/fonts/README.md`).
- **Bundled fallback:** `resources/fonts/` (`process.resourcesPath`) — fonts
  present in `app/assets/fonts/` at `npm run dist` time are copied here by
  `extraResources`. The user folder is checked FIRST; the bundled dir is only
  a fallback, because updates replace it wholesale. On startup the app
  migrates any fonts it finds in the bundled dir into the user folder
  (`paths.migrateFonts()`), so pre-0.2.1 installs keep their fonts across
  the next update automatically.

Lookup order per weight: the weight folder (`roman/`, `bold/`, `medium/` in
the user folder, any file name), then exact-name files in the user folder,
then the bundled dir.

## How the fonts reach the PDF (runtime injection)

`app/src/renderer/print/print.css` deliberately contains **no `@font-face`
rules**. Instead, `app/src/main/pdf.js` injects them at render time with
`webContents.insertCSS`, using absolute `file://` URLs to whichever files
`findFont()` located. This is what makes the same code work in both layouts —
dev (`app/assets/fonts`) and packaged (`resources/fonts`) — without any
build-time path rewriting.

The render then waits for `document.fonts.ready` (after explicitly
`fonts.load()`-ing both weights) **before** calling `printToPDF` — skipping
that wait is the classic cause of wrong-font PDFs.

## Fallback and warning behavior

- **Both files missing:** injection is skipped and `print.css` falls back to
  Arial (`font-family: 'Neue Haas Grotesk', Arial, sans-serif`). The render
  still succeeds; `renderPdf()` returns `fontUsed: false` plus a `warning`
  telling you which directory to drop the files into, and the app shows it on
  the status line. Nothing blocks — you just get an Arial PDF.
- **One weight missing:** the present weight is injected and used
  (`fontUsed: true`), and a `warning` notes that the missing weight will be
  synthesized/substituted.
- **Both present:** `fontUsed: true`, `warning: null`.

## Licensing

Neue Haas Grotesk is a **commercial Monotype typeface**. Licensing it for
this use is your responsibility — the repo neither contains nor downloads it.
That is exactly why `app/assets/fonts/` is git-ignored (see `.gitignore`):
**never commit the font files**, even in a private fork.
