import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { buildGuide } from "./build.ts";
import { listGuides, listScenes, loadGuide, readScene, saveGuide, type Kit } from "./kit.ts";
import { renderFrame } from "./preview.ts";
import { describeScene } from "./scene.ts";
import { buildSite, loadSite, validateSite } from "./site.ts";
import { Guide, Step } from "./schema.ts";
import { defaultProvider } from "./tts.ts";
import { validateGuide } from "./validate.ts";

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });
const fail = (e: unknown) => ({ isError: true, content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }] });

/** Wraps a tool body so that errors come back as readable tool errors instead of protocol failures. */
const safe =
  <A>(fn: (args: A) => Promise<ReturnType<typeof text> | { content: { type: "image"; data: string; mimeType: string }[] }>) =>
  async (args: A) => {
    try {
      return await fn(args);
    } catch (e) {
      return fail(e);
    }
  };

export function createServer(kit: Kit): McpServer {
  const server = new McpServer({ name: "cueflow", version: "0.0.1" });
  const guideId = z.string().describe("guide id");

  server.registerTool(
    "list_scenes",
    { description: "List the static HTML scenes of the kit (the screens a guide can show)." },
    safe(async () => text({ scenes: await listScenes(kit), guides: await listGuides(kit) }))
  );

  server.registerTool(
    "inspect_scene",
    {
      description:
        "List the elements of a scene that a guide can target, with the best CSS selector, tag, visible text and whether they start hidden. Use these selectors in actions and cameras.",
      inputSchema: { scene: z.string() }
    },
    safe(async ({ scene }) => text(describeScene(await readScene(kit, scene))))
  );

  server.registerTool(
    "create_guide",
    {
      description: "Create an empty guide. Steps are added afterwards with add_step.",
      inputSchema: {
        id: guideId,
        title: z.string(),
        scene: z.string().describe("first scene"),
        languages: z.array(z.string()).default(["en"]),
        viewport: z.object({ width: z.number(), height: z.number() }).optional().describe("native size of the scenes, default 1280x720"),
        stage: z.object({ width: z.number(), height: z.number() }).optional().describe("size of the visible window of the video, default 640x360")
      }
    },
    safe(async (a) => {
      const existing = await listGuides(kit);
      if (existing.includes(a.id)) throw new Error(`guide "${a.id}" already exists`);
      const guide = Guide.parse({ ...a, steps: [] });
      await saveGuide(kit, guide);
      return text(guide);
    })
  );

  server.registerTool("get_guide", { description: "Read a guide.", inputSchema: { guide: guideId } }, safe(async ({ guide }) => text(await loadGuide(kit, guide))));

  server.registerTool(
    "add_step",
    {
      description:
        "Add a step to a guide (at the end, or at `index`). A step has a camera (what is framed), actions on the scene's elements (cursor, clicks, typing, highlights, progress animations) and a narration per language. Selectors are checked right away against the scene.",
      inputSchema: { guide: guideId, step: Step, index: z.number().int().min(0).optional() }
    },
    safe(async ({ guide, step, index }) => {
      const g = await loadGuide(kit, guide);
      const next = { ...g, steps: [...g.steps] };
      next.steps.splice(index ?? next.steps.length, 0, Step.parse(step));
      const report = await validateGuide(kit, next);
      const mine = report.errors.filter((e) => e.startsWith(`step ${(index ?? g.steps.length) + 1} (${step.id})`) || e.includes("duplicate"));
      if (mine.length) throw new Error(`step not added:\n- ${mine.join("\n- ")}`);
      await saveGuide(kit, next);
      return text({ steps: next.steps.map((s) => s.id), warnings: report.warnings.filter((w) => w.includes(`(${step.id})`)) });
    })
  );

  server.registerTool(
    "replace_step",
    { description: "Replace the step with this id by a new definition (same checks as add_step).", inputSchema: { guide: guideId, step: Step } },
    safe(async ({ guide, step }) => {
      const g = await loadGuide(kit, guide);
      const i = g.steps.findIndex((s) => s.id === step.id);
      if (i < 0) throw new Error(`no step "${step.id}" in guide "${guide}"`);
      const next = { ...g, steps: g.steps.map((s, k) => (k === i ? Step.parse(step) : s)) };
      const report = await validateGuide(kit, next);
      const mine = report.errors.filter((e) => e.startsWith(`step ${i + 1} (`));
      if (mine.length) throw new Error(`step not replaced:\n- ${mine.join("\n- ")}`);
      await saveGuide(kit, next);
      return text("ok");
    })
  );

  server.registerTool(
    "remove_step",
    { description: "Remove a step by id.", inputSchema: { guide: guideId, step_id: z.string() } },
    safe(async ({ guide, step_id }) => {
      const g = await loadGuide(kit, guide);
      if (!g.steps.some((s) => s.id === step_id)) throw new Error(`no step "${step_id}" in guide "${guide}"`);
      await saveGuide(kit, { ...g, steps: g.steps.filter((s) => s.id !== step_id) });
      return text("ok");
    })
  );

  server.registerTool(
    "set_narration",
    {
      description: "Set or change the narration of one step in one language (also use it to translate: one call per step and language). Add the language to the guide if needed.",
      inputSchema: { guide: guideId, step_id: z.string(), lang: z.string().min(2), text: z.string() }
    },
    safe(async ({ guide, step_id, lang, text: narration }) => {
      const g = await loadGuide(kit, guide);
      const step = g.steps.find((s) => s.id === step_id);
      if (!step) throw new Error(`no step "${step_id}" in guide "${guide}"`);
      step.narration[lang] = narration;
      if (!g.languages.includes(lang)) g.languages.push(lang);
      await saveGuide(kit, g);
      return text({ languages: g.languages });
    })
  );

  server.registerTool(
    "validate_guide",
    { description: "Check a guide: selectors exist in the scene current at each step, ids are unique, every language has a narration.", inputSchema: { guide: guideId } },
    safe(async ({ guide }) => text(await validateGuide(kit, await loadGuide(kit, guide))))
  );

  server.registerTool(
    "build_guide",
    {
      description: "Build the guide into one self-contained HTML file (dist/<guide>.html), generating the narration audio when a TTS provider is configured.",
      inputSchema: { guide: guideId }
    },
    safe(async ({ guide }) => text(await buildGuide(kit, guide, defaultProvider())))
  );

  server.registerTool(
    "validate_site",
    { description: "Check the kit's site.json (the docs-site catalog): unique ids, existing rows, guides, articles, posters and icons." },
    safe(async () => text(await validateSite(kit, await loadSite(kit))))
  );

  server.registerTool(
    "build_site",
    {
      description:
        "Build the docs site from site.json into dist/site/: a home page (featured item, quick access, scrolling rows) and one page per item with its video, transcript and written guide (pages/<id>.html). `posters` renders a frame of each guide as its poster (needs Playwright).",
      inputSchema: { posters: z.boolean().default(false) }
    },
    safe(async ({ posters }) => text(await buildSite(kit, { provider: defaultProvider(), posters })))
  );

  server.registerTool(
    "preview_frame",
    {
      description:
        "Render one frame of a guide as an image, to check the framing, the cursor and the scene state. Builds the guide first. `step` is the 0-based step index, `at_ms` the time inside that step.",
      inputSchema: { guide: guideId, step: z.number().int().min(0).default(0), at_ms: z.number().min(0).default(0), lang: z.string().optional() }
    },
    safe(async ({ guide, step, at_ms, lang }) => {
      const built = await buildGuide(kit, guide, null); // silent: the preview does not need audio
      const png = await renderFrame(built.file, { step, atMs: at_ms, lang });
      return { content: [{ type: "image" as const, data: png.toString("base64"), mimeType: "image/png" }] };
    })
  );

  return server;
}

export async function startMcp(kit: Kit): Promise<void> {
  await createServer(kit).connect(new StdioServerTransport());
}
