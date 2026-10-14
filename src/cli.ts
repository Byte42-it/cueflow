#!/usr/bin/env node
import { parseArgs } from "node:util";
import { buildGuide } from "./build.ts";
import { openKit } from "./kit.ts";
import { startMcp } from "./mcp.ts";
import { buildSite } from "./site.ts";
import { defaultProvider } from "./tts.ts";
import { validateGuide } from "./validate.ts";
import { loadGuide } from "./kit.ts";

const USAGE = `cueflow — narrated UI walkthroughs from static HTML scenes

  cueflow build <guide>     build dist/<guide>.html (TTS audio when OPENAI_API_KEY is set)
  cueflow validate <guide>  check selectors, ids and narrations
  cueflow site [--posters]  build the docs site from site.json into dist/site/ (--posters renders guide frames)
  cueflow mcp               start the MCP server on stdio

  --kit <dir>               kit folder (default: $CUEFLOW_KIT or the current directory)
`;

const { values, positionals } = parseArgs({ allowPositionals: true, options: { kit: { type: "string" }, posters: { type: "boolean" }, help: { type: "boolean", short: "h" } } });
const kit = openKit(values.kit ?? process.env.CUEFLOW_KIT ?? ".");
const [command, id] = positionals;

try {
  if (values.help || !command) {
    console.log(USAGE);
  } else if (command === "mcp") {
    await startMcp(kit);
  } else if (command === "validate" && id) {
    const report = await validateGuide(kit, await loadGuide(kit, id));
    for (const w of report.warnings) console.log(`warning: ${w}`);
    for (const e of report.errors) console.log(`error: ${e}`);
    if (report.errors.length) process.exitCode = 1;
    else console.log("ok");
  } else if (command === "site") {
    const r = await buildSite(kit, { provider: defaultProvider(), posters: values.posters ?? false });
    for (const w of r.warnings) console.log(`warning: ${w}`);
    console.log(`${r.dir}  (${r.pages.length} page(s)${r.posters.length ? `, ${r.posters.length} poster(s) rendered` : ""})`);
  } else if (command === "build" && id) {
    const r = await buildGuide(kit, id, defaultProvider());
    for (const w of r.warnings) console.log(`warning: ${w}`);
    console.log(`${r.file}  (${r.scenes.length} scene(s), ${r.silent ? "silent: set OPENAI_API_KEY for narration audio" : `${r.audioFiles} audio file(s)`})`);
  } else {
    console.log(USAGE);
    process.exitCode = 1;
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
}
