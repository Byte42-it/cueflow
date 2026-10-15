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

/**
 * A prompt to paste into an assistant: on a first start, how to begin; later, where things stand so that a new session
 * carries on instead of starting from scratch. It says what exists and what to read; the assistant's own tools say the rest.
 */
export async function agentPrompt(kit: Kit, ctx: { guide?: string; step?: number; lang?: string } = {}): Promise<string> {
  const status = await kitStatus(kit);
  const ids = await listGuides(kit);
  const lines: string[] = [];
  lines.push("I am making narrated UI tutorials with Cueflow, and Cueflow Studio is open on this kit: it shows what you change as you change it.");
  lines.push("");
  lines.push(`Kit: ${kit.root}`);
  lines.push(`Output: ${kit.out}`);
  lines.push("");
  lines.push("If you are not connected to Cueflow yet (an MCP server named \"cueflow\"), run this once and restart the session:");
  lines.push("  " + connectCommand(kit));
  lines.push("");

  if (!ids.length) {
    lines.push("There is no tutorial yet. Start from the beginning:");
    lines.push("1. Call get_method (how we work), then get_brief.");
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
  lines.push("1. get_method, if you do not have it in this session.");
  lines.push(`2. get_brief: it tells what comes next${status.pendingChanges ? `. ${status.pendingChanges} hand edit(s) of mine are waiting: read them with get_changes, understand why I made them, take them into account, then mark_changes_seen` : ""}.`);
  lines.push("3. Then ask me what I want to do now; do not guess.");
  lines.push("Talk to me in my language. Check what you make (validate_guide, preview_frame) before saying it is done.");
  return lines.join("\n");
}
