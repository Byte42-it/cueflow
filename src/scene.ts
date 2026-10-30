import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parseHTML } from "linkedom";
import type { Kit } from "./kit.ts";
import { sceneFileFor } from "./kit.ts";

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf"
};

const isLocal = (ref: string) => !/^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(ref);
const exists = (file: string) => stat(file).then(() => true, () => false);
const bare = (ref: string) => ref.split(/[?#]/)[0]!;

/** Font formats in the order a current browser wants them; the rest exist only for old browsers. */
const FONT_RANK = [".woff2", ".woff", ".ttf", ".otf"];
const FONT_FORMAT = ["woff2", "woff", "truetype", "opentype"];

/**
 * Every @font-face keeps a single local source, the best format the kit has (woff2, else woff, else ttf/otf).
 * Sites list eot/woff2/woff/ttf/svg for old browsers; inlined as data URIs they would multiply the weight of every
 * scene for nothing. A face that uses a remote file, or has none of these formats on disk, is left as it is.
 */
export async function bestFontSources(css: string, baseDir: string): Promise<string> {
  let out = css;
  for (const [face] of css.matchAll(/@font-face\s*\{[^}]*\}/g)) {
    const refs = [...face.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)].map((r) => r[2]!);
    if (!refs.length || refs.some((r) => !isLocal(r))) continue;
    let best: { ref: string; rank: number } | null = null;
    for (const ref of refs) {
      const rank = FONT_RANK.indexOf(path.extname(bare(ref)).toLowerCase());
      if (rank < 0 || (best && best.rank <= rank)) continue;
      if (await exists(path.resolve(baseDir, bare(ref)))) best = { ref, rank };
    }
    if (!best) continue;
    // every src declaration goes, one comes back first with the chosen file (minified CSS has no ";" before "}")
    const kept = face
      .replace(/\bsrc\s*:[^;}]*;?/g, "")
      .replace(/^@font-face\s*\{/, `@font-face{src: url("${bare(best.ref)}") format("${FONT_FORMAT[best.rank]}");`);
    out = out.replace(face, kept);
  }
  return out;
}

export async function dataUri(file: string): Promise<string | null> {
  const mime = MIME[path.extname(file).toLowerCase()];
  if (!mime) return null;
  try {
    return `data:${mime};base64,${(await readFile(file)).toString("base64")}`;
  } catch {
    return null;
  }
}

/** url(...) references in CSS to local files become data URIs, so the output stays one self-contained file. */
export async function inlineCssUrls(css: string, baseDir: string): Promise<string> {
  css = await bestFontSources(css, baseDir);
  const found = [...css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)];
  let out = css;
  for (const m of found) {
    const ref = m[2]!;
    if (!isLocal(ref)) continue;
    const uri = await dataUri(path.resolve(baseDir, bare(ref)));
    if (uri) out = out.replace(m[0], `url("${uri}")`);
  }
  return out;
}

/**
 * Stylesheets and images shared by the scenes of one guide, by content hash. Scenes of a site link the same big
 * files (framework, theme, icon fonts, logo): kept here once, each scene carries only placeholders that the player
 * fills when it loads the scene (`<style data-cf-style="hash">`, `src="cf-shared:hash"`), not a full copy per scene.
 */
export type Shared = Record<string, string>;
const share = (shared: Shared, content: string) => {
  const hash = createHash("sha256").update(content).digest("hex").slice(0, 16);
  shared[hash] = content;
  return hash;
};
/** The scene with its shared parts put back: what the browser must receive. */
export const expandShared = (html: string, shared: Shared) =>
  html
    .replace(/<style data-cf-style="([0-9a-f]+)"><\/style>/g, (_, h: string) => `<style>${shared[h] ?? ""}</style>`)
    .replace(/cf-shared:([0-9a-f]+)/g, (_, h: string) => shared[h] ?? "");

/**
 * The scene as one standalone HTML string: local stylesheets, scripts and images are inlined. With `shared`, the
 * linked stylesheets and the images go there instead (once per content) and the scene keeps placeholders.
 */
/**
 * The document as HTML. linkedom writes attributes back escaping only the quote: a srcdoc holding another srcdoc would lose
 * one level of escaping and be cut at its first quote, so "&" is escaped here. This mutates the document: call it last.
 */
