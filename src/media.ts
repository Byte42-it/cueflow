import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { writeAtomic } from "./build.ts";
import { listGuides, loadGuide, type Kit } from "./kit.ts";

/**
 * Where a tutorial's files live. `media/<tutorial>/` holds what belongs to that tutorial alone (a logo shown in its
 * scenes, a picture); `shared/` holds what several tutorials use (the site's CSS, fonts, icons). Scenes reference
 * them as ../media/<tutorial>/x.png and ../shared/x.css. A scene is "specific" when one tutorial uses it, "shared" when
 * several do (or none yet).
 */
export type Area = "media" | "shared";
export type MediaKind = "scene" | "image" | "font" | "style" | "script" | "audio" | "other";
export type MediaItem = { name: string; kind: MediaKind; size: number; usedBy: string[]; url?: string; languages?: string[] };

const KIND: Record<string, MediaKind> = {
  ".png": "image", ".jpg": "image", ".jpeg": "image", ".gif": "image", ".svg": "image", ".webp": "image", ".ico": "image",
  ".woff": "font", ".woff2": "font", ".ttf": "font", ".otf": "font",
  ".css": "style", ".js": "script", ".mp3": "audio", ".m4a": "audio", ".wav": "audio", ".ogg": "audio"
};
export const ALLOWED = Object.keys(KIND);
const kindOf = (name: string): MediaKind => KIND[path.extname(name).toLowerCase()] ?? "other";

const SEGMENT = /^[\w][\w .()+-]*$/;
/** A path inside a media area, or an error that says what is wrong. */
export function safeRel(rel: string): string {
  const parts = rel.split("/").filter(Boolean);
  if (!parts.length || parts.some((p) => !SEGMENT.test(p) || p === "..")) throw new Error(`"${rel}" is not a valid file name (letters, digits, spaces, . _ - ( ) + only; no folders going up)`);
  return parts.join("/");
}

export function areaDir(kit: Kit, area: Area, guide?: string): string {
  if (area === "shared") return path.join(kit.root, "shared");
  if (!guide || !/^[\w-]+$/.test(guide)) throw new Error("a tutorial's media needs the tutorial's id");
  return path.join(kit.root, "media", guide);
}

async function walk(dir: string, base = dir, out: string[] = []): Promise<string[]> {
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (e.name.startsWith(".")) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(full, base, out);
    else out.push(path.relative(base, full).split(path.sep).join("/"));
    if (out.length > 600) break;
  }
  return out;
}

/** Which scenes (and which of their translations) exist, and which tutorials use each. */
async function sceneUsage(kit: Kit) {
  const used = new Map<string, Set<string>>();
  for (const id of await listGuides(kit)) {
    const g = await loadGuide(kit, id).catch(() => null);
    if (!g) continue;
    for (const s of [g.scene, ...g.steps.map((x) => x.scene).filter((x): x is string => !!x)]) (used.get(s) ?? used.set(s, new Set()).get(s)!).add(id);
  }
  const dir = path.join(kit.root, "scenes");
  const names = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith(".html")).map((f) => f.slice(0, -5));
  const html: Record<string, string> = {};
  const languages: Record<string, string[]> = {};
  for (const n of names) {
    html[n] = await readFile(path.join(dir, `${n}.html`), "utf8").catch(() => "");
    languages[n] = [];
  }
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (!e.isDirectory()) continue;
    for (const f of await readdir(path.join(dir, e.name)).catch(() => [] as string[])) {
      const n = f.replace(/\.html$/, "");
      if (f.endsWith(".html") && languages[n]) {
        languages[n]!.push(e.name);
        html[n] += "\n" + (await readFile(path.join(dir, e.name, f), "utf8").catch(() => ""));
      }
    }
  }
  return { names, used, html, languages };
}

