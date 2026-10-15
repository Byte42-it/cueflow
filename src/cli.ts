#!/usr/bin/env node
import path from "node:path";
import { parseArgs } from "node:util";
import { buildGuide, writeAtomic } from "./build.ts";
import { captureScenes } from "./capture.ts";
import { initKit } from "./brief.ts";
import { findKitRoot, loadGuide, openKit } from "./kit.ts";
import { startStudio } from "./studio.ts";
import { agentPrompt } from "./prompt.ts";
import { voiceOptions, voiceTable } from "./voices.ts";
import { checkLayout } from "./layout.ts";
import { startMcp } from "./mcp.ts";
import { openPreview } from "./preview.ts";
import { buildSite, checkEndpoint, loadSite } from "./site.ts";
import { validateGuide } from "./validate.ts";

const USAGE = `cueflow — narrated UI walkthroughs from static HTML scenes

  cueflow init [--out-dir <dir>]        create .cueflow/ in this folder: the kit of the project, and fix where the output goes
                                        (default ../cueflow-dist, next to .cueflow)
  cueflow studio [--port <n>] [--no-open]  the editor in your browser: videos, steps, narration, voices, picking elements
  cueflow voices                        the voices to choose from, and which one each video speaks with
  cueflow capture [--scene <name>]...   capture the scenes described in capture.json from the live site
  cueflow build <guide>                 build <output>/<guide>.html, with narration audio when a voice is set (CUEFLOW_TTS)
  cueflow validate <guide> [--layout]   check selectors, ids and narrations; --layout also plays the guide in a
                                        browser and checks that every element used is visible and inside the scene
  cueflow preview <guide> [--step <n>] [--at <ms|80%>] [--all] [--stage] [--out <file>]
                                        render a frame as PNG in <output>/preview/ (step counted from 1, at default 80%);
                                        --all: one frame per step and a contact sheet of them all
  cueflow site [--posters]              build the docs site from site.json into <output>/site/ (--posters renders guide frames)
  cueflow check-endpoint               ask the request endpoint whether it accepts the site's origin (CORS), before publishing
  cueflow mcp                           start the MCP server on stdio

  --kit <dir>    kit folder (default: $CUEFLOW_KIT or the current directory)
  --lang <code>  language to preview or check (default: the guide's first)

  Voice (CUEFLOW_TTS): openai (OPENAI_API_KEY), say (macOS voices), command (CUEFLOW_TTS_COMMAND, e.g. Piper), none
  Browser (capture, preview, --layout, --posters): Playwright's Chromium, or CUEFLOW_CHROMIUM=<executable>
`;

// Optional local secrets (OPENAI_API_KEY…): .env in the current folder, then the kit's; real env vars win over both.
const loadEnv = (file: string) => { try { process.loadEnvFile(file); } catch {} };
loadEnv(".env");

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
    "out-dir": { type: "string" },
    port: { type: "string" },
    "no-open": { type: "boolean" },
    lang: { type: "string" },
    help: { type: "boolean", short: "h" }
  }
});
// the kit: --kit, else CUEFLOW_KIT, else the nearest .cueflow folder upwards, else the current folder
const kit = openKit(values.kit ?? process.env.CUEFLOW_KIT ?? findKitRoot(process.cwd()) ?? ".");
loadEnv(path.join(kit.root, ".env"));
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
  const dir = path.join(kit.out, "preview");
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
  } else if (command === "init") {
    const project = openKit(path.join(process.cwd(), ".cueflow"));
    await initKit(project, undefined, values["out-dir"]);
    console.log(`${project.root}  (output: ${project.out})\nNext: put OPENAI_API_KEY in .cueflow/.env only if you choose an external voice; connect your assistant with the MCP server (see README).`);
  } else if (command === "studio") {
    const studio = await startStudio(kit, { port: values.port ? Number(values.port) : undefined, open: !values["no-open"] });
    console.log(`Cueflow Studio: ${studio.url}\nKit: ${kit.root}\nCtrl+C to stop.\n\nTo work with an AI assistant, paste this into it (the key is valid until Studio stops; it is also in Studio, button AI):\n\n${await agentPrompt(kit, {}, studio.link)}\n`);
    await new Promise(() => {}); // runs until stopped
  } else if (command === "voices") {
    for (const o of voiceOptions()) console.log(`${o.available ? "●" : "○"} ${o.provider.padEnd(8)} ${o.title}\n    ${o.summary}\n    needs: ${o.needs}; cost: ${o.cost}`);
    console.log("\nEvery video speaks with:");
    for (const r of await voiceTable(kit)) console.log(`  ${r.guide} [${r.language}]  ${r.provider}${r.voice ? ` (${r.voice})` : ""}  ← ${r.from}`);
    console.log("\nChange it in cueflow.json (voices.default, voices.languages.<lang>, voices.guides.<video>) or with the set_voice tool.");
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
  } else if (command === "check-endpoint") {
    const r = await checkEndpoint(await loadSite(kit));
    console.log(`${r.ok ? "ok" : "error"}: ${r.message}`);
    if (!r.ok) process.exitCode = 1;
  } else if (command === "site") {
    const r = await buildSite(kit, { posters: values.posters ?? false });
    for (const w of r.warnings) console.log(`warning: ${w}`);
    console.log(`${r.dir}  (${r.pages.length} page(s)${r.posters.length ? `, ${r.posters.length} poster(s) rendered` : ""})`);
  } else if (command === "build" && id) {
    const r = await buildGuide(kit, id);
    for (const w of r.warnings) console.log(`warning: ${w}`);
    console.log(`${r.file}  (${r.scenes.length} scene(s), ${r.silent ? "no recorded audio: the browser reads the narration (choose a voice with `cueflow voices`)" : `${r.audioFiles} audio file(s)`})`);
  } else {
    console.log(USAGE);
    process.exitCode = 1;
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
}