export function serializeDocument(document: Document): string {
  for (const el of document.querySelectorAll("*"))
    for (const { name, value } of [...el.attributes]) if (value.includes("&")) el.setAttribute(name, value.replace(/&/g, "&amp;"));
  return "<!doctype html>\n" + document.documentElement.outerHTML;
}

export async function inlineScene(kit: Kit, scene: string, lang?: string, shared?: Shared): Promise<string> {
  const file = await sceneFileFor(kit, scene, lang);
  const baseDir = path.dirname(file);
  const { document } = parseHTML(await readFile(file, "utf8"));

  for (const link of [...document.querySelectorAll('link[rel~="stylesheet"][href]')]) {
    const href = link.getAttribute("href")!;
    if (!isLocal(href)) continue;
    const cssPath = path.resolve(baseDir, bare(href));
    const css = (await inlineCssUrls(await readFile(cssPath, "utf8"), path.dirname(cssPath))).replace(/<\/style/gi, "<\\/style");
    const style = document.createElement("style");
    if (shared) style.setAttribute("data-cf-style", share(shared, css));
    else style.textContent = css;
    link.replaceWith(style);
  }
  for (const script of [...document.querySelectorAll("script[src]")]) {
    const src = script.getAttribute("src")!;
    if (!isLocal(src)) continue;
    const inline = document.createElement("script");
    inline.textContent = (await readFile(path.resolve(baseDir, src), "utf8")).replace(/<\/script/gi, "<\\/script");
    script.replaceWith(inline);
  }
  for (const img of [...document.querySelectorAll("img[src]")]) {
    const src = img.getAttribute("src")!;
    if (!isLocal(src)) continue;
    const uri = await dataUri(path.resolve(baseDir, bare(src)));
    if (uri) img.setAttribute("src", shared ? `cf-shared:${share(shared, uri)}` : uri);
  }
  for (const el of [...document.querySelectorAll("[style*='url(']")]) {
    el.setAttribute("style", await inlineCssUrls(el.getAttribute("style")!, baseDir));
  }
  return serializeDocument(document as unknown as Document);
}

export type SceneElement = { selector: string; tag: string; text: string; role?: string; hidden: boolean };

const INTERESTING = "[id],[data-cue],button,a,input,select,textarea,label,h1,h2,h3,nav,header,aside,main,form,table,li,[role]";

const cssEscape = (id: string): string => id.replace(/[^\w-]/g, (c) => `\\${c}`);

/** A short, stable selector: #id, [data-cue], or a tag/class path from the nearest identified ancestor. */
function selectorFor(el: Element): string {
  if (el.id) return `#${cssEscape(el.id)}`;
  const cue = el.getAttribute("data-cue");
  if (cue) return `[data-cue="${cue}"]`;
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && cur.tagName !== "BODY" && cur.tagName !== "HTML") {
    if (cur.id) {
      parts.unshift(`#${cssEscape(cur.id)}`);
      break;
    }
    const parent: Element | null = cur.parentElement;
    const same = parent ? [...parent.children].filter((c) => c.tagName === cur!.tagName) : [];
    const nth = same.length > 1 ? `:nth-of-type(${same.indexOf(cur) + 1})` : "";
    parts.unshift(cur.tagName.toLowerCase() + nth);
    cur = parent;
  }
  return parts.join(" > ");
}

/** What the model can target in a scene: elements with their best selector and visible text. */
export function describeScene(html: string): SceneElement[] {
  const { document } = parseHTML(html);
  const out: SceneElement[] = [];
  for (const el of document.querySelectorAll(INTERESTING)) {
    const text = (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
    const hidden = el.hasAttribute("hidden") || /display:\s*none/i.test(el.getAttribute("style") ?? "");
    out.push({ selector: selectorFor(el), tag: el.tagName.toLowerCase(), text, role: el.getAttribute("role") ?? undefined, hidden });
  }
  return out;
}

/** The text of the first element a selector matches, or undefined. */
export function firstText(html: string, selector: string): string | undefined {
  const { document } = parseHTML(html);
  try {
    return (document.querySelector(selector)?.textContent ?? undefined)?.replace(/\s+/g, " ").trim();
  } catch {
    return undefined;
  }
}

export function countMatches(html: string, selectors: string[]): Map<string, number | "invalid"> {
  const { document } = parseHTML(html);
  const result = new Map<string, number | "invalid">();
  for (const s of selectors) {
    try {
      result.set(s, document.querySelectorAll(s).length);
    } catch {
      result.set(s, "invalid");
    }
  }
  return result;
}
