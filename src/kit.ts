import { statSync } from "node:fs";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Guide } from "./schema.ts";
import { migrateLegacyVoices, readSettingsSync, type Settings } from "./settings.ts";

/** A kit is a folder with shared/ (site assets), scenes/ (static HTML), guides/ (JSON), audio/ (TTS cache), dist/ (output). */
export type Kit = { root: string; /** where the output goes: settings.outDir, default dist/ */ out: string; settings: Settings };

export const openKit = (root: string): Kit => {
  const abs = path.resolve(root);
  const settings = readSettingsSync(abs);
  return { root: abs, out: path.resolve(abs, settings.outDir), settings };
};

/** The kit of a project: the nearest `.cueflow` folder from `from` upwards, like git finds .git. */
export function findKitRoot(from: string): string | null {
  let dir = path.resolve(from);
  for (;;) {
    const candidate = path.join(dir, ".cueflow");
    try {
      if (statSync(candidate).isDirectory()) return candidate;
    } catch {
      // not here, go up
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The folder of the product the kit belongs to: the parent of `.cueflow`, or the kit folder itself when it has another name. */
export const projectRoot = (kit: Kit): string => (path.basename(kit.root) === ".cueflow" ? path.dirname(kit.root) : kit.root);

/** Where the output goes unless the person chooses: `cueflow-dist` beside `.cueflow`, or `dist` inside a kit with another name. */
export const defaultOutDir = (kit: Kit): string => (path.basename(kit.root) === ".cueflow" ? "../cueflow-dist" : "dist");

/**
 * The output folder a person typed (relative to the project, or absolute), as cueflow.json keeps it (relative to the kit).
 * Refused when it would be the kit or a folder that holds it: a build would write over the kit's own files.
 */
export function outDirSetting(kit: Kit, typed: string): string {
  const text = typed.trim();
  if (!text) throw new Error("write the folder where the files should go, for example cueflow-dist");
  const abs = path.resolve(projectRoot(kit), text);
  const rel = path.relative(abs, kit.root);
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
    throw new Error(`"${text}" is the kit's folder or one that contains it: a build would write over the kit. Choose another folder, for example cueflow-dist.`);
  }
  return path.relative(kit.root, abs).split(path.sep).join("/");
}

const safeName = (name: string): string => {
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(name)) throw new Error(`invalid name "${name}" (letters, digits, - and _ only)`);
  return name;
};

export const sceneFile = (kit: Kit, scene: string, lang?: string) =>
  lang ? path.join(kit.root, "scenes", safeName(lang), `${safeName(scene)}.html`) : path.join(kit.root, "scenes", `${safeName(scene)}.html`);

/** The scene file for a language: scenes/<lang>/<scene>.html when the kit translates that screen, else the base one. */
export async function sceneFileFor(kit: Kit, scene: string, lang?: string): Promise<string> {
  if (lang) {
    const own = sceneFile(kit, scene, lang);
    if (await stat(own).then(() => true, () => false)) return own;
  }
  return sceneFile(kit, scene);
}
export const guideFile = (kit: Kit, id: string) => path.join(kit.root, "guides", `${safeName(id)}.json`);
export const distFile = (kit: Kit, id: string) => path.join(kit.out, `${safeName(id)}.html`);
export const audioDir = (kit: Kit) => path.join(kit.root, "audio");

export async function listScenes(kit: Kit): Promise<string[]> {
  return (await readdir(path.join(kit.root, "scenes")).catch(() => [])).filter((f) => f.endsWith(".html")).map((f) => f.slice(0, -5)).sort();
}

export async function listGuides(kit: Kit): Promise<string[]> {
  return (await readdir(path.join(kit.root, "guides")).catch(() => [])).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();
}

export async function readScene(kit: Kit, scene: string, lang?: string): Promise<string> {
  try {
    return await readFile(await sceneFileFor(kit, scene, lang), "utf8");
  } catch {
    throw new Error(`scene "${scene}" not found (available: ${(await listScenes(kit)).join(", ") || "none"})`);
  }
}

function readGuide(raw: string): Guide {
  const data = JSON.parse(raw);
  if (Array.isArray(data.steps)) {
    data.steps = data.steps.map((step: Record<string, unknown>) => step.voice ? { ...step, voice: migrateLegacyVoices(step.voice) } : step);
  }
  return Guide.parse(data);
}

export async function loadGuide(kit: Kit, id: string): Promise<Guide> {
  let raw: string;
  try {
    raw = await readFile(guideFile(kit, id), "utf8");
  } catch {
    throw new Error(`guide "${id}" not found (available: ${(await listGuides(kit)).join(", ") || "none"})`);
  }
  return readGuide(raw);
}

export async function saveGuide(kit: Kit, guide: Guide): Promise<void> {
  const file = guideFile(kit, guide.id);
  const existing = await readFile(file, "utf8").then(readGuide).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing && existing.vertical !== (guide.vertical ?? false)) {
    throw new Error("Tutorial orientation is fixed at creation. Create a new tutorial for a different orientation.");
  }
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(guide, null, 2) + "\n");
  await rename(tmp, file); // never leave a half-written guide
}
