import { mkdir, readFile, rename, stat } from "node:fs/promises";
import path from "node:path";
import { writeAtomic } from "./build.ts";
import { recordChange } from "./changes.ts";
import type { Kit } from "./kit.ts";
import { pick, Site, siteLanguages, type SiteItem } from "./schema.ts";
import { siteFile } from "./site.ts";

/**
 * Written guides and the catalog, as Studio manages them. A written guide is a catalog item with an article in
 * pages/ (pages/<lang>/ for a translation): an item "guide" has only that, an item "video" has it beside its video,
 * an item "soon" is only announced. The files stay the source of truth: these functions edit them in place.
 */

const ITEM_ID = /^[a-z0-9][a-z0-9-]*$/;
const TEXT_FIELDS = ["title", "kicker", "desc", "duration"] as const;
export type TextField = (typeof TEXT_FIELDS)[number];

class ArticleError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const exists = (file: string) => stat(file).then(() => true, () => false);
const mtime = (file: string) => stat(file).then((s) => s.mtimeMs, () => 0);

/** site.json as written (not normalised), so an edit touches only what was asked; and its parsed view. */
async function readRaw(kit: Kit): Promise<{ raw: Record<string, any>; site: Site }> {
  let text: string;
  try {
    text = await readFile(siteFile(kit), "utf8");
  } catch {
    throw new ArticleError(404, "there is no site.json yet: build the dashboard once (Build), or create a written guide to start it");
  }
  const raw = JSON.parse(text);
  return { raw, site: Site.parse(raw) };
}
async function writeRaw(kit: Kit, raw: Record<string, any>): Promise<Site> {
  const site = Site.parse(raw); // never leave an invalid catalog behind
  await writeAtomic(siteFile(kit), JSON.stringify(raw, null, 2) + "\n");
  return site;
}

type RawItem = { id: string; article?: string } & Record<string, any>;
function findItem(raw: Record<string, any>, id: string): RawItem {
  const item = (raw.items as any[] | undefined)?.find((i) => i.id === id);
  if (!item) throw new ArticleError(404, `the dashboard has no item "${id}"`);
  return item;
}

/** The article file of an item in a language: the site's own language lives in pages/, the others in pages/<lang>/. */
export function articlePath(kit: Kit, site: Site, item: { id: string; article?: string }, lang: string): string {
  const name = item.article ?? `${item.id}.html`;
  if (!/^[\w-]+\.html$/.test(name)) throw new ArticleError(400, `"${name}" is not a valid article file name`);
  if (!/^[a-z]{2}(-[A-Za-z]{2})?$/.test(lang)) throw new ArticleError(400, `"${lang}" is not a language code`);
  return lang === site.lang ? path.join(kit.root, "pages", name) : path.join(kit.root, "pages", lang, name);
}

/** Every item of the catalog, with which languages its written guide exists in: what Studio lists. */
export async function catalogOverview(kit: Kit) {
  if (!(await exists(siteFile(kit)))) return { exists: false as const };
  const { site } = await readRaw(kit);
  const { languages, fallback } = siteLanguages(site);
  const items = [];
  for (const it of site.items) {
    const files: Record<string, boolean> = {};
    for (const l of languages) files[l] = await exists(articlePath(kit, site, it, l));
    items.push({ id: it.id, row: it.row, status: it.status, title: it.title, kicker: it.kicker ?? null, desc: it.desc, duration: it.duration ?? null, contents: it.contents, guide: it.guide ?? null, files });
  }
  return { exists: true as const, lang: site.lang, languages, fallback, featured: site.featured ?? null, rows: site.rows.map((r) => ({ id: r.id, title: r.title })), items };
}

/** The source of a written guide in a language; `version` guards against overwriting someone else's edit. */
export async function readArticle(kit: Kit, id: string, lang: string) {
  const { raw, site } = await readRaw(kit);
  const item = findItem(raw, id);
  const file = articlePath(kit, site, item, lang);
  const html = await readFile(file, "utf8").catch(() => null);
  return { id, lang, exists: html != null, html: html ?? "", version: await mtime(file), base: site.lang, file: path.relative(kit.root, file) };
}

/** A short summary of an article for the assistant's note: its section titles. */
const outline = (html: string) => [...html.matchAll(/<section\b[^>]*\bdata-title="([^"]*)"/g)].map((m) => m[1]).join(" | ") || "no sections";

