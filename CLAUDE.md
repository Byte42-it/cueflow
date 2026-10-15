# Cueflow — notes for whoever (human or AI) continues this project

## What this is and why

Open-source tool to make **narrated UI tutorials without recording video**. Origin: the sister project
`/mnt/c/Users/luca/Projects/chess.ai` (chess lessons described as structured data and rendered with a voice-over, no
video). Same principle applied to any web site/portal (first target: the lawyers' portal "Sol", `../sol`): a guide
like "how to upload a document" is data, not a recording; translating or fixing it means editing text and rebuilding.

Decisions taken with the owner (Luca) — do not re-litigate:
- **Standalone, open-source repo**, site-agnostic. Not an embeddable widget for third parties: the output is an HTML file
  used internally (opened directly or put in an iframe of the product's own help).
- **The "video" is a live, shrunk HTML page** (iframe + camera + cursor overlay), not a rendered mp4. It may show only
  a region of the site (header only, an upload panel…), never necessarily the whole page.
- **Authoring goes through MCP**, with a human reviewing. The model must be able to *see* what it makes
  (`preview_frame`) and be corrected when it targets something that does not exist (selector validation = the
  equivalent of illegal-move rejection in the chess project).
- Name: **Cueflow** (npm `cueflow` and scope `@cueflow` were free on 2026-10-14; not registered yet).
- Scenes use the site's real CSS/fonts via `shared/`, with **fake data only** (privacy: never real client documents).
- **Everything reusable on any site lives in Cueflow; anything specific to one product stays in that product's repo.**
  `sol/docs` (SAUL) grew its own tutorial player, guide shell and catalog in parallel; the plan to fold the generic
  parts into Cueflow, leaving only a SAUL kit in `sol`, is in [docs/merge-sol-docs.md](docs/merge-sol-docs.md)
  (steps 1, 2, 4, 5, 6 and 7 are done; 3 partly — providers and pronunciation from the brief, but the voice style is still fixed in `tts.ts`; the `sol` clean-up is not). Target flow: the user adds the MCP
  server (a local stdio server, not a hosted link) → Claude first asks which site (local folder, later https) →
  studies it → agrees a brief → authors tutorials → `build_site`.

## Architecture (src/)

| File | Role |
|---|---|
| `schema.ts` | zod schemas: `Guide`, `Step`, `Action` (move, click, type, highlight, set, show, hide, tween, camera), `Camera` |
| `kit.ts` | kit folder layout, load/save guides (atomic write), list scenes/guides |
| `scene.ts` | `inlineScene` (inlines local CSS/JS/images/fonts → one standalone HTML; with a `Shared` map, stylesheets and images go there once by hash and the scene keeps placeholders), `bestFontSources` (one format per @font-face), `describeScene` (targetable elements + best selector), `countMatches` |
| `capture.ts` | `capture.json` (zod) → Playwright: login, steps, cues, remove/hide, replace, script; `freezePage` runs in the page and works on a **copy** of the document (the live page stays usable for the next scene); assets mirrored in `shared/` (best font format only, image type sniffed) |
| `validate.ts` | checks selectors against the scene current at each step, duplicate ids, unknown scenes, missing narration per language |
| `tts.ts` | `TtsProvider` interface (+ `format`: mp3/m4a/wav/ogg) with OpenAI, `command` (any local program, e.g. Piper) and `say` (macOS) providers; on-disk cache keyed by hash(provider, voice, lang, text); ported from `chess.ai/packages/server/src/tts.ts` |
| `theme.ts` | optional kit `theme/`: `theme.css` appended after the player CSS (urls inlined), `labels.json` (player words per language, validated) |
| `build.ts` | guide → `dist/<id>.html` (player + css + scenes + `shared` + base64 audio, JSON embedded script-safe); `estimateDuration` (same rule as the silent player) |
| `player/player.js`, `player.css` | browser runtime, plain JS inlined at build time (not bundled/compiled) |
| `site.ts` | `site.json` catalog → `dist/site/` (home + one page per item: player, transcript, `pages/<id>.html` article); validation, posters via `preview.ts` |
| `site/site.js`, `site.css` | docs-site runtime (left bar, drawer, request dialog, tiles/rows/hover preview, item page index/search/print); shipped with the player in `assets/cueflow.js`/`.css` |
| `preview.ts` | `launchChromium` (lang, `CUEFLOW_CHROMIUM`), `openPreview` session over a built guide: `seek` (ms or "80%"), `frame` (player, or stage without cursor/ring/mark), `probe`, contact `sheet` |
| `layout.ts` | `checkLayout`: plays the guide and probes every element used by camera/move/click/highlight/type/form actions at its moment (found, visible, inside the scene) |
| `studio.ts`, `studio/` | `cueflow studio`: local HTTP server (127.0.0.1 only, Host check, mutating calls need the `x-cueflow` header) + plain-JS page. Layout like a video editor: bottom bar of pages (Media, Timeline, Voice, Export), timeline strip drawn from the estimated step timings (`timing` in `/api/state`), dark by default. API: state, guide GET/PUT (validated, refused as 409 if the file changed meanwhile), `/preview/<id>` (silent build, browser voice), `/scene/<name>`, check, build (uses the chosen voices), `/out/*` (built files), guide-create, elements, brief, voices, key (written to the kit's `.env`, never returned), voice sample, SSE `/events` (mtime polling: also picks up an assistant's edits). No embedded agent: MCP first |
| `settings.ts`, `voices.ts` | `cueflow.json` (zod): `outDir` (fixed by `cueflow init`, default `../cueflow-dist` for a project kit) and `voices` with **inheritance** video-language › video › language › global › browser (`resolveVoice`); `voiceFor` turns it into a provider (an external voice is explicit: no key-only auto-switch, a missing key is an error), `setVoice`, `voiceOptions` (plain-words catalogue for Studio/assistants) |
| `brief.ts`, `method.ts` | `brief.json` (what was agreed with the user: source, audience, tone, languages, rules, pronunciation, maxSeconds; the only home of product rules) and `kitStatus` (what to do next); `METHOD`/`INSTRUCTIONS`, the working method served by `get_method` — must never name a product |
| `mcp.ts` | MCP server (stdio): capture_scenes, list_scenes, inspect_scene, create_guide, get_guide, add_step, replace_step, remove_step, set_narration, validate_guide (+layout), build_guide, preview_frame, validate_site, build_site |
| `cli.ts` | `cueflow init|voices|capture|build|validate [--layout]|preview|site|mcp`; the kit is `--kit`, `CUEFLOW_KIT`, the nearest `.cueflow/` upwards (`findKitRoot`), or the current folder |

Player model worth knowing before touching it:
- Each action has `start/update(p)/finish` handlers; `runDue(step, t, ctx)` is **idempotent** and is used both by live
  playback (rAF clock, pausable) and by `seek` (reload scene, replay earlier steps instantly, then the current one up to t).
  Keep new actions compatible with both modes (`ctx.instant`).
- `at` is ms or a percentage of narration length (`"40%"`); narration length = audio duration, or an estimate
  (65 ms/char, min 1.5 s) when silent.
- Camera = scale + translate of a "world" div (scene viewport size, default 1280×720) inside the stage; clamped so the
  scene always covers the stage. Camera rects are measured when the camera is applied, so if the layout changes
  during a step (things shown/hidden) add a `camera` action after the change.
- `click` dispatches a real `click` event in the scene iframe (same-origin `srcdoc`), so scenes can have small scripts.
- `DATA.shared` holds stylesheets/images once; `loadScene` expands the placeholders (`withShared`) before `srcdoc`.
- `window.__cueflow` also exposes `probe(selector)` (used by `checkLayout`); `seek` accepts a percentage like `at`.
- Cursor/camera movement uses CSS transitions (they keep running while paused: known, minor).

## Commands

```bash
npm run typecheck
npm test                       # node:test, no browser needed
npm run build:demo             # examples/demo-kit/dist/upload.html (open it in a browser)
CUEFLOW_TTS=none node src/cli.ts build upload --kit examples/demo-kit   # force silent build
node src/cli.ts site --kit examples/demo-kit             # examples/demo-kit/dist/site/ (add --posters for guide frames)
node src/cli.ts capture --kit <kit>                      # scenes from the live site (capture.json)
node src/cli.ts validate <guide> --layout --kit <kit>    # + visibility/position in a browser
node src/cli.ts preview <guide> --all --kit <kit>        # dist/preview/<guide>-sheet.png
node src/cli.ts mcp --kit <kit>
```
Node ≥ 22.18 runs the `.ts` files directly (imports use the `.ts` extension; `tsc` is only used with `--noEmit`).
Preview needs Chromium: `npx playwright install chromium` (already installed on the dev machine; headless lacks emoji fonts).
Env: `OPENAI_API_KEY` (enables TTS), `CUEFLOW_TTS=none|openai|say|command`, `CUEFLOW_TTS_COMMAND`, `CUEFLOW_TTS_FORMAT`,
`CUEFLOW_TTS_MODEL`, `CUEFLOW_TTS_VOICE`, `CUEFLOW_KIT`, `CUEFLOW_CHROMIUM` (browser executable when Playwright's own
Chromium build is not installed).

## State (2026-10-14)

Proof of concept, then a first real kit: the H2O Delivery back office (GAzie), in `../h2odelivery.it/docs/video-tutorial`
— 5 scenes captured with `cueflow capture` (capture.json + 3 small scripts), a 17-step Italian guide, a docs site
with a written guide and a dark theme. Its lessons became the
improvements of 2026-10-14 (branch `feat/real-kit-improvements`): capture, shared stylesheets/images and one font format
(guide 14.6 MB → 1.6 MB silent), `say`/`command` voices, preview CLI and contact sheets, `validate --layout`,
`select`/`value`/`check` actions, `player.brand`, site `colorScheme` and `--cf-site-on-primary`/`--cf-site-veil`,
raster logos, computed durations. 37 tests green (no browser needed).
**Audio verified end to end with `CUEFLOW_TTS=say`** (m4a, real durations read by the player, live playback);
**the OpenAI path ran once against the real API (2026-10-14, 8 mp3 for the demo; not listened to, player timing with
those files not checked).** On the dev machine Playwright 1.64 wants a Chromium build
that is not installed: use `CUEFLOW_CHROMIUM=~/Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell`.

## Direction (decided with Luca, 2026-10-15)

- **Package**: `npm run build` compiles `src` to `build/` (tsc, `rewriteRelativeImportExtensions`; Node does not run `.ts`
  inside `node_modules`) and copies the player/site assets; `bin` is `build/cli.js`. Not published yet (`npm pack`
  and a real install verified).
- **`.cueflow/`** is a project's kit, committed with the product; output goes to a fixed `cueflow-dist/` beside it
  (configurable once at `init`, then never changed).
- **Voices**: default is the browser's voice; external voices are an explicit choice, at global / language / video
  level, inherited downwards (see `settings.ts`). Studio must offer this as plain-worded choices (`voiceOptions`).
- **Cueflow Studio** (built: pages Media/Timeline/Voice/Export, step and action editing, check and build; not yet: dragging on the timeline, capture from the UI, audio generation with progress): optional `cueflow studio`, a local server + page that reads/writes `.cueflow/`; files
  stay the single source of truth so a person and an assistant can edit the same kit. First version: step list with
  preview, narration/pronunciation editing, click-to-pick selectors in the scene, draggable camera frame, voice
  choices, an "ask the assistant" box using the MCP tools. A full timeline editor only later. MCP first, no embedded
  vendor-specific agent.

## Roadmap (suggested order)

1. ~~Try it on a real site~~ done with H2O (GAzie): `cueflow capture`. Still to try on the lawyers' portal (`../sol`).
2. Run with a real `OPENAI_API_KEY` and fix whatever audio/timing issues appear (the `say` path works).
3. Word-level sync (marks in the narration, or TTS timestamps) instead of percentages.
4. ~~More TTS providers~~ `say` and `command` (Piper via a command template) done; a Piper preset only if asked.
5. Scenes with several states: so far separate captured files plus hidden prepared elements (`hide` + `show`) were
   enough; a "state" concept only if a kit needs many.
6. Export mp4 (record the player with Playwright + ffmpeg) — only if people ask.
7. ~~UI translation of the scene itself~~ done: `scenes/<lang>/<scene>.html`, texts per language, one language per docs site.
8. Publish: TypeScript build step (`tsc` emit or tsdown), register `cueflow` on npm, CI, `.github` templates, an
   English-first README with a GIF of the demo.
9. Site: serve `shared/` as files next to the site's assets instead of embedding it in every item page (each page
   now carries its guide's shared parts once; across pages they repeat).

## Conventions

- Comments explain *why*, are short, English. Errors returned to MCP clients must be readable sentences that tell the
  model how to fix the call.
- Writes go through temp file + rename. Cache files are named by content hash.
- Do not add dependencies lightly: the player is dependency-free on purpose (it ships inside every guide).
- Tests live in `test/`, use the demo kit copied to a temp dir.
