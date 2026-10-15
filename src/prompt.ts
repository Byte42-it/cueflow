import path from "node:path";
import { kitStatus } from "./brief.ts";
import { loadGuide, listGuides, type Kit } from "./kit.ts";
import { pick } from "./schema.ts";
import { voiceTable } from "./voices.ts";

/** The command that connects an assistant to this kit: the same Cueflow that is running now. */
export function connectCommand(kit: Kit): string {
  const cli = process.argv[1] ? path.resolve(process.argv[1]) : "cueflow";
  return `claude mcp add cueflow -- node "${cli}" mcp --kit "${kit.root}"`;
}

/** Where Studio listens, and the key to its door for this run (see agent.ts). */
export type StudioLink = { url: string; token: string };

/** How to work with Cueflow from an assistant: through Studio's HTTP door when Studio runs, or as an MCP server. */
export function connectionLines(kit: Kit, studio?: StudioLink): string[] {
  const lines: string[] = [];
  if (studio) {
    const base = studio.url.replace(/\/$/, "");
    const auth = `-H "Authorization: Bearer ${studio.token}"`;
    lines.push(`HOW TO WORK WITH CUEFLOW. Pick the way that works for you.`);
    lines.push("");
    lines.push(`A) Studio's own door (nothing to install; it works while Studio runs, on this computer only). Use curl (on Windows PowerShell: curl.exe; to send JSON write it to a file and use -d @file.json):`);
    lines.push(`   how it works:  curl -s ${auth} ${base}/agent/help`);
    lines.push(`   the tools:     curl -s ${auth} ${base}/agent/tools`);
    lines.push(`   call a tool:   curl -s ${auth} -H "Content-Type: application/json" -d '{"…":"…"}' ${base}/agent/call/<tool>`);
    lines.push(`   LISTEN to what I ask in Studio — run this in the BACKGROUND so that you are woken when it returns, and run it again each time:`);
    lines.push(`                  curl -s ${auth} "${base}/agent/next?wait=540"`);
    const post = `curl -s ${auth} -H "Content-Type: application/json"`;
    lines.push(`   When it returns {"task":{…}}: do what it says with the tools, tell me how it goes and finish, then listen again:`);
    lines.push(`   progress:      ${post} -d '{"text":"…"}' ${base}/agent/say`);
    lines.push(`   finished:      ${post} -d '{"task":"<id>","summary":"…"}' ${base}/agent/done`);
    lines.push("");
    lines.push(`B) As an MCP server, if you can add one. Command line: claude mcp add cueflow -- node "${cliPath()}" mcp --kit "${kit.root}"`);
    lines.push(`   Without the claude command (VS Code, other tools): in .mcp.json at the project root: {"mcpServers":{"cueflow":{"command":"node","args":["${cliPath()}","mcp","--kit","${kit.root}"]}}}`);
  } else {
    lines.push(`If you are not connected to Cueflow yet (an MCP server named "cueflow"), run this once and restart the session: ${connectCommand(kit)}`);
    lines.push(`Without the claude command (VS Code, other tools): in .mcp.json at the project root: {"mcpServers":{"cueflow":{"command":"node","args":["${cliPath()}","mcp","--kit","${kit.root}"]}}}`);
  }
  return lines;
}

const cliPath = () => (process.argv[1] ? path.resolve(process.argv[1]) : "cueflow");

/**
 * A prompt to paste into an assistant: on a first start, how to begin; later, where things stand so that a new session
 * carries on instead of starting from scratch. It says what exists and what to read; the assistant's own tools say the rest.
 */
