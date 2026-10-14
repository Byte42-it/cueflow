import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { Guide } from "./schema.ts";

/** A kit is a folder with shared/ (site assets), scenes/ (static HTML), guides/ (JSON), audio/ (TTS cache), dist/ (output). */
export type Kit = { root: string };

export const openKit = (root: string): Kit => ({ root: path.resolve(root) });

const safeName = (name: string): string => {
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(name)) throw new Error(`invalid name "${name}" (letters, digits, - and _ only)`);
  return name;
};

export const sceneFile = (kit: Kit, scene: string) => path.join(kit.root, "scenes", `${safeName(scene)}.html`);
export const guideFile = (kit: Kit, id: string) => path.join(kit.root, "guides", `${safeName(id)}.json`);
export const distFile = (kit: Kit, id: string) => path.join(kit.root, "dist", `${safeName(id)}.html`);
export const audioDir = (kit: Kit) => path.join(kit.root, "audio");

export async function listScenes(kit: Kit): Promise<string[]> {
  return (await readdir(path.join(kit.root, "scenes")).catch(() => [])).filter((f) => f.endsWith(".html")).map((f) => f.slice(0, -5)).sort();
}

export async function listGuides(kit: Kit): Promise<string[]> {
  return (await readdir(path.join(kit.root, "guides")).catch(() => [])).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();
}

export async function readScene(kit: Kit, scene: string): Promise<string> {
  try {
    return await readFile(sceneFile(kit, scene), "utf8");
  } catch {
    throw new Error(`scene "${scene}" not found (available: ${(await listScenes(kit)).join(", ") || "none"})`);
  }
}

export async function loadGuide(kit: Kit, id: string): Promise<Guide> {
  let raw: string;
  try {
    raw = await readFile(guideFile(kit, id), "utf8");
  } catch {
    throw new Error(`guide "${id}" not found (available: ${(await listGuides(kit)).join(", ") || "none"})`);
  }
  return Guide.parse(JSON.parse(raw));
}

export async function saveGuide(kit: Kit, guide: Guide): Promise<void> {
  const file = guideFile(kit, guide.id);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(guide, null, 2) + "\n");
  await rename(tmp, file); // never leave a half-written guide
}
