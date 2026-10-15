import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { buildGuide } from "./build.ts";
import { Brief, initKit, kitStatus, updateBrief } from "./brief.ts";
import { describeChange, markSeen, pendingChanges } from "./changes.ts";
import { INSTRUCTIONS, METHOD } from "./method.ts";
import { VoiceSpec } from "./settings.ts";
import { setVoice, voiceOptions, voiceTable } from "./voices.ts";
import { captureScenes } from "./capture.ts";
import { listGuides, listScenes, loadGuide, readScene, saveGuide, type Kit } from "./kit.ts";
import { checkLayout } from "./layout.ts";
import { renderFrame } from "./preview.ts";
import { describeScene } from "./scene.ts";
import { buildSite, checkEndpoint, loadSite, syncSite, validateSite } from "./site.ts";
import { createArticle, readArticle, writeArticle } from "./articles.ts";
import { Guide, Step } from "./schema.ts";
import { validateGuide } from "./validate.ts";

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });
const describeError = (e: unknown): string =>
  e instanceof z.ZodError ? "invalid value: " + e.issues.map((i) => `${i.path.join(".") || "value"}: ${i.message.toLowerCase()}`).join("; ") + ". Correct it and call again." : e instanceof Error ? e.message : String(e);
const fail = (e: unknown) => ({ isError: true, content: [{ type: "text" as const, text: describeError(e) }] });

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
  const server = new McpServer({ name: "cueflow", version: "0.0.1" }, { instructions: INSTRUCTIONS });
  const guideId = z.string().describe("guide id");

  server.registerTool(
    "get_method",
    { description: "READ THIS FIRST. The working method: which questions to ask, how to study a site, how to write steps and narration, what to check before building. The same for every product." },
    safe(async () => text(METHOD))
  );

  server.registerTool(
    "get_brief",
    { description: "Where the kit stands: the brief (site, source, audience, tone, languages, rules, pronunciation, maximum length), the scenes and guides that exist, and `next`, what to do now." },
    safe(async () => text(await kitStatus(kit)))
  );

  server.registerTool(
    "init_kit",
    { description: "Create the kit's folders (scenes, shared, guides) and an empty brief.json if there is none. Safe to call again.", inputSchema: { site: z.string().optional().describe("name of the product or site") } },
    safe(async ({ site }) => {
      await initKit(kit, site);
      return text(await kitStatus(kit));
    })
  );

  server.registerTool(
    "set_source",
    {
      description: "Record which site the tutorials are for: a local folder or a live address. Ask the user first; do not guess.",
      inputSchema: { type: z.enum(["folder", "url"]), value: z.string().describe("the folder's path, or the address (https://…)") }
    },
    safe(async ({ type, value }) => {
      const source = type === "folder" ? { type, path: value } : { type, url: value };
      await initKit(kit);
      await updateBrief(kit, { source: Brief.shape.source.parse(source) });
      return text(await kitStatus(kit));
    })
  );

  server.registerTool(
    "set_brief",
    {
      description: "Save what was agreed with the user. Only the fields you pass change; `languages` and `rules` are replaced as lists, `pronunciation` entries are added to the existing ones.",
      inputSchema: {
        site: z.string().optional(),
        audience: z.string().optional(),
        tone: z.string().optional(),
        languages: z.array(z.string().min(2)).optional(),
        rules: z.array(z.string()).optional(),
        pronunciation: z.record(z.string()).optional(),
        maxSeconds: z.number().positive().optional()
      }
    },
    safe(async (patch) => {
      await initKit(kit);
      await updateBrief(kit, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)));
      return text(await kitStatus(kit));
    })
  );

  server.registerTool(
    "get_changes",
    {
      description:
        "What the user changed BY HAND in Studio since you last looked (a button's text, a description, a narration, a file), each as a plain sentence. This is information, not a list to replay: the changes are already saved. Understand why the person made them and take them into account: e.g. a narration that still names the old button text, a caption, a pronunciation, a dashboard description. Fix what should follow, tell the user what you adjusted, then call mark_changes_seen."
    },
    safe(async () => {
      const list = await pendingChanges(kit);
      return text({ count: list.length, changes: list.map((c) => ({ ...c, sentence: describeChange(c) })) });
    })
  );

  server.registerTool(
    "mark_changes_seen",
    {
      description: "Mark hand edits as read, after taking them into account. `note` says in a few words what you did about them (kept for whoever reads the inbox).",
      inputSchema: { ids: z.array(z.string()).optional().describe("ids from get_changes; omit for all"), note: z.string().optional() }
    },
    safe(async ({ ids, note }) => text({ marked: await markSeen(kit, ids ?? "all", note) }))
  );

  server.registerTool(
    "create_article",
    {
      description:
        "Start a WRITTEN guide (a page of text with sections, on the dashboard) or announce one that is coming. Creates the dashboard (site.json) if there is none. A written guide starts with one empty section: write it with write_article. Prefer the user's own words and the product's real texts; no invented features.",
      inputSchema: {
        id: z.string().describe("lowercase letters, digits and - : it becomes the address of its page"),
        title: z.string(),
        status: z.enum(["guide", "soon"]).default("guide").describe("guide: to be written now; soon: announced on the dashboard as coming"),
        kicker: z.string().optional().describe("short category shown above the title"),
        desc: z.string().optional().describe("one or two sentences shown on the dashboard"),
        row: z.string().optional().describe("id of the row of the home page; default: the first one"),
        lang: z.string().optional().describe("language of title and description; default: the site's")
      }
    },
    safe(async (b) => {
      await syncSite(kit);
      return text(await createArticle(kit, b));
    })
  );

  server.registerTool(
    "read_article",
    { description: "The HTML of a written guide in a language (sections as <section id data-title> blocks with h2/h3), with a version to give back to write_article.", inputSchema: { id: z.string(), lang: z.string() } },
    safe(async ({ id, lang }) => text(await readArticle(kit, id, lang)))
  );

  server.registerTool(
    "write_article",
    {
      description:
        "Save the HTML of a written guide in a language. Structure: <section id=\"…\" data-title=\"…\"><h2>…</h2><p>…</p><h3 id=\"…\">…</h3></section> per section; h3 need an id (the side index uses them). Plain HTML, no scripts. Each language is its own file. Pass `version` from read_article to be refused if the person edited it meanwhile.",
      inputSchema: { id: z.string(), lang: z.string(), html: z.string(), version: z.number().optional() }
    },
    safe(async ({ id, lang, html, version }) => text(await writeArticle(kit, id, lang, html, version)))
  );

  server.registerTool(
    "get_voices",
    { description: "The voices to choose from, in plain words (browser voice by default; external voices need an explicit choice and, for OpenAI, a key), and which voice every video speaks with in each language and where that choice comes from (video, language, global, default)." },
    safe(async () => text({ options: voiceOptions(), current: kit.settings.voices, table: await voiceTable(kit) }))
  );

  server.registerTool(
    "set_voice",
    {
      description:
        "Choose a voice at one level, or clear it to inherit from the level above. Levels, most specific first: one video (and optionally one of its languages) > a language (all videos in it) > global > the browser's voice. Ask the user before choosing an external voice: it sends the narration text to a service, and OpenAI needs OPENAI_API_KEY in the kit's .env. Describe the options from get_voices; do not pick for them.",
      inputSchema: {
        scope: z.enum(["global", "language", "video"]),
        language: z.string().optional().describe("for scope language, or to narrow a video's voice to one of its languages"),
        guide: z.string().optional().describe("for scope video"),
        voice: VoiceSpec.nullable().describe("the voice, e.g. {provider:'browser'} or {provider:'openai', voice:'coral', style:'calm'}; null clears this level")
      }
    },
    safe(async ({ scope, language, guide, voice }) => {
      if (scope === "language" && !language) throw new Error("scope language needs `language`, e.g. \"it\"");
      if (scope === "video" && !guide) throw new Error("scope video needs `guide`, the id of the video");
      await setVoice(kit, scope === "global" ? { scope } : scope === "language" ? { scope, language: language! } : { scope, guide: guide!, language }, voice);
      const needsKey = voice?.provider === "openai" && !process.env.OPENAI_API_KEY;
      return text({
        saved: true,
        ...(needsKey ? { warning: "OPENAI_API_KEY is not set yet: put it in the kit's .env file (OPENAI_API_KEY=sk-…) before building, or the build will stop with an error." } : {}),
        table: await voiceTable(kit)
      });
    })
  );

  server.registerTool(
    "capture_scenes",
    {
      description:
        "Capture the kit's scenes from the live site described in capture.json (base URL, login, and per scene: url, steps, data-cue names to give to elements, elements to remove or hide, text replacements). Writes scenes/<name>.html and copies stylesheets, fonts and images to shared/. Needs Playwright. `scenes` limits the writing to some scenes (all of them still run, in order).",
      inputSchema: { scenes: z.array(z.string()).optional() }
    },
    safe(async ({ scenes }) => text(await captureScenes(kit, { only: scenes })))
  );

  server.registerTool(
    "list_scenes",
    { description: "List the static HTML scenes of the kit (the screens a guide can show)." },
    safe(async () => text({ scenes: await listScenes(kit), guides: await listGuides(kit) }))
  );

  server.registerTool(
    "inspect_scene",
    {
      description:
        "List the elements of a scene that a guide can target, with the best CSS selector, tag, visible text and whether they start hidden. Use these selectors in actions and cameras. `lang` reads the translated version of the screen (scenes/<lang>/<scene>.html) when the kit has one: it must keep the same ids.",
      inputSchema: { scene: z.string(), lang: z.string().optional() }
    },
    safe(async ({ scene, lang }) => text(describeScene(await readScene(kit, scene, lang))))
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
    {
      description:
        "Check a guide: selectors exist in the scene current at each step, ids are unique, every language has a narration. `layout` also plays it in a browser (needs Playwright) and warns when an element used by a camera, cursor, click, highlight or typing is hidden or outside the scene at that moment.",
      inputSchema: { guide: guideId, layout: z.boolean().default(false), lang: z.string().optional() }
    },
    safe(async ({ guide, layout, lang }) => {
      const report = await validateGuide(kit, await loadGuide(kit, guide));
      if (layout && !report.errors.length) report.warnings.push(...(await checkLayout(kit, guide, { lang })).map((w) => `layout: ${w}`));
      return text(report);
    })
  );

  server.registerTool(
    "build_guide",
    {
      description: "Build the guide into one self-contained HTML file (<output folder>/<guide>.html), generating the narration audio when a TTS provider is configured.",
      inputSchema: { guide: guideId }
    },
    safe(async ({ guide }) => text(await buildGuide(kit, guide)))
  );

  server.registerTool(
    "validate_site",
    { description: "Check the kit's site.json (the docs-site catalog): unique ids, existing rows, guides, articles, posters and icons." },
    safe(async () => text(await validateSite(kit, await loadSite(kit))))
  );

  server.registerTool(
    "check_endpoint",
    {
      description:
        "Ask the site's requestEndpoint whether it accepts requests from the site's url (the CORS preflight a browser sends first). Run it before publishing: a refused origin means the request form fails for every visitor."
    },
    safe(async () => text(await checkEndpoint(await loadSite(kit))))
  );

  server.registerTool(
    "build_site",
    {
      description:
        "Build the docs site from site.json into the output folder's site/: a home page (featured item, quick access, scrolling rows) and one page per item with its video, transcript and written guide (pages/<id>.html). `posters` renders a frame of each guide as its poster (needs Playwright).",
      inputSchema: { posters: z.boolean().default(false) }
    },
    safe(async ({ posters }) => text(await buildSite(kit, { posters })))
  );

  server.registerTool(
    "preview_frame",
    {
      description:
        "Render one frame of a guide as an image, to check the framing, the cursor and the scene state. Builds the guide first. `step` is the 0-based step index, `at_ms` the time inside that step (or `at`, a percentage of its narration).",
      inputSchema: {
        guide: guideId,
        step: z.number().int().min(0).default(0),
        at_ms: z.number().min(0).default(0),
        at: z.string().regex(/^\d+(\.\d+)?%$/).optional().describe('instead of at_ms: a percentage of the step\'s narration, e.g. "80%"'),
        lang: z.string().optional()
      }
    },
    safe(async ({ guide, step, at_ms, at, lang }) => {
      const built = await buildGuide(kit, guide, null); // silent: the preview does not need audio
      const png = await renderFrame(built.file, { step, at: at ?? at_ms, lang });
      return { content: [{ type: "image" as const, data: png.toString("base64"), mimeType: "image/png" }] };
    })
  );

  return server;
}

export async function startMcp(kit: Kit): Promise<void> {
  await createServer(kit).connect(new StdioServerTransport());
}