export async function agentPrompt(kit: Kit, ctx: { guide?: string; step?: number; lang?: string } = {}, studio?: StudioLink): Promise<string> {
  const status = await kitStatus(kit);
  const ids = await listGuides(kit);
  const lines: string[] = [];
  lines.push("I am making narrated UI tutorials with Cueflow, and Cueflow Studio is open on this kit: it shows what you change as you change it.");
  lines.push("");
  lines.push(`Kit: ${kit.root}`);
  lines.push(`Output: ${kit.out}`);
  lines.push("");
  lines.push(...connectionLines(kit, studio));
  lines.push("");

  if (!ids.length) {
    lines.push("There is no tutorial yet. Start from the beginning:");
    lines.push("1. Read the method (get_method, or GET /agent/method) and then the state of the kit (get_brief).");
    lines.push("2. Ask me which site the tutorials are for: a folder on this computer, or a live address. Do not look at anything before that.");
    lines.push("3. Study it, propose the tutorials worth making (one idea each) and agree the brief with me before writing anything.");
    lines.push("Talk to me in my language. Use synthetic data only; never real customer data.");
    return lines.join("\n");
  }

  lines.push("This is where we are. Carry on from here; do not start over and do not redo what exists.");
  const b = status.brief;
  if (b.site) lines.push(`- Product: ${b.site}${b.source ? ` (source: ${b.source.type === "url" ? b.source.url : b.source.path})` : ""}`);
  if (b.audience) lines.push(`- Audience: ${b.audience}`);
  if (b.tone) lines.push(`- Tone: ${b.tone}`);
  if (b.languages.length) lines.push(`- Languages: ${b.languages.join(", ")} (each language is its own sub-project: its screens are in scenes/<lang>/)`);
  if (b.rules.length) lines.push(`- Rules: ${b.rules.join("; ")}`);
  lines.push("- Tutorials:");
  for (const id of ids) {
    const g = await loadGuide(kit, id).catch(() => null);
    if (g) lines.push(`    ${id}: “${pick(g.title, ctx.lang ?? g.languages[0]!)}” — ${g.steps.length} steps, ${g.languages.join("/")}, first screen ${g.scene}`);
  }
  const voices = await voiceTable(kit).catch(() => []);
  const providers = [...new Set(voices.map((v) => v.provider))];
  if (providers.length) lines.push(`- Voice: ${providers.join(", ")} (never switch to an external voice without asking me)`);
  if (ctx.guide) {
    const g = await loadGuide(kit, ctx.guide).catch(() => null);
    if (g) {
      const n = ctx.step ?? 0;
      const st = g.steps[n];
      lines.push(`- I am looking at: tutorial "${g.id}"${st ? `, step ${n + 1} (${st.id})` : ""}${ctx.lang ? `, language ${ctx.lang}` : ""}`);
    }
  }
  lines.push("");
  lines.push("First, in this order:");
  lines.push("1. The method (get_method, or GET /agent/method), if you do not have it in this session.");
  lines.push(`2. get_brief: it tells what comes next${status.pendingChanges ? `. ${status.pendingChanges} hand edit(s) of mine are waiting: read them with get_changes, understand why I made them, take them into account, then mark_changes_seen` : ""}.`);
  lines.push("3. Then ask me what I want to do now; do not guess.");
  lines.push("Talk to me in my language. Check what you make (validate_guide, preview_frame) before saying it is done.");
  return lines.join("\n");
}

/** What the person asked for in Studio: a new tutorial, a new written guide, an announcement. */
export type NewRequest = {
  kind: "video" | "guide" | "soon";
  title?: string;
  id?: string;
  scene?: string;
  languages?: string[];
  kicker?: string;
  desc?: string;
  row?: string;
};

const KIND: Record<NewRequest["kind"], string> = {
  video: "a new VIDEO tutorial (narrated, animated, made of screens of the product)",
  guide: "a new WRITTEN guide (a page of text with sections on the dashboard)",
  soon: "an announcement on the dashboard of a guide that is COMING SOON (title and description only, nothing to write yet)"
};

const HOW: Record<NewRequest["kind"], string[]> = {
  video: [
    "When I have answered: make the screens it needs if they do not exist (capture_scenes from the live site, or build them from the folder, with synthetic data only), create_guide, add the steps one by one (one idea each), validate_guide, look at preview_frame, and tell me what you made. Nothing is built or published until I say so.",
    "Each language is its own sub-project: write the narration in each language of the brief."
  ],
  guide: [
    "When I have answered: create it with create_article (id and title above), write the sections with write_article (HTML: <section id data-title> blocks, h2/h3), in each language of the brief, then tell me what you wrote. Use the product's real words; do not invent features."
  ],
  soon: [
    "When I have answered: announce it with create_article (status \"soon\"), with the title and a one or two sentence description in each language, then tell me."
  ]
};

export async function requestPrompt(kit: Kit, req: NewRequest, ctx: { lang?: string } = {}, studio?: StudioLink, direct = false): Promise<string> {
  const filled = [
    req.title && `title: ${req.title}`,
    req.id && `id: ${req.id}`,
    req.scene && `first screen: ${req.scene}`,
    req.languages?.length && `languages: ${req.languages.join(", ")}`,
    req.kicker && `category (kicker): ${req.kicker}`,
    req.desc && `description: ${req.desc}`,
    req.row && `row of the home page: ${req.row}`
  ].filter(Boolean) as string[];
  const lines: string[] = [];
  if (direct) {
    lines.push("A request from Cueflow Studio (you are connected to it).");
    lines.push("");
  } else {
    lines.push(await agentPrompt(kit, ctx, studio));
    lines.push("");
    lines.push("────────────");
  }
  lines.push(`NEW REQUEST: I want ${KIND[req.kind]}.`);
  lines.push(filled.length ? "What I have already decided: " + filled.join("; ") + "." : "I have not decided anything yet.");
  lines.push("");
  lines.push("BEFORE you create anything, ask me, in my language: what this should explain or announce, who it is for, which flow of the product it covers, how long it should be, and in which languages. Wait for my answer; do not guess.");
  lines.push(...HOW[req.kind]);
  return lines.join("\n");
}
