# Working on Meeting Master

Notes for whoever picks this up next — human or agent. Short on purpose.

## Branching: `main`, and only `main`

**`main` is the release branch and the default branch. Work on it.**

This is written down because the alternative was tried and failed. For a while
every session cut its own `claude/<topic>` branch, and the result was five
branches where the newest release (v0.19.3) lived on one of them, the
repository's default branch pointer sat on another that was **twelve minor
versions behind**, and three finished commits on a third were orphaned for a
month before anyone noticed. Two consecutive sessions started from v0.7.0
believing it was current. A short-lived branch for a risky experiment is fine;
a long-lived one is how work gets lost.

## Every session that ships, ships a release

There is no separate release process. Finish the work, then:

1. **Bump the version in all three places.** CI fails fast if they disagree,
   and again if the tag does not match:
   - `app/package.json`
   - `app/package-lock.json` — **two** `"version"` entries near the top
   - `server/app/config.py` → `APP_VERSION`
2. Commit the bump together with the feature work, the way every release so
   far has.
3. `git push -u origin main`
4. `git tag -a vX.Y.Z -m "…" && git push origin vX.Y.Z`

The tag is what publishes. `.github/workflows/build-installers.yml` builds the
Windows installer and cuts a GitHub Release on any `v*` tag; pushing to `main`
alone only runs the build. Releases stay `prerelease: true` until the builds
are code-signed and the licensed fonts are bundled — the home server's
auto-update feed reads them either way.

Minor bump for features, patch for fixes. Nothing here is at 1.0, and the two
halves ship as one product, so their version numbers are the same number.

## Tests: three suites, all of them

```
cd app    && npm run test:unit      # node:test, structural invariants
cd app    && npx playwright test    # Chromium against the real renderer
cd server && python -m pytest tests/ -q
```

Green in all three before the version bump, not after. The app suites need no
home server; the server suite stubs whisper and the model (`server/tests/stubs/`).

## Invariants that tests enforce, and why

Several tests read source files instead of running them. That is deliberate —
they cover wiring that no functional test can reach — so when one fails, fix
the code, not the test.

- **`app/src/renderer/print/print.css` has no literal `font-size`.** Nine
  `--fs-*` tokens on `:root`, each with one job, sized for large print (14pt
  body, nothing under 10pt). It drifted to fourteen sizes once, five of them a
  half-point apart. `print.spec.js` checks the stylesheet *and* the computed
  sizes.
- **`app/src/renderer/css/app.css` has no literal `font-size` either** — every
  step is `calc(… * var(--fs-scale))` so the Text size setting works.
  (`textscale.spec.js`.)
- **The live transcript draft never becomes `state.transcript`,** and the AI
  prompt is always built from the server transcript. `transcriptSource.test.js`
  pins the exhaustive list of writers.
- **The PDF transcript appendix is opt-in and off by default,** and all three
  IPC hops carry the argument. `pdfWiring.test.js`.

## Shape of the thing

Electron app (vanilla ES modules, no bundler) + FastAPI server on the user's
home PC, over Tailscale with a shared bearer token. One installer; the mode is
picked at runtime. `contextIsolation: true` — the renderer has no `fs`, so
everything crosses through `src/preload/preload.js`.

Pipeline: ffmpeg → whisper.cpp → the AI provider (`server/app/pipeline/_provider.py`
— Ollama by default, or the locally-authenticated Claude CLI).

`docs/ARCHITECTURE.md` has the long version. `docs/SETUP_HOMEPC.md` and
`docs/SETUP_LAPTOP.md` are what the user actually follows.
