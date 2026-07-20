# Fonts — Neue Haas Grotesk

The PDF's typography contract (24pt details and questions, 16pt summary) is
set in **Neue Haas Grotesk**. The font files are licensed and therefore never
committed — you supply them.

## Expected filenames

Exactly two font bases, in any of three formats (`.woff2` preferred, then
`.otf`, then `.ttf` — the first extension found wins):

| Weight | Filename |
| --- | --- |
| Roman (400) | `NeueHaasGrotesk-Roman.woff2` / `.otf` / `.ttf` |
| Bold (700) | `NeueHaasGrotesk-Bold.woff2` / `.otf` / `.ttf` |
- `NeueHaasGrotesk-Medium.woff2` / `.otf` / `.ttf` — **optional** third weight;
  gives the PDF's small uppercase labels a true 500 weight instead of a
  synthesized one. Everything works without it.

Any other filename is not picked up. (Lookup logic:
`app/src/main/paths.js` → `findFont()`.)

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

Lookup order per file: user folder then bundled dir, `.woff2` → `.otf` →
`.ttf` (`app/src/main/paths.js` → `findFont()`).

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
