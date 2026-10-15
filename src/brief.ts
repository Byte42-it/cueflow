import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { writeAtomic } from "./build.ts";
import { listGuides, listScenes, type Kit } from "./kit.ts";

/**
 * brief.json: what a person and the assistant agreed before writing tutorials. It is the only place where the
 * product's own rules live (tone, what must not be promised, how its jargon is pronounced), so Cueflow itself
 * stays free of any product.
 */
export const Brief = z.object({
  site: z.string().optional().describe("name of the product or site the tutorials explain"),
  source: z
    .discriminatedUnion("type", [
      z.object({ type: z.literal("folder"), path: z.string().describe("folder with the site's static files, or its source") }),
      z.object({ type: z.literal("url"), url: z.string().url().describe("address of the live site") })
    ])
    .optional()
    .describe("where the screens come from"),
  audience: z.string().optional().describe("who watches: their job, what they already know"),
  tone: z.string().optional().describe("how the narration sounds, e.g. impersonal and calm"),
  languages: z.array(z.string().min(2)).default([]).describe("languages of the tutorials, first one is the main"),
  rules: z.array(z.string()).default([]).describe("product rules for every tutorial, e.g. 'show only what the product does today'"),
  pronunciation: z.record(z.string()).default({}).describe("words the voice must say differently from how they are written; guides can add their own"),
  maxSeconds: z.number().positive().default(90).describe("a tutorial longer than this gets a warning: split it in two")
});
export type Brief = z.infer<typeof Brief>;

export const briefFile = (kit: Kit) => path.join(kit.root, "brief.json");

/** The kit's brief, or the defaults when there is none yet. */
export async function loadBrief(kit: Kit): Promise<Brief> {
  try {
    return Brief.parse(JSON.parse(await readFile(briefFile(kit), "utf8")));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return Brief.parse({});
    throw new Error(`brief.json is not valid: ${e instanceof Error ? e.message : e}`);
  }
}

export async function saveBrief(kit: Kit, brief: Brief): Promise<void> {
  await writeAtomic(briefFile(kit), JSON.stringify(brief, null, 2) + "\n");
}

/** Updates the brief: lists replace, `pronunciation` entries are added to the existing ones. */
export async function updateBrief(kit: Kit, patch: Partial<Brief>): Promise<Brief> {
  const current = await loadBrief(kit);
  const next = Brief.parse({ ...current, ...patch, pronunciation: { ...current.pronunciation, ...patch.pronunciation } });
  await saveBrief(kit, next);
  return next;
}

/** Creates the kit's folders and an empty brief if there is none. Safe to repeat. */
export async function initKit(kit: Kit, site?: string): Promise<void> {
  for (const dir of ["scenes", "shared", "guides"]) await mkdir(path.join(kit.root, dir), { recursive: true });
  const exists = await readFile(briefFile(kit), "utf8").then(() => true, () => false);
  if (!exists) await saveBrief(kit, Brief.parse({ site }));
  else if (site) await updateBrief(kit, { site });
}

export type KitStatus = { brief: Brief; hasBrief: boolean; hasCapture: boolean; hasSite: boolean; scenes: string[]; guides: string[]; next: string };

/** Where the kit stands and what to do next: the assistant reads this first. */
export async function kitStatus(kit: Kit): Promise<KitStatus> {
  const exists = (f: string) => readFile(path.join(kit.root, f)).then(() => true, () => false);
  const [brief, hasBrief, hasCapture, hasSite, scenes, guides] = await Promise.all([
    loadBrief(kit),
    exists("brief.json"),
    exists("capture.json"),
    exists("site.json"),
    listScenes(kit),
    listGuides(kit)
  ]);
  let next: string;
  if (!brief.source) next = "Ask the user which site the tutorials are for: a local folder (its files) or a live address (https://…). Then call set_source.";
  else if (!brief.audience || !brief.tone || brief.languages.length === 0) next = "Study the site, then talk the brief through with the user (audience, tone, languages, rules, how names are pronounced) and save it with set_brief.";
  else if (scenes.length === 0) next = brief.source.type === "url" ? "Write capture.json for the screens the tutorials need, then call capture_scenes." : "Build the scenes from the folder's files into scenes/ and shared/ (see get_method), with synthetic data only.";
  else if (guides.length === 0) next = "Agree with the user which tutorials to make (one idea each), then create_guide and add_step.";
  else if (!hasSite) next = "Validate and preview the guides, then write site.json (the catalog) and call build_site.";
  else next = "Validate, preview, listen, then build_site. Update tutorials when the interface changes.";
  return { brief, hasBrief, hasCapture, hasSite, scenes, guides, next };
}
