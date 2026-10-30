# Cueflow — notes for whoever (human or AI) continues this project

## What this is and why

Open-source tool to make **narrated UI tutorials without recording video**. Origin: a sister project that described
chess lessons as structured data and rendered them with a voice-over, no video. Same principle applied to any web
site/portal: a guide like "how to upload a document" is data, not a recording; translating or fixing it means editing
text and rebuilding.

Decisions taken by the maintainers — do not re-litigate:
- **Standalone, open-source repo**, site-agnostic. Not an embeddable widget for third parties: the output is an HTML file
  used internally (opened directly or put in an iframe of the product's own help).
- **The "video" is a live, shrunk HTML page** (iframe + camera + cursor overlay), not a rendered mp4. It may show only
  a region of the site (header only, an upload panel…), never necessarily the whole page.
- **Authoring goes through MCP**, with a human reviewing. The model must be able to *see* what it makes
  (`preview_frame`) and be corrected when it targets something that does not exist (selector validation = the
  equivalent of rejecting an illegal move in a chess lesson).
- Name: **Cueflow**. npm package `@byte-42/cueflow` (the owner holds the npm organisation `byte-42`; `byte42` was not usable), bin `cueflow`; version in package.json only (`src/version.ts` reads it). `cueflow` alone opens Studio on the project in the current folder, `cueflow <folder>` on another one; no `.cueflow` found upwards = it is created.
- Scenes use the site's real CSS/fonts via `shared/`, with **fake data only** (privacy: never real client documents).
- **Everything reusable on any site lives in Cueflow; anything specific to one product stays in that product's repo.**
  Target flow: the user adds the MCP server (a local stdio server, not a hosted link) → Claude first asks which site
  (local folder, later https) → studies it → agrees a brief → authors tutorials → `build_site`.

## Architecture (src/)

| File | Role |
|---|---|
| `schema.ts` | zod schemas: `Guide`, `Step`, `Action` (move, hover, click, type, highlight with `style` ring/glow/spotlight, set, select, value, check, show, hide, tween, count, grow, draw, reorder, drag, scroll, camera), `Camera`; motion fields shared by the actions: `easing` (named curve or cubic-bezier), `effect` + `stagger` on show/hide, `animate` on state changes; reorder/drag take exactly one of `into` (+ `index`), `before`, `after` (checked in `validate.ts`, a discriminated union cannot refine) |
| `kit.ts` | kit folder layout, load/save guides (atomic write), list scenes/guides |
| `scene.ts` | `inlineScene` (inlines local CSS/JS/images/fonts → one standalone HTML; with a `Shared` map, stylesheets and images go there once by hash and the scene keeps placeholders), `bestFontSources` (one format per @font-face), `describeScene` (targetable elements + best selector), `countMatches` |
| `capture.ts` | `capture.json` (zod) → Playwright: login, steps, cues, remove/hide, replace, script; `freezePage` runs in the page and works on a **copy** of the document (the live page stays usable for the next scene); assets mirrored in `shared/` (best font format only, image type sniffed) |
| `validate.ts` | checks selectors against the scene current at each step, duplicate ids, unknown scenes, missing narration per language |
| `tts.ts` | `TtsProvider` interface (+ `format`: mp3/m4a/wav/ogg) with OpenAI, `command` (any local program, e.g. Piper) and `say` (macOS) providers; on-disk cache keyed by hash(provider, voice, lang, text); ported from the sister chess project |
| `theme.ts` | optional kit `theme/`: `theme.css` appended after the player CSS (urls inlined), `labels.json` (player words per language, validated) |
| `build.ts` | guide → `dist/<id>.html` (player + css + scenes + `shared` + base64 audio, JSON embedded script-safe); `estimateDuration` (same rule as the silent player) |
| `player/player.js`, `player.css` | browser runtime, plain JS inlined at build time (not bundled/compiled) |
| `site.ts` | `site.json` catalog → `dist/site/` (home + one page per item: player, transcript, `pages/<id>.html` article); validation, posters via `preview.ts` |
| `site/site.js`, `site.css` | docs-site runtime (left bar, drawer, request dialog, tiles/rows/hover preview, item page index/search/print); shipped with the player in `assets/cueflow.js`/`.css` |
| `share.ts` | `buildShare`: the page of one video for phones, `<output>/share/<id>/index.html` + `poster.png` (CLI `cueflow share`, Studio Export › "Page for phones", `POST /api/share`). Same player via `renderGuideHtml(..., { extras })` (`PageExtras`: head, css, bodyEnd, mountOptions): fluid, follows the phone's orientation (landscape = picture fills the screen, captions and bar over it), language from `?lang=` then the phone, full screen button + on first Play where the browser allows it (not iPhone), no orientation lock. Link-card tags (og:*) need absolute URLs from site.json `url` (without it: warning, no picture); the picture is a frame of the guide (needs Chromium) |
| `preview.ts` | `launchChromium` (lang, `CUEFLOW_CHROMIUM`), `openPreview` session over a built guide: `seek` (ms or "80%"), `frame` (player, or stage without cursor/ring/mark), `probe`, contact `sheet` |
| `layout.ts` | `checkLayout`: plays the guide and probes every element used by camera/move/click/highlight/type/form actions at its moment (found, visible, inside the scene) |
| `changes.ts`, `sceneedit.ts` | hand edits as **notes for the assistant** (`changes.json`, git-ignored inbox): kind, language, tutorial, target, before → after, `describeChange` sentence; MCP `get_changes` / `mark_changes_seen`; `kitStatus.next` tells to read them first. They are information, never a script to replay. `editSceneElement` edits one element's own text or an attribute in `scenes/<lang>/<scene>.html` (language = isolated sub-project; the copy of the base screen has its relative paths moved one folder up) |
| `agent.ts` | `AgentBridge`: Studio's HTTP door for an assistant that cannot use MCP (`/agent/*`, bearer key kept in the kit's git-ignored `.studio-key` so links survive a restart, `GET /agent/instructions/<key>` = the full prompt as plain text, same tools as the MCP server through an in-memory MCP client); two-way talk: the assistant long-polls `GET /agent/next`, the page enqueues with `POST /api/agent/send`, the assistant answers `/agent/say` and `/agent/done`; presence = a waiting poll, a recent call, or a task in progress; SSE `event: agent` refreshes the page. Without a connected assistant the page falls back to a prompt to copy |
| `prompt.ts`, `trash.ts` | `agentPrompt`: a paste-able prompt for an assistant (first start: how to begin; later: where things stand, what is selected, what to read first), shown on the welcome screen and from the AI button; `deleteTutorial`: moves guide + media to `trash/<date>-<id>/`, drops its catalog items, notes it |
| `media.ts` | where files live: `media/<tutorial>/` (specific to one tutorial) vs `shared/` (several); a scene is specific if one tutorial uses it, shared if several or none; usage by scanning scene HTML and stylesheets; upload/delete (delete refused while used) |
| `articles.ts` | written guides and the catalog as Studio edits them: `catalogOverview` (items, rows, which languages each article exists in), `readArticle`/`writeArticle` (pages/<id>.html, pages/<lang>/ for a translation; stale saves refused by mtime; an `article` note for the assistant), `startTranslation` (a copy of the site's language), `createArticle`, `updateItem` (texts of one language, contents, row, status guide/soon, order in its row; never a video's status), `deleteItem` (articles to `trash/`) |
| `studio.ts`, `studio/` | `cueflow studio`: written guides have their own pages (Write: sections outline + a contenteditable section in a frame with site.css and the theme, `/article-frame`, images via `/kit/pages/…`; Details; Preview) and their own bottom bar, apart from the video ones;  local HTTP server (127.0.0.1 only, Host check, mutating calls need the `x-cueflow` header) + plain-JS page. Layout like a video editor: filmstrip of tutorials (thumbnails = scaled scene iframes) on the left, bottom bar of pages for the selected tutorial (Media, Timeline, Voice, Preview, Export), header with Project (brief) and Export everything (`syncSite` + all guides + site), timeline strip (HTML5 drag & drop reorders steps) drawn from the estimated step timings (`timing` in `/api/state`), dark by default. API: state, guide GET/PUT (validated, refused as 409 if the file changed meanwhile), `/preview/<id>` (silent build, browser voice), `/scene/<name>`, check, build (uses the chosen voices), `/out/*` (built files), guide-create, elements, brief, voices, key (written to the kit's `.env`, never returned), voice sample, SSE `/events` (mtime polling: also picks up an assistant's edits). No embedded agent: MCP first |
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
- **Motion runs on the step clock, never on CSS transitions** (2026-10-30): cursor (`putCursor`), camera (`cameraFor` →
  `setCam`; the step's own framing is `camAnim`, driven by `tickCamera`; a `camera` action interpolates in `update`),
  `show`/`hide` entrances, `tween`, `count`, `scroll` all interpolate in `update(p)` with `eased(a, p)`: pausing stops
  everything, `seek` to a time inside an action gives that exact frame, twice. `easeFn` solves the CSS curves
  (`CURVES`) and `cubic-bezier()`; `spring` is a fixed overshoot (easeOutBack). Defaults per action in `DEFAULT_EASING`
  (`standard` = material (.4,0,.2,1) for cursor and camera). `durationOf` is the single source of an action's length:
  show/hide = `duration + (n−1)·stagger` with n counted in the scene (`staggerSpan`), state changes = `animate`,
  `prefers-reduced-motion` makes everything 0 except typing and counting. `build.ts estimateStepDuration` mirrors it
  without the stagger (no DOM). A `show`/`hide` with `stagger` means *all* the matches (document order); `effect: none`
  + stagger still reveals one at a time. Entrances set inline opacity/transform and restore the element's own inline
  values at `finish` (`_cfStyle`); `animate` sets `transition: all <ms>` for the time of the change (`animated`/`unanimate`).
  `count` reads the start number from the element in the locale's own notation (`numberIn`) and writes with
  `Intl.NumberFormat`.
- **Elements that change place** (`reorder`, `drag`): `relocate` measures the children of the two parents, moves the
  node in the DOM at `start`, and `flipStart` records each one's offset to its old place (FLIP); `update` sets the
  transforms back towards 0 (`flipAt`), `finish` restores the inline transforms. A drag is the same move with the
  element held at its old place, lifted (shadow, scale 1.03, z-index), carried over 15–85 % of the time with the cursor
  on it, while the others make room from 60 %. The DOM changes at `start` in every mode, so a seek into the action
  shows it half way like any other effect; `prefers-reduced-motion` places at once. `hover` adds `.cf-hover`: at scene
  load `withShared` rewrites every `:hover` of the scene's and shared stylesheets to `.cf-hover` (`hoverable`), the
  iframe never gets a real pointer anyway. `highlight` fades its box in and out over 15 % of its time: `.cf-ring`
  (ring, or `.cf-glow`), or `.cf-spot` for spotlight (a window on the element, one 9999px box-shadow is the veil).
  `grow` scales from an edge (`transform-origin`), `draw` runs `stroke-dashoffset` from the path's length to 0; both
  take `stagger` like show/hide. A slow push-in is just a long `camera` action on the same target (no drift concept).
- **`examples/motion-kit`** is the showcase and acceptance test of the vocabulary (one dashboard scene, en + it, guide
  `dashboard`); `test/motion.test.ts` checks it validates clean and, with `CUEFLOW_TEST_BROWSER=1`, drives the player
  (same frame twice, count, camera still when paused, reorder and drag half way, hover, spotlight). The demo kit stays
  as it is: several Studio tests count its guides and media.
- Studio: the ▶ in an action card plays that action alone (`replayAction`: seek 150 ms before `at`, play, pause after
  `actionMs`); `actionMs` is Studio's copy of `durationOf` without the stagger count.
- "What comes next": `site.ts` gives every item page a `next` (the following item of the catalog, row by row, videos
  and written guides alike, never a `soon` one). A video page passes it to `mount(..., { next: { title, href } })` and the
  player shows a "Go to {title}" banner (`.cf-up-next`, label `next`) over the picture once the video has ended; a
  written guide shows the same words as a card at the end of its text (`.cf-up-next-card`, site label `goTo`). The
  banner is light on purpose (it sits on the dark veil whatever the accent); `.cf-next` was already the site's
  section pager, hence the other name. Both links add `?play=1`: the page that receives it mounts with `autoplay`
  and cleans its address. If the browser refuses sound without a click (`NotAllowedError` on the first audio), the
  player goes back to its untouched state with the play button, never a silent run.
- **What the voice reads** (`step.speech`, per language, optional; 2026-10-30): the audio, the browser voice and the length estimate use `spokenOf(step, lang)`, captions and transcript always the narration. Studio stores it only when it differs from the caption (Voice tab of a step, "What the voice reads"), so a caption edited later is followed. For a word that recurs everywhere, the brief's pronunciation is still the place.
- **Slides** (`guide.format: "slides"`, default `"video"`): the same steps, scenes, cameras and actions, one slide per
  step, but no voice, no captions, no transcript, no speed (build skips TTS, validate asks for no narration and no
  length; the narration is optional **speaker's notes**, key N or the Notes button). Advanced by hand, one press per
  **group of actions with the same resolved `at`**: actions at 0 come with the slide, every other distinct `at` is one
  press (PowerPoint-like builds), after the last group the next press goes to the next slide; going back shows the
  previous slide complete. `arm()` parks the groups not pressed yet at `at = Infinity` (originals in `at0`), so
  `runDue` stays the single engine and `seek`/previews/`checkLayout` keep the time semantics. A press while a group
  plays completes it (`runDue(cur, 1e12, instant)`). Presenting (the big button, or Space/→/Page Down before the
  start) goes **full screen on `.cf-app`** (`cf-full`): space, arrows, Page Up/Down (a presenter's remote), Home/End,
  click on the picture; in the page the bar's ‹ › buttons browse without full screen. Never autoplays. If an editor
  calls `play()` (Studio's timeline) the parked groups get their time back and the slides run like a video. Controls
  are `cf-sl-*` (the site already uses `.cf-prev`). The site labels such items "Presentation · N slides", drops the
  transcript section and the print panel when nothing is printable.
- On a docs page the player fits the window by **narrowing** (`--cf-aspect`, set by `mount`, times the available
  height), never by capping the stage height: a capped stage cropped the bottom of every scene on wide screens.

## Commands

```bash
npm run typecheck
npm test                       # node:test, no browser needed
npm run build:demo             # examples/demo-kit/dist/upload.html (open it in a browser)
CUEFLOW_TTS=none node src/cli.ts build upload --kit examples/demo-kit   # force silent build
node src/cli.ts site --kit examples/demo-kit             # examples/demo-kit/dist/site/ (add --posters for guide frames)
node src/cli.ts share upload --kit examples/demo-kit      # dist/share/upload/: page for phones + card picture
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

Proof of concept, then a first real kit made on a PHP back office: 5 scenes captured with `cueflow capture`
(capture.json + 3 small scripts), a 17-step Italian guide, a docs site with a written guide and a dark theme. Its lessons became the
improvements of 2026-10-14 (branch `feat/real-kit-improvements`): capture, shared stylesheets/images and one font format
(guide 14.6 MB → 1.6 MB silent), `say`/`command` voices, preview CLI and contact sheets, `validate --layout`,
`select`/`value`/`check` actions, `player.brand`, site `colorScheme` and `--cf-site-on-primary`/`--cf-site-veil`,
raster logos, computed durations. 37 tests green (no browser needed).
**Audio verified end to end with `CUEFLOW_TTS=say`** (m4a, real durations read by the player, live playback);
**the OpenAI path ran once against the real API (2026-10-14, 8 mp3 for the demo; not listened to, player timing with
those files not checked).** On the dev machine Playwright 1.64 wants a Chromium build
that is not installed: use `CUEFLOW_CHROMIUM=~/Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell`.

## Direction (decided 2026-10-15)

- **Package**: `npm run build` compiles `src` to `build/` (tsc, `rewriteRelativeImportExtensions`; Node does not run `.ts`
  inside `node_modules`) and copies the player/site assets; `bin` is `build/cli.js`. Not published yet (`npm pack`
  and a real install verified).
- **`.cueflow/`** is a project's kit, committed with the product; output goes to `cueflow-dist/` beside it by default;
  the person can change the folder in Studio (Export › "Where the files go", `POST /api/out-dir`, written to cueflow.json). Studio's header shows the project's folder (the parent of `.cueflow`), not the kit and not the destination.
- **Voices**: default is the browser's voice; external voices are an explicit choice, at global / language / video
  level, inherited downwards (see `settings.ts`). Studio must offer this as plain-worded choices (`voiceOptions`).
- **Cueflow Studio** (built: pages Media/Timeline/Voice/Export, step and action editing, check and build; not yet: dragging on the timeline, capture from the UI, audio generation with progress): optional `cueflow studio`, a local server + page that reads/writes `.cueflow/`; files
  stay the single source of truth so a person and an assistant can edit the same kit. First version: step list with
  preview, narration/pronunciation editing, click-to-pick selectors in the scene, draggable camera frame, voice
  choices, an "ask the assistant" box using the MCP tools. A full timeline editor only later. MCP first, no embedded
  vendor-specific agent.

## Roadmap (suggested order)

1. ~~Try it on a real site~~ done: `cueflow capture`.
2. Run with a real `OPENAI_API_KEY` and fix whatever audio/timing issues appear (the `say` path works).
3. Word-level sync (marks in the narration, or TTS timestamps) instead of percentages.
4. ~~More TTS providers~~ `say` and `command` (Piper via a command template) done; a Piper preset only if asked.
5. Scenes with several states: so far separate captured files plus hidden prepared elements (`hide` + `show`) were
   enough; a "state" concept only if a kit needs many.
6. Export mp4 (record the player with Playwright + ffmpeg) — only if people ask.
7. ~~UI translation of the scene itself~~ done: `scenes/<lang>/<scene>.html`, texts per language, one language per docs site.
8. Publish: TypeScript build step (`tsc` emit or tsdown), publish `@byte-42/cueflow` on npm, CI, `.github` templates, an
   English-first README with a GIF of the demo.
9. Site: serve `shared/` as files next to the site's assets instead of embedding it in every item page (each page
   now carries its guide's shared parts once; across pages they repeat).

## Conventions

- Comments explain *why*, are short, English. Errors returned to MCP clients must be readable sentences that tell the
  model how to fix the call.
- Writes go through temp file + rename. Cache files are named by content hash.
- Do not add dependencies lightly: the player is dependency-free on purpose (it ships inside every guide).
- Tests live in `test/`, use the demo kit copied to a temp dir.