export async function mediaOverview(kit: Kit, guide: string) {
  const { names, used, html, languages } = await sceneUsage(kit);
  const scene = (n: string): MediaItem => ({ name: n, kind: "scene", size: Buffer.byteLength(html[n] ?? ""), usedBy: [...(used.get(n) ?? [])], languages: languages[n] });
  const specificScenes = names.filter((n) => { const u = used.get(n); return u && u.size === 1 && u.has(guide); }).map(scene);
  const sharedScenes = names.filter((n) => { const u = used.get(n); return !u || u.size > 1; }).map(scene);

  // a file is used by a scene that names it, or by a stylesheet (of either area) that names it and that a scene links
  const sharedFiles = await walk(path.join(kit.root, "shared"));
  const mediaDir = areaDir(kit, "media", guide);
  const ownFiles = await walk(mediaDir);
  const css: Record<string, string> = {};
  for (const f of sharedFiles) if (f.endsWith(".css")) css[`shared/${f}`] = await readFile(path.join(kit.root, "shared", f), "utf8").catch(() => "");
  for (const f of ownFiles) if (f.endsWith(".css")) css[`media/${guide}/${f}`] = await readFile(path.join(mediaDir, f), "utf8").catch(() => "");
  const users = (name: string) => {
    const base = path.basename(name);
    const set = new Set<string>();
    const scenesNaming = (token: string) => names.filter((n) => html[n]!.includes(token));
    for (const n of scenesNaming(base)) for (const g of used.get(n) ?? []) set.add(g);
    for (const [cssPath, text] of Object.entries(css)) if (text.includes(base) && cssPath !== name) for (const n of scenesNaming(path.basename(cssPath))) for (const g of used.get(n) ?? []) set.add(g);
    return [...set];
  };
  const file = (area: Area, rel: string, size: number): MediaItem => {
    const key = area === "shared" ? `shared/${rel}` : `media/${guide}/${rel}`;
    return { name: rel, kind: kindOf(rel), size, usedBy: users(key), url: area === "shared" ? `/files/shared/${rel}` : `/files/media/${guide}/${rel}` };
  };
  const sizes = async (dir: string, rels: string[]) => Promise.all(rels.map(async (r) => (await stat(path.join(dir, r)).catch(() => ({ size: 0 }))).size));
  const sSizes = await sizes(path.join(kit.root, "shared"), sharedFiles);
  const oSizes = await sizes(mediaDir, ownFiles);
  return {
    guide,
    media: { scenes: specificScenes, files: ownFiles.map((r, i) => file("media", r, oSizes[i]!)) },
    shared: { scenes: sharedScenes, files: sharedFiles.map((r, i) => file("shared", r, sSizes[i]!)) }
  };
}

export async function saveMediaFile(kit: Kit, area: Area, guide: string | undefined, name: string, data: Buffer): Promise<string> {
  const rel = safeRel(name);
  if (!ALLOWED.includes(path.extname(rel).toLowerCase())) throw new Error(`files of type "${path.extname(rel) || "(none)"}" are not accepted here (images, fonts, css, js, audio: ${ALLOWED.join(" ")})`);
  if (data.length > 25_000_000) throw new Error("the file is larger than 25 MB");
  await writeAtomic(path.join(areaDir(kit, area, guide), rel), data);
  return rel;
}

/** Removes a file only when no tutorial uses it: otherwise the error says which ones. */
export async function deleteMediaFile(kit: Kit, area: Area, guide: string | undefined, name: string): Promise<void> {
  const rel = safeRel(name);
  const overview = await mediaOverview(kit, guide ?? "_");
  const item = (area === "shared" ? overview.shared : overview.media).files.find((f) => f.name === rel);
  if (!item) throw new Error(`"${rel}" does not exist`);
  if (item.usedBy.length) throw new Error(`"${rel}" is used by ${item.usedBy.join(", ")}: remove it from the scene first`);
  await rm(path.join(areaDir(kit, area, guide), rel));
}

export const ensureDir = (dir: string) => mkdir(dir, { recursive: true });
