#!/usr/bin/env node
import path from "node:path";
import { parseArgs } from "node:util";
import { buildGuide, writeAtomic } from "./build.ts";
import { captureScenes } from "./capture.ts";
import { loadGuide, openKit } from "./kit.ts";
import { checkLayout } from "./layout.ts";
import { startMcp } from "./mcp.ts";
import { openPreview } from "./preview.ts";
import { buildSite } from "./site.ts";
import { defaultProvider } from "./tts.ts";
import { validateGuide } from "./validate.ts";

const USAGE = `cueflow — narrated UI walkthroughs from static HTML scenes

  cueflow capture [--scene <name>]...   capture the scenes described in capture.json from the live site
  cueflow build <guide>                 build dist/<guide>.html, with narration audio when a voice is set (CUEFLOW_TTS)
  cueflow validate <guide> [--layout]   check selectors, ids and narrations; --layout also plays the guide in a
                                        browser and checks that every element used is visible and inside the scene
  cueflow preview <guide> [--step <n>] [--at <ms|80%>] [--all] [--stage] [--out <file>]
                                        render a frame as PNG in dist/preview/ (step counted from 1, at default 80%);
                                        --all: one frame per step and a contact sheet of them all
  cueflow site [--posters]              build the docs site from site.json into dist/site/ (--posters renders guide frames)
  cueflow mcp                           start the MCP server on stdio

  --kit <dir>    kit folder (default: $CUEFLOW_KIT or the current directory)
  --lang <code>  language to preview or check (default: the guide's first)

  Voice (CUEFLOW_TTS): openai (OPENAI_API_KEY), say (macOS voices), command (CUEFLOW_TTS_COMMAND, e.g. Piper), none
  Browser (capture, preview, --layout, --posters): Playwright's Chromium, or CUEFLOW_CHROMIUM=<executable>
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    kit: { type: "string" },
    posters: { type: "boolean" },
    layout: { type: "boolean" },
    scene: { type: "string", multiple: true },
    step: { type: "string" },
    at: { type: "string" },
    all: { type: "boolean" },
    stage: { type: "boolean" },
    out: { type: "string" },
    lang: { type: "string" },
    help: { type: "boolean", short: "h" }
  }
});
const kit = openKit(values.kit ?? process.env.CUEFLOW_KIT ?? ".");
const [command, id] = positionals;

/** "2000" → 2000 ms; "80%" stays a percentage of the step's narration */
const parseAt = (v: string | undefined): number | string => {
  if (v == null) return "80%";
  if (/^\d+(\.\d+)?%$/.test(v)) return v;
  if (/^\d+$/.test(v)) return Number(v);
  throw new Error(`--at is milliseconds (2000) or a percentage of the narration (80%), not "${v}"`);
};

async function preview(guideId: string) {
  const built = await buildGuide(kit, guideId, null); // silent: a picture does not need audio
  const session = await openPreview(built.file, { lang: values.lang });
  const at = parseAt(values.at);
  const only = values.stage ? "stage" : "player";
  const dir = path.join(kit.root, "dist", "preview");
  try {
    if (values.all) {
      const frames: { png: Buffer; caption: string }[] = [];
      for (const [i, title] of session.steps.entries()) {
        await session.seek(i, at);
        const png = await session.frame(only);
        await writeAtomic(path.join(dir, guideId, `${String(i + 1).padStart(2, "0")}.png`), png);
        frames.push({ png, caption: `${i + 1} · ${title}` });
      }
      const sheet = values.out ? path.resolve(values.out) : path.join(dir, `${guideId}-sheet.png`);
      await writeAtomic(sheet, await session.sheet(frames));
      console.log(`${sheet}  (${frames.length} steps; one PNG per step in ${path.join(dir, guideId)})`);
    } else {
      const n = values.step ? Number(values.step) : 1;
      if (!Number.isInteger(n) || n < 1) throw new Error(`--step counts from 1, not "${values.step}"`);
      await session.seek(n - 1, at);
      const file = values.out ? path.resolve(values.out) : path.join(dir, `${guideId}-${n}.png`);
      await writeAtomic(file, await session.frame(only));
      console.log(file);
    }
  } finally {
    await session.close();
  }
}

try {
  if (values.help || !command) {
    console.log(USAGE);
  } else if (command === "mcp") {
    await startMcp(kit);
  } else if (command === "capture") {
    const r = await captureScenes(kit, { only: values.scene });
    for (const w of r.warnings) console.log(`warning: ${w}`);
    for (const s of r.scenes) console.log(`${s.file}  (${s.kb} KB)`);
    console.log(`${r.assets} file(s) in shared/`);
  } else if (command === "validate" && id) {
    const report = await validateGuide(kit, await loadGuide(kit, id));
    for (const w of report.warnings) console.log(`warning: ${w}`);
    for (const e of report.errors) console.log(`error: ${e}`);
    if (report.errors.length) process.exitCode = 1;
    else if (values.layout) {
      const layout = await checkLayout(kit, id, { lang: values.lang });
      for (const w of layout) console.log(`layout: ${w}`);
      console.log(layout.length ? `ok, ${layout.length} layout warning(s)` : "ok, layout checked");
    } else console.log("ok");
  } else if (command === "preview" && id) {
    await preview(id);
  } else if (command === "site") {
    const r = await buildSite(kit, { provider: defaultProvider(), posters: values.posters ?? false });
    for (const w of r.warnings) console.log(`warning: ${w}`);
    console.log(`${r.dir}  (${r.pages.length} page(s)${r.posters.length ? `, ${r.posters.length} poster(s) rendered` : ""})`);
  } else if (command === "build" && id) {
    const r = await buildGuide(kit, id, defaultProvider());
    for (const w of r.warnings) console.log(`warning: ${w}`);
    console.log(`${r.file}  (${r.scenes.length} scene(s), ${r.silent ? "silent: set CUEFLOW_TTS (openai, say, command) for narration audio" : `${r.audioFiles} audio file(s)`})`);
  } else {
    console.log(USAGE);
    process.exitCode = 1;
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
}
