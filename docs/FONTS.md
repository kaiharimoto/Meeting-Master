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

Any other filename is not picked up. (Lookup logic:
`app/src/main/paths.js` → `findFont()`.)

## Where the files live

- **Development:** `app/assets/fonts/` (next to
  `app/assets/fonts/README.md`).
- **Packaged app:** `resources/fonts/` — the app's unpacked resources
  directory (`process.resourcesPath`), where electron-builder's
  `extraResources` places them. This means the files must be present in
  `app/assets/fonts/` **when you run `npm run dist`**; the build copies them
  into the exe. They are deliberately kept outside the asar archive so the
  renderer can load them via plain `file://` URLs.

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
