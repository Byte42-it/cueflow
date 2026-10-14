import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseHTML } from "linkedom";
import type { Kit } from "./kit.ts";
import { sceneFile } from "./kit.ts";

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf"
};

const isLocal = (ref: string) => !/^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(ref);

async function dataUri(file: string): Promise<string | null> {
  const mime = MIME[path.extname(file).toLowerCase()];
  if (!mime) return null;
  try {
    return `data:${mime};base64,${(await readFile(file)).toString("base64")}`;
  } catch {
    return null;
  }
}

/** url(...) references in CSS to local files become data URIs, so the output stays one self-contained file. */
async function inlineCssUrls(css: string, baseDir: string): Promise<string> {
  const found = [...css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)];
  let out = css;
  for (const m of found) {
    const ref = m[2]!;
    if (!isLocal(ref)) continue;
    const uri = await dataUri(path.resolve(baseDir, ref.split(/[?#]/)[0]!));
    if (uri) out = out.replace(m[0], `url("${uri}")`);
  }
  return out;
}

/** The scene as one standalone HTML string: local stylesheets, scripts and images are inlined. */
export async function inlineScene(kit: Kit, scene: string): Promise<string> {
  const file = sceneFile(kit, scene);
  const baseDir = path.dirname(file);
  const { document } = parseHTML(await readFile(file, "utf8"));

  for (const link of [...document.querySelectorAll('link[rel~="stylesheet"][href]')]) {
    const href = link.getAttribute("href")!;
    if (!isLocal(href)) continue;
    const cssPath = path.resolve(baseDir, href);
    const style = document.createElement("style");
    style.textContent = await inlineCssUrls(await readFile(cssPath, "utf8"), path.dirname(cssPath));
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
    const uri = await dataUri(path.resolve(baseDir, src));
    if (uri) img.setAttribute("src", uri);
  }
  for (const el of [...document.querySelectorAll("[style*='url(']")]) {
    el.setAttribute("style", await inlineCssUrls(el.getAttribute("style")!, baseDir));
  }
  return "<!doctype html>\n" + document.documentElement.outerHTML;
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
