<p align="center">
  <img src="assets/brand/cueflow-logo.png" alt="Cueflow" width="560">
</p>

# Cueflow

**Turn UI walkthroughs into maintainable, multilingual guides.**

[MIT license](LICENSE) · [Contributing](CONTRIBUTING.md) · [Built by Byte42](https://byte42.it/)

Narrated, animated walkthroughs of a web interface — without recording a video.

You give Cueflow a **kit**: the static HTML of your site's screens (the real CSS, fonts and layout, no backend).
Through an **MCP server** an AI assistant composes guides on top of it: a camera that frames only the part of the
screen that matters, a cursor that moves and clicks, text that gets typed, progress bars that fill, and a narration
in as many languages as you like. The result is **one self-contained HTML file** that plays like a small video but
is really the live page, shrunk to a window.

Changing a text, translating a guide or following a UI change means editing a line and rebuilding, not re-shooting
and re-dubbing.

## Why Cueflow?

Product onboarding, support tutorials and internal training often become outdated as soon as the interface changes. Cueflow describes a walkthrough as structured data: screens, actions, camera framing and narration. Developers can version and review those guides alongside their application, while AI assistants help author them through the Model Context Protocol (MCP).

- **Use your real interface:** static scenes reuse your CSS, fonts and layout.
- **Guide attention:** camera framing, cursor movements, clicks, typing and highlights show each action.
- **Translate narration:** language-specific text and audio share the same timeline.
- **Share one HTML file:** scenes, player and generated audio are packaged together.
- **Review AI output:** validate selectors and inspect preview frames before sharing a guide.

Cueflow is an early open-source prototype. Feedback, example kits, bug reports and contributions are welcome through this repository's issues and pull requests.

## Getting started

Cueflow is a tool you install once and point at any number of projects. It does not live inside your product.

1. **Install it once** (Node.js 22.18+). Until the package is on npm:
   ```bash
   git clone https://github.com/Byte42-it/cueflow.git ~/tools/cueflow
   cd ~/tools/cueflow && npm install && npx playwright install chromium
   ```
2. **Make a kit inside the project you want to document**, for example `my-product/tutorials/` (see [The kit](#the-kit)).
   The kit is data you version with your product: scenes, guides, theme, catalog. Start from a copy of
   `examples/demo-kit`, or let `capture` build the scenes from your running site.
3. **Connect your AI assistant to that kit** (here Claude Code, run from the kit's folder; any MCP client works):
   ```bash
   claude mcp add cueflow -- node ~/tools/cueflow/src/cli.ts mcp --kit "$(pwd)"
   ```
   Put `OPENAI_API_KEY` (or `CUEFLOW_TTS=say|command`) in a `.env` file in the kit; it is never read from the kit's
   scenes and should be git-ignored.
4. **Ask for tutorials.** Open the assistant in the product's folder and say which flow to explain, who it is for and in
   which languages. It captures the screens, writes the steps (each one checked against the real elements), looks at
   frames with `preview_frame`, and builds the guide and the docs site. You review the previews and the narration.
5. **Publish** the folder `dist/` (one HTML per guide, plus `dist/site/` for the catalog). No server is needed to view it.

The kit stays in your product's repo; Cueflow stays in one place on your machine and is updated with `git pull`.
Nothing product-specific (names, colors, texts, rules) belongs in Cueflow itself.

## The kit

```
my-kit/
  capture.json optional: how to capture the scenes from the live site (see below)
  shared/     CSS, fonts, icons, libraries copied from the real site
  scenes/     one static HTML page per screen/state, using shared/
  guides/     one JSON per guide: camera, actions, narration per language
  theme/      optional: theme.css and labels.json, the look and words of the player
  site.json   optional: the catalog of a docs site (see below)
  pages/      optional: the written guide of each site item, as HTML fragments
  audio/      text-to-speech cache (hash of text + voice + language)
  dist/       output: one HTML file per guide
```

Scenes reference `shared/` instead of copying styles, so when the site's CSS changes every guide follows at the next build.
Give elements an `id` or a `data-cue="…"` attribute: that is what guides point at.

A built guide carries each stylesheet and image of `shared/` once, whatever the number of scenes that use it, and of
each `@font-face` only the best format on disk (woff2, else woff, else ttf/otf): eot, svg and the other fallbacks
for old browsers are left out.

### Capturing the scenes

`node src/cli.ts capture --kit <kit>` opens the live site in Chromium, brings each page to the state a scene needs and
saves it as a static scene, copying its stylesheets, fonts and images to `shared/` with the path they have on the
server. What to capture is data, `capture.json`:

```json
{
  "base": "http://localhost:8080", "lang": "en", "viewport": { "width": 1280, "height": 720 },
  "login": { "url": "/login", "steps": [{ "fill": "#user", "value": "${APP_USER}" }, { "fill": "#password", "value": "${APP_PASSWORD}" }, { "click": "button[type=submit]" }] },
  "remove": ["#chat-widget", ".cookie-banner"],
  "replace": [{ "text": "Real Customer Ltd", "with": "Acme Ltd" }],
  "scenes": [
    { "name": "orders", "url": "/orders", "cues": { "new-order": "button:has-text('New order')" } },
    { "name": "new-order", "steps": [{ "click": "button:has-text('New order')" }, { "waitFor": ".modal" }],
      "cues": { "dialog": ".modal-content" }, "hide": [".modal .preview"], "script": "capture/new-order.js" }
  ]
}
```

Steps are `goto`, `click`, `fill`, `type`, `press`, `select`, `wait` and `waitFor`; selectors are Playwright's (CSS,
`text=…`, `:has-text(…)`). `cues` gives elements the `data-cue` a guide points at, `remove` drops elements (globally or
per scene), `hide` keeps them hidden for a guide to `show`, `replace` swaps texts (real names, plates, emails: scenes
must hold synthetic data only), and `script` runs a file of the kit in the page for what selectors cannot say.
`${NAME}` is read from the environment, so passwords stay out of the kit. A scene without `url` goes on from the
page the previous one left. The capture never changes the live page it reads (scripts aside): the scene is a copy,
without scripts, handlers or forms, with field values frozen. Native date and time fields become text written in
`lang`, because a native field shows the format of whoever watches (`"nativeInputs": true` keeps them).
`--scene <name>` writes only that scene.

### Theme

The player's colors, fonts and shapes are CSS variables (`--cf-bg`, `--cf-fg`, `--cf-accent`, `--cf-font`,
`--cf-stage-radius`… see the top of `src/player/player.css`). `theme/theme.css` is added after the player's own
stylesheet, so it can override them or restyle anything else; fonts and images it points at are inlined.
`theme/labels.json` changes the player's interface words, or adds a language (built in: en, it, fr, de):

```json
{ "en": { "steps": "Chapters", "step": "Chapter" } }
```

An example theme is in `examples/themes/paper/`: copy it to `<kit>/theme/`.

The Cueflow mark sits in a corner of the picture; `player.brand` moves it to the control bar (`"controls"`, never over
the scene) or removes it (`"off"`).

### Player options

Each guide can tune the player in a `player` block (all optional):
`captions` (`below`, `overlay`, `off`), `chapters`, `speeds` (e.g. `[1, 1.5]`), `transcript`, `brand` (`stage`,
`controls`, `off`), and
`fallbackVoice: "browser"` to read silent builds with the browser's voice. `pronunciation` maps written words to
how the voice must say them (audio only). A link ending in `#step-3` opens the guide at that step.

## Use

```bash
# Requires Node.js 22.18 or later; run from the repository checkout.
npm install
node src/cli.ts build upload --kit examples/demo-kit     # → examples/demo-kit/dist/upload.html
node src/cli.ts validate upload --kit examples/demo-kit
```

Open the generated HTML in a browser. Without a voice the guide is silent (captions only, timings estimated).
`CUEFLOW_TTS` chooses the voice; the narration is synthesised once per text and cached in `audio/`:

| `CUEFLOW_TTS` | Voice |
|---|---|
| `openai` (default when `OPENAI_API_KEY` is set) | OpenAI speech (`CUEFLOW_TTS_MODEL`, `CUEFLOW_TTS_VOICE`), mp3 |
| `say` | the voices of macOS, offline and free: the first one installed for the guide's language, or `CUEFLOW_TTS_VOICE`; AAC in m4a |
| `command` | any local program: `CUEFLOW_TTS_COMMAND` with `{text}` (a file with the text), `{out}`, `{lang}`, `{voice}`, and `CUEFLOW_TTS_FORMAT` (mp3, m4a, wav, ogg; default wav). Piper: `piper --model it_IT-paola-medium.onnx --output_file {out} < {text}` |
| `none` | silent |

With audio, each step lasts as long as its recording and the actions placed in percentages follow it.

### Checking a guide

```bash
node src/cli.ts validate upload --kit examples/demo-kit            # selectors, ids, narrations
node src/cli.ts validate upload --layout --kit examples/demo-kit   # also plays it: every element used must be visible and inside the scene
node src/cli.ts preview upload --step 2 --at 80% --kit examples/demo-kit
node src/cli.ts preview upload --all --kit examples/demo-kit       # one PNG per step + a contact sheet, in dist/preview/
```

`--layout` catches what the HTML alone cannot tell: an element below the scene's height (raise the guide's
`viewport`), or one hidden at the moment the cursor goes to it. `preview --stage` renders the picture alone, without
cursor, highlight and mark, as for a poster. Previews run the browser in the guide's language (`--lang` to choose).

### A docs site

`node src/cli.ts site --kit <kit>` turns the kit's `site.json` into a small static docs site in `dist/site/`:
a home page (a featured tutorial, quick access, rows that scroll sideways, a hover preview with the steps and the
contents) and one page per item with its video, the transcript and the written guide. A left bar opens the list of
tutorials, the index of the page (searchable, with print to PDF of chosen sections) and, when `requestEndpoint` is
set, a dialog that POSTs `{ topic, message?, name?, email?, page }` to it. `--posters` renders a frame of each
guide as its cover (needs Playwright). An item without `duration` gets one computed from its guide ("about 3 min").

```json
{
  "title": "Acme Portal Help", "lang": "en", "featured": "upload",
  "rows": [{ "id": "ready", "title": "Watch and read" }, { "id": "soon", "title": "Coming soon", "band": true }],
  "items": [
    { "id": "upload", "row": "ready", "status": "video", "guide": "upload", "title": "How to upload a document" },
    { "id": "search", "row": "soon", "status": "soon", "title": "Finding a document" }
  ]
}
```

`favicon` and `stylesheets` (remote stylesheets such as web fonts, linked from every page) are optional; `brand.logo`
and item icons are SVG (inlined, they take the text color) or png, jpg, gif, webp. `colorScheme` picks the site's
built-in colors: `light` (default), `dark`, or `auto` to follow the visitor's system; a theme's own `:root` colors
always win over them, so a theme that is only light needs nothing, and one that also wants a dark look sets it under
`@media (prefers-color-scheme: dark)`. Text on the primary color is `--cf-site-on-primary`, labels and panels laid
over pictures use `--cf-site-veil`.
`pages/<id>.html` holds `<section id="…" data-title="…">` blocks with `h2`/`h3[id]`: the sections become the index
and the printable units. The site is styled with `--cf-site-*` variables (top of `src/site/site.css`), set in the
same `theme/theme.css` as the player; its interface is in English or Italian (`lang`), and `site.json` `labels`
overrides any word. See `examples/demo-kit`.

### Languages

A guide lists its `languages`; every text in it can be one string or one per language: narration, step titles,
and the text that `type`, `set`, `value` and `select` actions write. When a screen itself must change language, put its translation in
`scenes/<lang>/<scene>.html`, with the same ids: the player shows it for that language, and validation checks the
selectors in every version.

A docs site offers `languages` (with a `fallback`, used when the browser asks for none of them) and chooses one for
all its pages and players: the visitor's earlier choice, else the browser's language, else the fallback. Catalog texts
can be given per language, and a written guide is translated in `pages/<lang>/<id>.html`; until it is, the page shows
the original with a note.

### With an AI assistant (MCP)

```json
{
  "mcpServers": {
    "cueflow": {
      "command": "node",
      "args": ["/path/to/cueflow/src/cli.ts", "mcp", "--kit", "/path/to/my-kit"]
    }
  }
}
```

| Tool | What it does |
|---|---|
| `capture_scenes` | capture the scenes from the live site described in `capture.json` |
| `list_scenes`, `inspect_scene` | what screens exist, and which elements (selector, text, hidden?) can be targeted |
| `create_guide`, `add_step`, `replace_step`, `remove_step`, `get_guide` | compose the timeline |
| `set_narration` | write or translate the narration of a step, per language |
| `validate_guide` | selectors must exist in the scene current at each step, ids unique, every language narrated; `layout` also checks visibility and position in a browser |
| `preview_frame` | render any instant of the guide as an image (`at_ms`, or `at` as a percentage of the narration), to check the framing |
| `validate_site`, `build_site` | check and build the docs site from `site.json` |
| `build_guide` | write `dist/<guide>.html` |

`add_step` checks the selectors immediately, the way a chess lesson checks a move: a step that points at an element
that does not exist is refused with a readable message, so the assistant corrects itself.

## A step

```json
{
  "id": "send",
  "camera": { "target": "#upload-card", "padding": 24 },
  "actions": [
    { "do": "move", "to": "#upload-btn", "at": 0 },
    { "do": "click", "to": "#upload-btn", "at": "25%" },
    { "do": "show", "to": "#progress", "at": "30%" },
    { "do": "tween", "to": "#progress-bar", "prop": "width", "from": "0%", "end": "100%", "at": "30%", "duration": 2200 },
    { "do": "camera", "target": "#upload-card", "at": "86%" }
  ],
  "narration": { "en": "Press Upload…", "it": "Premi Upload…" }
}
```

`at` is milliseconds from the start of the step, or a percentage of the narration length (`"40%"`), so actions stay
in sync with the voice whatever the language or the voice speed. Actions: `move`, `click`, `type`, `highlight`,
`set`, `show`, `hide`, `tween`, `scroll`, `camera`, and for forms `select` (an option, by its text or value), `value`
(set or empty a field at once) and `check` (`"checked": false` unticks). A `click` also dispatches a real click event
inside the scene, so a scene can carry small scripts of its own; the form actions fire `input` and `change`.

## Previews

`capture`, `preview`, `validate --layout`, `site --posters` and `preview_frame` need Chromium:
`npm install playwright && npx playwright install chromium`. To use a Chromium or Chrome already on the machine, set
`CUEFLOW_CHROMIUM` to its executable.

## Development

```bash
npm run typecheck
npm test
CUEFLOW_TTS=none npm run build:demo
```

Use synthetic data in scene kits. Narration is sent to the configured TTS provider when audio generation is enabled. Keep credentials and private customer data out of shared kits and contributions.

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Every PR must disclose whether an AI agent was used, including the agent, model when known, scope of assistance and human verification. Contributions without AI assistance are equally welcome.

## Status

Proof of concept, used on a first real kit (a back office: 5 scenes captured with `capture`, a 17-step guide, a docs
site). Not done yet: exporting an mp4, word-level sync with the narration, a TypeScript build step for publishing to
npm.

Audio has been verified end to end with the macOS voices (`CUEFLOW_TTS=say`): real durations, playback, seeking.
The OpenAI path has not run against the real API yet.

## Producer and references

Cueflow is produced and maintained by **Byte42 s.r.l.**, an Italian technology company working on software, artificial intelligence and next-generation payment systems.

- Website and business enquiries: [byte42.it](https://byte42.it/).
- Company information: [Corporate Disclosure](https://byte42.it/corporate-disclosure/).
- Registered address: Via Anna Magnani 38/54, 58100 Grosseto (GR), Italy.
- VAT number: **01762750535** · REA: **GR-232344**.
- Project support and proposals: use this repository's issues and pull requests.

The [full logo](assets/brand/cueflow-logo.png) is intended for light backgrounds. The [square symbol](assets/brand/cueflow-icon.png) is available for GitLab/GitHub project avatars. See [brand notes](assets/brand/design-notes.md).

## License

Cueflow is released under the [MIT License](LICENSE), permitting use, modification and redistribution, including commercial use, subject to retaining the copyright and license notice. Contributions are accepted under the same license; third-party dependencies and assets retain their respective licenses.

Copyright © 2026 Byte42 s.r.l. and Cueflow contributors.