/** Saves a written guide. A stale version (the file changed since it was read) is refused: reload, then edit again. */
export async function writeArticle(kit: Kit, id: string, lang: string, html: string, version?: number) {
  const { raw, site } = await readRaw(kit);
  const item = findItem(raw, id);
  const file = articlePath(kit, site, item, lang);
  if (version != null && version !== (await mtime(file))) throw new ArticleError(409, "this guide was changed on disk since you opened it (by your assistant or another window): reload it, then edit again");
  if (Buffer.byteLength(html) > 2_000_000) throw new ArticleError(413, "the guide is larger than 2 MB: move images to files instead of embedding them");
  const before = await readFile(file, "utf8").catch(() => "");
  await mkdir(path.dirname(file), { recursive: true });
  await writeAtomic(file, html.endsWith("\n") ? html : html + "\n");
  if (before.trim() !== html.trim()) {
    await recordChange(kit, { kind: "article", lang, target: id, before: before ? outline(before) : "(new)", after: outline(html) });
  }
  return { version: await mtime(file), file: path.relative(kit.root, file) };
}

/** A new written guide: an item in the catalog and a first section to write in. */
export async function createArticle(kit: Kit, b: { id: string; title: string; row?: string; kicker?: string; desc?: string; lang?: string; status?: "guide" | "soon" }) {
  const { raw, site } = await readRaw(kit);
  const id = String(b.id ?? "").trim();
  if (!ITEM_ID.test(id)) throw new ArticleError(400, "the id is made of lowercase letters, digits and - (it becomes the address of the page)");
  if ((raw.items as any[]).some((i) => i.id === id)) throw new ArticleError(409, `the dashboard already has an item "${id}"`);
  const title = String(b.title ?? "").trim();
  if (!title) throw new ArticleError(400, "give the guide a title");
  const row = b.row ?? site.rows.find((r) => !r.band)?.id ?? site.rows[0]?.id;
  if (!row || !site.rows.some((r) => r.id === row)) throw new ArticleError(400, `the dashboard has no row "${row}"`);
  const lang = b.lang ?? site.lang;
  const status = b.status === "soon" ? "soon" : "guide";
  const loc = (v: string) => ({ [lang]: v });
  const item: Record<string, unknown> = { id, row, status, title: loc(title), desc: loc(String(b.desc ?? "").trim()) };
  if (b.kicker?.trim()) item.kicker = loc(b.kicker.trim());
  raw.items.push(item);
  await writeRaw(kit, raw);
  if (status === "guide") await startArticle(kit, id, site.lang, title);
  await recordChange(kit, { kind: "catalog", lang, target: `${id}`, before: "(none)", after: `new ${status === "guide" ? "written guide" : "coming-soon item"} “${title}”` });
  return { id };
}

/** The first text of a guide that has none yet: one section with its title, ready to write in. */
async function startArticle(kit: Kit, id: string, lang: string, title: string) {
  const { site } = await readRaw(kit);
  const file = articlePath(kit, site, { id }, lang);
  if (await exists(file)) return;
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  await mkdir(path.dirname(file), { recursive: true });
  await writeAtomic(file, `<section id="intro" data-title="${esc(title)}">\n<h2>${esc(title)}</h2>\n<p></p>\n</section>\n`);
}

/** A translation that starts as a copy of the site's own language, to be rewritten in place. */
export async function startTranslation(kit: Kit, id: string, lang: string) {
  const { raw, site } = await readRaw(kit);
  const item = findItem(raw, id);
  if (lang === site.lang) throw new ArticleError(400, `${lang} is the site's own language`);
  const target = articlePath(kit, site, item, lang);
  if (await exists(target)) throw new ArticleError(409, `the ${lang} version already exists`);
  const base = await readFile(articlePath(kit, site, item, site.lang), "utf8").catch(() => null);
  if (base == null) throw new ArticleError(404, `there is no ${site.lang} text to start from`);
  await mkdir(path.dirname(target), { recursive: true });
  await writeAtomic(target, base);
  return readArticle(kit, id, lang);
}

export type ItemPatch = {
  lang?: string;
  texts?: Partial<Record<TextField, string>>;
  contents?: string[];
  row?: string;
  status?: "video" | "guide" | "soon";
  move?: -1 | 1;
};

