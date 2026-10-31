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
| `theme.ts` | optional kit `theme/`: `theme.css` appended after the player CSS (urls inlined), `labels.json` (player words per language, validated), `avatar.svg` (the kit's own narrator face; must have the groups of `AVATAR_IDS`, checked at load) |
| `avatar.ts`, `avatars.ts` | the narrator: schema `Avatar` (all fields optional), `AVATAR_DEFAULTS`, `resolveAvatar` (step < video < project < defaults), `isGenerated`; `setAvatar` at one level, `avatarImages` (the pictures a guide may show, inlined), `stepAvatar` (what a step shows), `isKitImage` |
| `avatar-video.ts` | the **generated narrator**: a picture of a person → a clip of that person saying the step. `fantastico` = the video models of Fantastico's catalogue, paid with the Fantastico key: Cueflow mints the runtime key itself (`runtimeKey`: `POST <FANTASTICO_BASE_URL>/<edge|runtime>/key`, what the SDK does inside — the SDK keeps the key private and has no video surface, and is not to be changed), calls the models' video API (`FANTASTICO_MODELS_URL`, `POST /videos`: `heygen/avatar-iv` by default, `prompt` = the spoken text, `input_references` = the picture as a data URL, `aspect_ratio`, `provider.options.heygen` with `voice_id` (= `voices[lang]`; none chosen → `suggestVoice` sends a job without one, the model refuses it naming some of its voices, the first is written to `cueflow.json` `avatar.voices[lang]` by the build and reported as a warning), `background` / `remove_background`), polls `GET /videos/{id}`, downloads `/content`, mints again on 401/402 and on a 403 "key limit exceeded" (the minted key spent its allowance), twice refused = credit exhausted, said in Cueflow's words. **Text-driven**: an audio input would have to be a public HTTPS URL, which a local Cueflow has not (tried: refused), so the model voices the words and `clipAudio` (FFmpeg) makes that voice the step's audio (silence as long as the clip when it has none). Portrait from words: chat completions with `modalities: ["image","text"]`. `command` = a local program through a template, driven by the audio Cueflow made. `stepClip` caches `<kit>/avatar/<hash>.mp4` (+ `.wav`) by provider fingerprint + picture + text/voice (or audio) + hold + background + aspect; `previewOnly` never generates. `IMAGE_MIME`/`imageMimeOf`: png, jpg, webp, **avif**, gif — the model takes jpeg/png only, so `modelPicture` turns the others into png with FFmpeg before the job. Tried and closed (2026-10-31): hosting the step's audio on the models' Files API (`POST /files` works, but `downloadable: false`, `/files/{id}/content` answers "Uploaded files cannot be downloaded", and a job with that URL is accepted then fails) — the audio-driven route needs a public URL Cueflow does not have |
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
- **Narrator** (2026-10-30; `avatar.ts` schema + `resolveAvatar`, `avatars.ts` kit operations): chosen like a voice at
  three levels inherited downwards — the project (`cueflow.json avatar`), a video (`guide.player.avatar`), a step
  (`step.avatar`); every field optional, gaps filled by the level above, then `AVATAR_DEFAULTS`. **Never per language.**
  Fields: `provider` none | svg (a cartoon face drawn by the player, lips moving with the voice: `theme/avatar.svg`
  with the groups of `AVATAR_IDS`, else the built-in `AVATAR_SVG`) | image (a picture of the kit, `image` path, swaying
  and nodding); `mode` off | pip (corner, or `custom` with `x`/`y`) | side (left/right half-bust panel, `size` =
  width) | band (bottom/top, `size` = height) | full; `shape` (pip); `background` colour or kit picture. Pictures travel
  as `DATA.avatarImages` (data URIs; files under `assets/avatar/` in the docs site), the project's choice as
  `DATA.avatarGlobal`. The player's `applyAvatar(step)` at every step entry (and seek) sets classes `cf-av-<mode>
  cf-av-<position>` and inline sizes on `.cf-avatar` (`.cf-av-face` inside holds the svg or img); the move between
  two steps is a CSS transition only while playing. Blink and sway are deterministic from the step time
  (`noise(slot)`); lips from `mouthLevel()`: the audio's loudness (AnalyserNode on `keepAlive`, self-calibrated), else
  the browser voice's word boundaries, else a syllable guess; closed when paused, at a seek, or silent. Never on
  slides; `prefers-reduced-motion` stops blink and sway. `.cf-av-br` moves the Cueflow mark out of a bottom-right pip.
  **The narrator speaks** (2026-10-31, the clips are decided by the *voice*, not by the avatar): `VoiceSpec` has a
  provider `narrator` (`settings.ts`: `voice` = the video model's voice id, optional; `model`; `otherwise` = a
  `PlainVoiceSpec` for the steps where the narrator is not shown, default browser). `guideBundle` resolves the voice
  per language (`resolveVoice`): narrator + a picture (`isKitImage(av.image)`) + narrator shown (`mode !== off`,
  provider not `none`) → `fantasticoAvatarProvider` gets the spoken text, gives back clip + audio (the clip's voice is
  the step's; no TTS paid for that step); no `voice` id → the `otherwise` voice is tried first when it is of the video model's house (a `heygen/*` speech voice such as `noelle` for `heygen/avatar-iv`: same voice in and out of the clips; refused → the model's own), else a real build asks the model (`suggestVoice`); either way the id is written back
  with `setVoice` at the level the voice came from (`voiceTargetOf`) and warns; a preview only reads the cache. The
  other steps speak with `spokenVoice(spec)` = `otherwise` (`providerFromSpec` unwraps it). The avatar's `provider`
  is only *what is shown*: `none | svg | image | command` (`fantastico` is kept as an old name of `image`,
  `resolveAvatar` maps it); `isGenerated` = command only (audio-driven, local), `isPicture` = image/fantastico/command.
  The player uses a clip whenever `DATA.avatarVideo[lang][step]` exists for a picture provider. Studio: the Voice page
  has the option "The narrator speaks" (voice id, model, `otherwise` with its own model/voice selects); the Avatar
  page no longer has a Fantastico provider or voice ids. Chosen by Luca (option 2): two voices, nothing paid where
  the narrator is off, rather than clips everywhere or a narrator that cannot be off. The clip ends with the words, so during `hold` the `<video>`
  shows its last frame. **Between two steps the narrator dissolves** (2026-10-31): every clip starts again from the
  photo's pose, so `applyAvatar` builds a *ghost* (`.cf-av-ghost`, placed like the step before: a canvas with the
  previous clip's last frame, or the picture) that fades out over the first 300 ms of the step on the step clock
  (`paintAvatar`), while a narrator that appears or changes place fades in (`avFade`); same picture, same place → no
  ghost. `clipSettled`/`seek` wait for the ghost's frame, so the export gets it too. No CSS transition any more. Clips travel as `DATA.avatarVideo[lang][stepId]` (data URI; files under `assets/avatar/` in
  the site); `BuildResult.clips`/`clipsMade` tell the credit spent. The player's face is a muted `<video>` on the step
  clock (`syncClip`), the picture stands in where there is no clip (previews). `generate_portrait` (MCP) and
  `POST /api/avatar-portrait` (Studio) draw the person and save the picture in `shared/avatar/`. A narrator without a
  picture yet is a warning, never an error. `test/avatar-video.test.ts` runs stand-ins for Fantastico (`/edge/key`)
  and the models (`/videos`, `/chat/completions`); FFmpeg makes a real clip. Person-facing words say Fantastico only.
  Doors: MCP `set_avatar` (scope global | video | step, `avatar` null = inherit), Studio `POST /api/avatar` (same),
  `validate` checks the pictures exist. Studio: Settings › "Narrator for every tutorial", the **Avatar** page of the
  bottom bar (this video: Auto or its own), the **Avatar lane first on the timeline** (one block per step, what is
  shown and whether it is the step's own) → the step's Avatar tab; `avatarForm` is the one form for the three levels
  (`root` = the project, no Auto). The next provider (an audio-driven service such as HeyGen, one clip per step and
  language) would replace the face in the same layer.
- On a docs page the player fits the window by **narrowing** (`--cf-aspect`, set by `mount`, times the available
  height), never by capping the stage height: a capped stage cropped the bottom of every scene on wide screens.
- Docs home, as a streaming catalog (0.1.53): the featured item is an inset rounded card (`--cf-site-billboard`, a
  shade darker than the hero on light themes) whose picture fades out through a **mask on the image itself**, so no
  edge of a poster can show; under the title, the row it belongs to and its facts (type, length, chapters) as icons.
  "Latest releases" (label `quick`) are tall cards, the catalog's last items first, title running up the left side.
  Rows alternate `--cf-site-row-alt` edge to edge (no borders, no gaps). Covers in lists rest at
  `--cf-site-cover-opacity` under a veil (`--cf-site-cover-shade`) and come to full strength on hover.
- `site.json` `backdrop` (site only, not the theme: the theme is also inlined in standalone guides): an image of the
  kit behind the top of the home; with `size` it is a pattern whose **shape** counts (drawn in
  `--cf-site-backdrop-ink`, optional `glow` around the pointer), without it a picture. `favicon` is also the left bar's
  logo when `brand.logo` is absent; `brand.url` has its own button at the foot of the bar (the logo leads home).
- Calls to action use `--cf-site-cta` (default: the primary), never the primary directly: on most themes the primary
  is also the headings' color, so a brand color there would turn every title. Status badges are filled, one color per
  status (`--cf-site-tag-{video,guide,soon}-bg/-fg`).
- Item page actions (share, print) are two tiles above the index, each opening a dialog. Share: the apps' web
  intents, the link to copy, `navigator.share` where it exists, and "start at chapter N" (`#step-N`) once the video has
  moved on; the dialog lives in the shell, so the home shares the site. Print: the sections to include (the index has
  links only), then `window.print()`.
- Link cards: every page carries og:/twitter: tags written by `site.ts` in **`site.lang`** (a crawler asks for no
  language, so the visitors' fallback does not apply); pictures need site.json `url` (warning without it). The home
  card uses site.json `description`, else the featured item's.
- Analytics (0.1.54): site.json `tagManager` (GTM id) and `scripts` (remote scripts before it, e.g. a consent banner)
  are written into every page's head by `site.ts`; the GTM snippet itself returns early on `file:`, localhost,
  127.* and [::1], so previews never count. `site.js` `track()` pushes to `window.dataLayer` only if it exists: a
  `cueflow_page` first (the Google tag waits for it, so `page_lang` is known), clicks on `[data-cf-cta]` as
  `cueflow_cta` with `cta_id = "cta-" + value` (prefixed `drawer-` inside the drawer, where the same tiles repeat;
  ids would collide, hence the attribute), the player's DOM events (`cueflow:play`/`progress`/`ended`, emitted only
  while playing) as `cueflow_video_*`. Never push what a visitor typed. A new link worth counting gets a
  `data-cf-cta`; event names are a contract with the containers already published, do not rename them.
- Hidden words for screen readers (`.cf-sr`) are absolutely positioned: keep a positioned ancestor inside a scrolling
  row (`.cf-fact`, `.cf-rail` are), or they escape its clipping and widen the page.

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
Chromium build is not installed), `FANTASTICO_BASE_URL`, `FANTASTICO_MODELS_URL`, `FANTASTICO_PRODUCT`, `CUEFLOW_AVATAR_MODEL`, `CUEFLOW_PORTRAIT_MODEL`,
`CUEFLOW_AVATAR_RESOLUTION`, `CUEFLOW_AVATAR_COMMAND` (+ `_FORMAT`) for the generated narrator.

## Pending (2026-10-27): 0.1.53 is on `main` but NOT on npm yet (0.1.54, analytics, follows it)

> **Whoever picks this up next — Luca first — publish it.** `3787555` (docs site layout: streaming-style home,
> share/print dialogs, link cards, `backdrop`, `--cf-site-cta`) was merged and pushed, and the Academy
> (academy.fantastico.cc) and SAUL (tutorial.saul-ai.it) sites were rebuilt with it, from a local checkout. npm still
> serves 0.1.52, so any other kit rebuilt with the published package gets the old layout.
>
> Publishing needs the npmjs credentials of the `byte-42` scope owner, which only Luca has (the token in a dev
> machine's `~/.npmrc` is for the GitLab registry, `@byte42`, and is not valid on npmjs):
> ```bash
> git pull && npm ci && npm publish   # on main; prepack builds, access public is in package.json
> npm view @byte-42/cueflow version   # must say the version in package.json
> ```
> Then delete this section.
>
> Two facts learned on the way, worth keeping after it is gone:
> - The audio cache key contains a hash of `FANTASTICO_API_KEY` (in the provider's fingerprint), so a cache made with
>   one key is invisible to a build with another: changing key regenerates (and pays for) every narration.
> - Those two sites were rebuilt **without** regenerating audio: the narration already embedded in their published
>   pages was written back into the cache under the build's key, only where the kit's text was identical, and the build
>   ran with that same key, so a missing file would have failed instead of calling the paid service.

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
9. ~~Site: serve `shared/` as files next to the site's assets~~ done (2026-10-30): `externalize` in `site.ts` writes
   the scenes' shared stylesheets/images to `assets/shared/<hash>.<ext>` and the audio to
   `assets/audio/<guide>/<lang>/<step>.<ext>`, once per content for the whole site; item pages carry `{ url }` in
   `DATA.shared` and addresses in `DATA.audio`, and the player's `withShared` links instead of inlining (a `<link>` for
   a stylesheet; `:hover` → `.cf-hover` is applied when the file is written). A guide built on its own
   (`dist/<id>.html`, the phone page) stays one self-contained file. This is also what an avatar's clips will use.

## Conventions

- Comments explain *why*, are short, English. Errors returned to MCP clients must be readable sentences that tell the
  model how to fix the call.
- Writes go through temp file + rename. Cache files are named by content hash.
- Do not add dependencies lightly: the player is dependency-free on purpose (it ships inside every guide).
- Tests live in `test/`, use the demo kit copied to a temp dir.
