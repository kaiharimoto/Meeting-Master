# Fonts (not committed)

This is the DEV/BUILD location. In the **installed app**, use the update-proof
user folder instead: **Settings → Open fonts folder** (Electron `userData`
`\fonts` — survives every update; see `docs/FONTS.md`).

Drop your licensed **Neue Haas Grotesk** files with these exact names:

- `NeueHaasGrotesk-Roman.woff2` (or `.otf` / `.ttf`)
- `NeueHaasGrotesk-Bold.woff2` (or `.otf` / `.ttf`)
- `NeueHaasGrotesk-Medium.woff2` — optional; sharpens the PDF's small uppercase
  labels (weight 500). Without it those labels synthesize from Roman/Bold.

The app picks up whichever extension it finds (`.woff2` preferred). If the
files are missing, PDFs are generated with an Arial fallback and the app shows
a non-blocking warning.

See `docs/FONTS.md` for details. These files are git-ignored because the
typeface is commercially licensed — never commit them.
