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

From v0.20.2 `build-installers.yml` builds `main` and nothing else — the push
trigger used to name a topic branch too, which is half of how the mess above
happened. Commit to `main`, push to `main`, tag from `main`.

**Two pieces of that cleanup are still owed, both needing the GitHub web UI:**

1. **The default branch pointer is still `claude/meeting-notes-generator-o80jz1`**
   (Settings → General → Default branch → `main`). It is 27 behind as of v0.20.2
   and further behind now. Until it moves, a fresh clone lands on a v0.19-era
   tree. This is not hypothetical: the v0.21.0 session started on a **v0.7.0**
   branch, diagnosed a bug against code that was thirteen minor versions stale,
   and had to be told by the user that it was on the wrong tree.
2. **Six stale branches to delete**, once the pointer has moved off the first
   one. Nothing is lost — re-verified against `main` at v0.21.0 with
   `git rev-list --count origin/main..<branch>`, not assumed:

   | branch | commits not on `main` | note |
   | --- | --- | --- |
   | `claude/meeting-notes-generator-o80jz1` | 0 | currently the default — delete last |
   | `claude/pdf-layout-typography-phzoi2` | 3 (tip `90f6d38`) | **superseded**: the same PDF type scale / large print / `**emphasis**` work was redone on `main` as `fcba549` in v0.20.0. Confirmed present: nine `--fs-*` tokens in `print.css`, emphasis instructions in `summarize.py` and `extract.py` |
   | `claude/program-improvement-ideas-ohvtfe` | 0 | |
   | `claude/transcript-prompt-feedback-mdtj9g` | 0 | |
   | `claude/transcription-alignment-suggestions-erw76y` | 0 | |
   | `claude/whisper-vulkan-gpu-error-aijuxj` | 0 | missing from this list until v0.21.0 — tip `74951ef` is the v0.20.2 commit itself |

   **Both items need the web UI.** These credentials get 403 on `refs/tags/*`
   *and* on branch deletion (`git push origin --delete` → 403), so an agent
   session cannot do either no matter how carefully it verifies them.

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

**Expect to need this.** Two consecutive sessions (v0.20.2, v0.21.0) could push
commits to `main` but got 403 on `refs/tags/*`. Treat the dispatch route as the
normal one, not the fallback.

**If you cannot push a tag, dispatch the workflow instead.** Actions →
build-installers → Run workflow on `main`. The release job takes
`workflow_dispatch` as well as a `v*` tag, reads the version from
`app/package.json`, and `action-gh-release` creates the tag at that commit —
so the result is identical to step 4. v0.20.2 shipped this way, from a session
whose credentials could push commits to `main` but got 403 on `refs/tags/*`.

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
- **`/setup` is loopback-only and unauthenticated; `/admin` is the same
  functionality bearer-gated with the token redacted.** One body, two mounts —
  `routes/admin.py` delegates and holds no logic of its own, and both mounts
  serve a byte-identical `dashboard.js`. `test_admin.py` pins it. Related:
  `require_loopback` rejects forwarded headers and non-loopback `Host`s, because
  `tailscale serve` proxies from 127.0.0.1 and the peer address alone would let
  the tailnet read `BEARER_TOKEN`.
- **Provider-specific kwargs never cross `pipeline/_provider.py`.** `model` and
  `keep_alive` are Ollama's; the dispatcher strips them for the Claude backend,
  whose `chat_json` takes no `model` at all. This was a real outage: `run_live`
  passed an Ollama tag, the CLI got `--model qwen2.5:…`, and every mid-meeting
  tick failed while the summary — which passes no model — worked fine. Live
  suggestions now always run on Ollama whichever provider writes the notes.
- **whisper-cli is only ever passed flags its own `--help` advertised,** on
  both the server and the laptop. whisper.cpp answers an unknown argument by
  printing usage and **exiting 0**, so a wrong guess is a run that reports
  success and transcribed nothing. `whisperFlags.test.js`,
  `test_transcribe_gpu.py`.

## whisper.cpp is a pinned dependency, not a moving one

`WHISPER_CPP_REF` in `build-installers.yml` is a tag. It was `master` until
v0.20.2, and that cost a working release: upstream v1.8.0 turned flash
attention on by default, which kills whisper-cli on the target AMD card, so
v0.20.0 — a release about PDFs — broke every transcription with no change in
this repository. Bumping the pin means reading upstream's notes, building, and
transcribing a real meeting before tagging. The pipeline survives the next one
regardless (`transcribe.py` retries a crashed job on safer paths), but that is
a net, not a plan.

## Shape of the thing

Electron app (vanilla ES modules, no bundler) + FastAPI server on the user's
home PC, over Tailscale with a shared bearer token. One installer; the mode is
picked at runtime. `contextIsolation: true` — the renderer has no `fs`, so
everything crosses through `src/preload/preload.js`.

Pipeline: ffmpeg → whisper.cpp → the AI provider (`server/app/pipeline/_provider.py`
— Ollama by default, or the locally-authenticated Claude CLI).

`docs/ARCHITECTURE.md` has the long version. `docs/SETUP_HOMEPC.md` and
`docs/SETUP_LAPTOP.md` are what the user actually follows.
