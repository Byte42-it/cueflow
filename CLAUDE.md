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

## Architecture (src/)

| File | Role |
|---|---|
| `schema.ts` | zod schemas: `Guide`, `Step`, `Action` (move, click, type, highlight, set, show, hide, tween, camera), `Camera` |
| `kit.ts` | kit folder layout, load/save guides (atomic write), list scenes/guides |
| `scene.ts` | `inlineScene` (inlines local CSS/JS/images/fonts → one standalone HTML), `describeScene` (targetable elements + best selector), `countMatches` |
| `validate.ts` | checks selectors against the scene current at each step, duplicate ids, unknown scenes, missing narration per language |
| `tts.ts` | `TtsProvider` interface + OpenAI provider; on-disk cache keyed by hash(provider, voice, lang, text); ported from `chess.ai/packages/server/src/tts.ts` |
| `theme.ts` | optional kit `theme/`: `theme.css` appended after the player CSS (urls inlined), `labels.json` (player words per language, validated) |
| `build.ts` | guide → `dist/<id>.html` (player + css + scenes + base64 audio, JSON embedded script-safe) |
| `player/player.js`, `player.css` | browser runtime, plain JS inlined at build time (not bundled/compiled) |
| `site.ts` | `site.json` catalog → `dist/site/` (home + one page per item: player, transcript, `pages/<id>.html` article); validation, posters via `preview.ts` |
| `site/site.js`, `site.css` | docs-site runtime (left bar, drawer, request dialog, tiles/rows/hover preview, item page index/search/print); shipped with the player in `assets/cueflow.js`/`.css` |
| `preview.ts` | Playwright renders the built HTML at (step, ms) → PNG; calls `window.__cueflow.seek` |
| `mcp.ts` | MCP server (stdio): list_scenes, inspect_scene, create_guide, get_guide, add_step, replace_step, remove_step, set_narration, validate_guide, build_guide, preview_frame, validate_site, build_site |
| `cli.ts` | `cueflow build|validate|site|mcp --kit <dir>` |

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
- Cursor/camera movement uses CSS transitions (they keep running while paused: known, minor).

## Commands

```bash
npm run typecheck
npm test                       # node:test, no browser needed
npm run build:demo             # examples/demo-kit/dist/upload.html (open it in a browser)
CUEFLOW_TTS=none node src/cli.ts build upload --kit examples/demo-kit   # force silent build
node src/cli.ts site --kit examples/demo-kit             # examples/demo-kit/dist/site/ (add --posters for guide frames)
node src/cli.ts mcp --kit <kit>
```
Node ≥ 22.18 runs the `.ts` files directly (imports use the `.ts` extension; `tsc` is only used with `--noEmit`).
Preview needs Chromium: `npx playwright install chromium` (already installed on the dev machine; headless lacks emoji fonts).
Env: `OPENAI_API_KEY` (enables TTS), `CUEFLOW_TTS=none|openai`, `CUEFLOW_TTS_MODEL`, `CUEFLOW_TTS_VOICE`, `CUEFLOW_KIT`.

## State (2026-10-14)

Proof of concept done and verified: typecheck clean, 9 tests green, live playback checked with Playwright (play, pause,
progress, typing, no console errors), MCP checked with a real client (rejection of a bad selector, image preview).
**Never verified: actual TTS audio** (no API key was available) — the code path in `tts.ts`/`build.ts` and the audio
duration handling in the player (`audioDuration`, `enterStep`) have not run against a real mp3.

## Roadmap (suggested order)

1. **Try it on a real site**: Playwright script to capture scenes from the lawyers' portal (`../sol`) with fake data →
   serialized DOM with CSS inlined, scripts stripped, into `scenes/`. This is where the idea is really tested.
2. Run with a real `OPENAI_API_KEY` and fix whatever audio/timing issues appear.
3. Word-level sync (marks in the narration, or TTS timestamps) instead of percentages.
4. More TTS providers (local Piper so that nobody needs a key); implement `TtsProvider`.
5. `capture` / `list_elements` improvements: scenes with several states (empty / file chosen / uploading / done) as
   separate files vs. driven by `show/hide/set` actions — decide with real examples.
6. Export mp4 (record the player with Playwright + ffmpeg) — only if people ask.
7. UI translation of the scene itself (today the UI language of the scene is fixed; narration can be translated).
8. Publish: TypeScript build step (`tsc` emit or tsdown), register `cueflow` on npm, CI, `.github` templates, an
   English-first README with a GIF of the demo.

## Conventions

- Comments explain *why*, are short, English. Errors returned to MCP clients must be readable sentences that tell the
  model how to fix the call.
- Writes go through temp file + rename. Cache files are named by content hash.
- Do not add dependencies lightly: the player is dependency-free on purpose (it ships inside every guide).
- Tests live in `test/`, use the demo kit copied to a temp dir.