/** Changes an item of the catalog: its texts in one language (the others keep theirs), its row, status or place. */
export async function updateItem(kit: Kit, id: string, patch: ItemPatch) {
  const { raw, site } = await readRaw(kit);
  const item = findItem(raw, id);
  const lang = patch.lang ?? site.lang;
  const languages = siteLanguages(site).languages;
  const setLocalized = (old: unknown, value: string) => {
    if (old && typeof old === "object") return { ...(old as object), [lang]: value };
    if (typeof old === "string" && (languages.length > 1 || lang !== site.lang)) {
      const o: Record<string, string> = {};
      for (const l of languages) o[l] = old;
      o[lang] = value;
      return o;
    }
    return languages.length > 1 || lang !== site.lang ? { [lang]: value } : value;
  };
  for (const f of TEXT_FIELDS) {
    const v = patch.texts?.[f];
    if (v == null) continue;
    const before = pick(item[f], lang, site.lang) ?? "";
    if (before === v) continue;
    if (v === "" && f !== "title" && f !== "desc" && (typeof item[f] !== "object" || Object.keys(item[f]).length <= 1)) delete item[f];
    else item[f] = setLocalized(item[f], v);
    await recordChange(kit, { kind: "catalog", lang, target: `${id}.${f}`, before, after: v });
  }
  if (patch.contents) {
    const old = item.contents;
    const list = patch.contents.map((x) => x.trim()).filter(Boolean);
    item.contents = Array.isArray(old) ? (languages.length > 1 || lang !== site.lang ? Object.fromEntries(languages.map((l) => [l, l === lang ? list : old])) : list) : { ...(old ?? {}), [lang]: list };
  }
  if (patch.row && patch.row !== item.row) {
    if (!site.rows.some((r) => r.id === patch.row)) throw new ArticleError(400, `the dashboard has no row "${patch.row}"`);
    item.row = patch.row;
  }
  if (patch.status && patch.status !== item.status) {
    if (patch.status === "video" && !item.guide) throw new ArticleError(400, "an item becomes a video when a video is made for it (its guide)");
    if (item.status === "video") throw new ArticleError(400, "this item plays a video: delete the video to turn it back into a written guide");
    const was = item.status;
    item.status = patch.status;
    if (patch.status === "guide") await startArticle(kit, id, site.lang, pick(item.title, site.lang, site.lang) ?? id);
    await recordChange(kit, { kind: "catalog", lang, target: `${id}.status`, before: statusWord(was), after: statusWord(patch.status) });
  }
  if (patch.move) {
    // the order inside a row is the order of the items in site.json: swap with the neighbour in the same row
    const items = raw.items as any[];
    const same = items.filter((i) => i.row === item.row);
    const at = same.indexOf(item), to = at + patch.move;
    if (to >= 0 && to < same.length) {
      const a = items.indexOf(item), b = items.indexOf(same[to]);
      [items[a], items[b]] = [items[b], items[a]];
    }
  }
  await writeRaw(kit, raw);
  return catalogOverview(kit);
}
/**
 * The order of the dashboard, as chosen by dragging in Studio. `order` lists item ids in the new order (the home page
 * shows each row's items in that order); `row` moves the dragged item into another row when it was dropped there.
 * Items missing from `order` keep their relative order after the listed ones.
 */
export async function reorderItems(kit: Kit, order: string[], moved?: { id: string; row?: string }) {
  const { raw, site } = await readRaw(kit);
  const items = raw.items as any[];
  if (moved?.row) {
    if (!site.rows.some((r) => r.id === moved.row)) throw new ArticleError(400, `the dashboard has no row "${moved.row}"`);
    const it = findItem(raw, moved.id);
    if (it.row !== moved.row) it.row = moved.row;
  }
  const before = items.map((i) => i.id);
  const known = new Map(items.map((i) => [i.id, i]));
  const next: any[] = [];
  for (const id of order) {
    const it = known.get(id);
    if (it) { next.push(it); known.delete(id); }
  }
  for (const it of items) if (known.has(it.id)) next.push(it);
  raw.items = next;
  await writeRaw(kit, raw);
  const after = next.map((i) => i.id);
  if (before.join() !== after.join() || moved?.row) {
    const title = (id: string) => pick(next.find((i) => i.id === id)?.title, site.lang, site.lang) ?? id;
    await recordChange(kit, { kind: "catalog", target: "order", before: before.map(title).join(" › "), after: after.map(title).join(" › ") + (moved?.row ? ` (“${title(moved.id)}” is now in the row “${moved.row}”)` : "") });
  }
  return catalogOverview(kit);
}

const statusWord = (s: string) => (s === "guide" ? "written guide" : s === "soon" ? "coming soon" : "video");

/** Takes an item off the dashboard; its written guide (every language) goes to trash/, nothing is erased. */
export async function deleteItem(kit: Kit, id: string) {
  const { raw, site } = await readRaw(kit);
  const item = findItem(raw, id) as SiteItem & Record<string, any>;
  if (item.status === "video") throw new ArticleError(400, "this item plays a video: delete the video (its thumbnail) instead");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const trash = path.join(kit.root, "trash", `${stamp}-${id}`);
  const moved: string[] = [];
  for (const l of siteLanguages(site).languages) {
    const file = articlePath(kit, site, item, l);
    if (!(await exists(file))) continue;
    const to = path.join(trash, path.relative(kit.root, file));
    await mkdir(path.dirname(to), { recursive: true });
    await rename(file, to);
    moved.push(path.relative(kit.root, file));
  }
  raw.items = (raw.items as any[]).filter((i) => i !== item);
  if (raw.featured === id) raw.featured = raw.items.find((i: any) => i.status !== "soon")?.id;
  await writeRaw(kit, raw);
  await recordChange(kit, { kind: "tutorial-deleted", target: id, before: pick(item.title, site.lang, site.lang) ?? id, after: moved.length ? `moved to ${path.relative(kit.root, trash)}` : "removed from the dashboard" });
  return { trash: moved.length ? path.relative(kit.root, trash) : null };
}

export { ArticleError };
