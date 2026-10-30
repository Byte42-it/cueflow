import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { writeAtomic } from "./build.ts";
import type { Kit } from "./kit.ts";
import { sceneFile } from "./kit.ts";
import { launchChromium } from "./preview.ts";

/**
 * Scenes from a live site: each scene is a page of the site, brought to a state (logged in, a dialog open, a text
 * typed) and frozen as static HTML without scripts. The site's stylesheets, fonts and images are copied to shared/
 * with the path they have on the server, so the relative url()s of its CSS keep working and every scene shares them.
 * What to capture is data, capture.json in the kit:
 *
 *   { "base": "http://localhost:8080", "lang": "it",
 *     "login": { "url": "/login", "steps": [{ "fill": "#user", "value": "${APP_USER}" }, { "click": "button[type=submit]" }] },
 *     "replace": [{ "text": "Real Customer Ltd", "with": "Acme" }],
 *     "scenes": [{ "name": "orders", "url": "/orders", "cues": { "new-order": "text=New order" } }] }
 *
 * ${NAME} in any text is read from the environment, so passwords stay out of the kit. Selectors in steps, cues,
 * remove and hide are Playwright selectors: CSS, or text=…, :has-text(…), >> nth=…
 */

const Selector = z.string().min(1);
const Step = z.union([
  z.object({ goto: z.string() }).strict(),
  z.object({ click: Selector }).strict(),
  z.object({ fill: Selector, value: z.string() }).strict(),
  z.object({ type: Selector, text: z.string(), delay: z.number().min(0).default(50) }).strict(),
  z.object({ press: z.string(), on: Selector.optional() }).strict(),
  z.object({ select: Selector, option: z.string() }).strict(),
  z.object({ wait: z.number().min(0) }).strict(),
  z.object({ waitFor: Selector }).strict()
]);
export type CaptureStep = z.infer<typeof Step>;

const Replace = z.object({ text: z.string().min(1), with: z.string() });

const CaptureScene = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/i).describe("file name in scenes/, without .html"),
  url: z.string().optional().describe("page to open, relative to base (default: stay where the previous scene left)"),
  steps: z.array(Step).default([]).describe("what to do on the page before the picture is taken"),
  cues: z.record(Selector).default({}).describe("data-cue name → selector of the element that gets it (the first match)"),
  remove: z.array(Selector).default([]).describe("elements to drop from this scene"),
  hide: z.array(Selector).default([]).describe("elements kept but hidden (display: none), for a guide to show later"),
  replace: z.array(Replace).default([]),
  script: z
    .string()
    .optional()
    .describe("a .js file of the kit run in the live page before the copy is taken, for what selectors cannot say (later scenes that go on from this page see its changes)")
});

export const Capture = z.object({
  base: z.string().url(),
  lang: z.string().min(2).default("en").describe("browser language: native fields and formats follow it"),
  viewport: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).default({ width: 1280, height: 720 }),
  login: z.object({ url: z.string(), steps: z.array(Step) }).optional().describe("done once, before the scenes"),
  remove: z.array(Selector).default([]).describe("elements to drop from every scene (chat widgets, cookie banners, debug bars)"),
  replace: z.array(Replace).default([]).describe("texts to change in every scene: real names, plates, emails…"),
  nativeInputs: z
    .boolean()
    .default(false)
    .describe("keep native date and time fields; by default they become text in `lang`, since a native field shows the format of whoever watches"),
  scenes: z.array(CaptureScene).min(1)
});
export type Capture = z.infer<typeof Capture>;

export const captureFile = (kit: Kit) => path.join(kit.root, "capture.json");

/** ${NAME} → the environment variable; a missing one is an error, never an empty password. */
const fromEnv = (value: unknown): unknown => {
  if (typeof value === "string")
    return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, k: string) => {
      const v = process.env[k];
      if (v == null) throw new Error(`capture.json uses \${${k}} but the environment variable ${k} is not set`);
      return v;
    });
  if (Array.isArray(value)) return value.map(fromEnv);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fromEnv(v)]));
  return value;
};

export async function loadCapture(kit: Kit, file = captureFile(kit)): Promise<Capture> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    throw new Error(`no capture config at ${file}: describe the scenes to capture there (base, scenes with name, url, steps, cues)`);
  }
  const parsed = Capture.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new Error(`capture.json is not valid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return parsed.data;
}

export type CaptureResult = { scenes: { name: string; file: string; kb: number }[]; assets: number; warnings: string[] };

/** Font formats in the order a current browser wants them: only the best one of each face is copied. */
const FONT_RANK = [".woff2", ".woff", ".ttf", ".otf"];

/**
 * Runs in the page. The live page stays as it is (a later scene may go on from it): the scene is a copy of the
 * document, with what is visible frozen into attributes (field values, checks, selections), native date and time
 * fields turned into text, scripts and handlers dropped, links and forms made inert, the elements marked
 * data-cf-remove / data-cf-hide removed or hidden, the replacements applied. Returns the copy's HTML and the URLs of
 * the stylesheets and images it uses (made absolute).
 */
function freezePage(o: { lang: string; nativeInputs: boolean; replace: { text: string; with: string }[] }) {
  const swap = (s: string) => o.replace.reduce((acc, r) => acc.split(r.text).join(r.with), s);
  const live = Array.from(document.documentElement.querySelectorAll("*"));
  const root = document.documentElement.cloneNode(true) as HTMLElement;
  const copy = Array.from(root.querySelectorAll("*"));
  const twin = new Map(live.map((e, i) => [e, copy[i]!]));
  for (const e of live) e.removeAttribute("data-cf-remove"), e.removeAttribute("data-cf-hide"); // marks are for this scene only

  for (const i of Array.from(document.querySelectorAll("input"))) {
    const c = twin.get(i) as HTMLInputElement;
    if (i.type === "checkbox" || i.type === "radio") i.checked ? c.setAttribute("checked", "") : c.removeAttribute("checked");
    else if (i.type !== "file" && i.type !== "password") c.setAttribute("value", i.value);
    if (!o.nativeInputs && ["date", "time", "datetime-local", "month"].includes(i.type)) {
      // the same picture for every viewer: the value written in the capture language, as plain text
      const v = i.value;
      let shown = "";
      if (v && i.type === "date") shown = new Date(v + "T00:00").toLocaleDateString(o.lang, { day: "2-digit", month: "2-digit", year: "numeric" });
      else if (v && i.type === "time") shown = new Date("2000-01-01T" + v).toLocaleTimeString(o.lang, { hour: "2-digit", minute: "2-digit" });
      else if (v && i.type === "datetime-local") shown = new Date(v).toLocaleString(o.lang, { dateStyle: "short", timeStyle: "short" });
      else if (v && i.type === "month") shown = new Date(v + "-01T00:00").toLocaleDateString(o.lang, { month: "long", year: "numeric" });
      if (!v && i.type === "time") c.setAttribute("placeholder", "--:--");
      if (!v && i.type === "date") {
        // an empty date shows its pattern, as the native field does
        const parts = new Intl.DateTimeFormat(o.lang, { day: "2-digit", month: "2-digit", year: "numeric" }).formatToParts(new Date(2001, 1, 3));
        c.setAttribute("placeholder", parts.map((p) => (p.type === "day" ? "dd" : p.type === "month" ? "mm" : p.type === "year" ? "yyyy" : p.value)).join(""));
      }
      // apps size time fields for the native control, which squeezes its digits: as text, "14:01" fits only with less padding
      if (i.type === "time") c.setAttribute("style", `${c.getAttribute("style") ?? ""};padding-left:4px !important;padding-right:4px !important`);
      c.setAttribute("data-cf-type", i.type);
      c.setAttribute("type", "text");
      c.setAttribute("value", shown);
    }
  }
  for (const t of Array.from(document.querySelectorAll("textarea"))) twin.get(t)!.textContent = t.value;
  for (const s of Array.from(document.querySelectorAll("select")))
    for (const opt of Array.from(s.options)) opt.selected ? twin.get(opt)!.setAttribute("selected", "") : twin.get(opt)!.removeAttribute("selected");
  // absolute URLs, so that the assets can be fetched and the scene pointed at their copies
  const css: string[] = [];
  for (const l of Array.from(document.querySelectorAll<HTMLLinkElement>("link[rel~=stylesheet][href]"))) (twin.get(l)!.setAttribute("href", l.href), css.push(l.href));
  const imgs: string[] = [];
  for (const i of Array.from(document.querySelectorAll<HTMLImageElement>("img[src]"))) if (!i.src.startsWith("data:")) (twin.get(i)!.setAttribute("src", i.src), imgs.push(i.src));

  // a modal is drawn by the browser's top layer, which a copy does not have: keep where it was, and its dim backdrop
  for (const d of Array.from(document.querySelectorAll("dialog"))) {
    if (!d.matches(":modal")) continue;
    const r = d.getBoundingClientRect(), veil = getComputedStyle(d, "::backdrop").backgroundColor, overflow = getComputedStyle(d).overflowY;
    const c = twin.get(d) as HTMLElement;
    c.style.cssText += `;position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;margin:0;max-height:none;max-width:none;overflow:${overflow};z-index:2147483000;box-shadow:0 0 0 100vmax ${veil}`;
  }
  for (const e of Array.from(root.querySelectorAll("[data-cf-remove]"))) e.remove();
  for (const e of Array.from(root.querySelectorAll<HTMLElement>("[data-cf-hide]"))) (e.style.display = "none", e.removeAttribute("data-cf-hide"));
  // an iframe with srcdoc is page content (a capture script put it there); it stays, but sandboxed so nothing in it runs
  for (const e of Array.from(root.querySelectorAll("iframe[srcdoc]"))) e.setAttribute("sandbox", "");
  for (const e of Array.from(root.querySelectorAll("script, noscript, iframe:not([srcdoc]), object, embed, link[rel=preload], link[rel=modulepreload], link[rel=prefetch]"))) e.remove();
  for (const e of Array.from(root.querySelectorAll("*")))
    for (const a of Array.from(e.attributes)) if (/^on/i.test(a.name) || a.name === "srcset") e.removeAttribute(a.name);
  // a click in a guide is a real click: links and forms must not navigate away from the scene
  for (const a of Array.from(root.querySelectorAll("a[href]"))) a.setAttribute("href", "#");
  // nested forms (common in older apps) are dropped by the HTML parser when the scene is read back: no forms at all
  for (const f of Array.from(root.querySelectorAll("form"))) {
    const d = document.createElement("div");
    for (const a of Array.from(f.attributes)) d.setAttribute(a.name, a.value);
    while (f.firstChild) d.appendChild(f.firstChild);
    f.replaceWith(d);
  }

  if (o.replace.length) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) n.nodeValue = swap(n.nodeValue ?? "");
    for (const e of Array.from(root.querySelectorAll("[value],[placeholder],[title],[alt],[aria-label]")))
      for (const k of ["value", "placeholder", "title", "alt", "aria-label"]) if (e.hasAttribute(k)) e.setAttribute(k, swap(e.getAttribute(k) ?? ""));
  }

  const inline: string[] = [];
  for (const e of Array.from(root.querySelectorAll<HTMLElement>("[style*='url(']"))) {
    const style = e.getAttribute("style") ?? "";
    e.setAttribute(
      "style",
      style.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, _q, ref: string) => {
        if (ref.startsWith("data:")) return m;
        const abs = new URL(ref, document.baseURI).href;
        inline.push(abs);
        return `url("${abs}")`;
      })
    );
  }
  return { html: "<!doctype html>\n" + root.outerHTML, assets: [...css, ...imgs, ...inline] };
}

/** Runs the capture: every scene of capture.json (or only `only`), written to scenes/ with its assets in shared/. */
export async function captureScenes(kit: Kit, opts: { only?: string[]; config?: string } = {}): Promise<CaptureResult> {
  const cfg = fromEnv(await loadCapture(kit, opts.config)) as Capture;
  const origin = new URL(cfg.base).origin;
  const warnings: string[] = [];
  const unknown = (opts.only ?? []).filter((n) => !cfg.scenes.some((s) => s.name === n));
  if (unknown.length) throw new Error(`no scene ${unknown.join(", ")} in capture.json (scenes: ${cfg.scenes.map((s) => s.name).join(", ")})`);

  const browser = await launchChromium(cfg.lang);
  try {
    const context = await browser.newContext({ viewport: cfg.viewport, locale: cfg.lang });
    const page = await context.newPage();
    page.on("dialog", (d) => void d.dismiss());
    const at = (url: string) => new URL(url, cfg.base).href;
    const settle = () => page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => undefined);
    const run = async (steps: CaptureStep[], where: string) => {
      for (const [i, st] of steps.entries()) {
        try {
          if ("goto" in st) await page.goto(at(st.goto));
          else if ("click" in st) await page.locator(st.click).first().click();
          else if ("fill" in st) await page.locator(st.fill).first().fill(st.value);
          else if ("type" in st) await page.locator(st.type).first().pressSequentially(st.text, { delay: st.delay });
          else if ("press" in st) await (st.on ? page.locator(st.on).first().press(st.press) : page.keyboard.press(st.press));
          else if ("select" in st) await page.locator(st.select).first().selectOption({ label: st.option }).catch(() => page.locator(st.select).first().selectOption(st.option));
          else if ("wait" in st) await page.waitForTimeout(st.wait);
          else await page.locator(st.waitFor).first().waitFor();
          await settle();
        } catch (e) {
          throw new Error(`${where}, step ${i + 1} ${JSON.stringify(st)}: ${(e as Error).message.split("\n")[0]}`);
        }
      }
    };

    if (cfg.login) {
      await page.goto(at(cfg.login.url));
      await run(cfg.login.steps, "login");
    }

    // assets: one download per URL for the whole run, saved under shared/ with the server's path
    const saved = new Map<string, string | null>();
    const download = async (url: string): Promise<string | null> => {
      if (saved.has(url)) return saved.get(url)!;
      saved.set(url, null);
      const u = new URL(url);
      if (u.origin !== origin) {
        warnings.push(`not copied (another site): ${url}`);
        return null;
      }
      const res = await context.request.get(url).catch(() => null);
      if (!res || !res.ok()) {
        warnings.push(`not copied (${res ? res.status() : "no answer"}): ${url}`);
        return null;
      }
      let body = await res.body();
      let rel = path.posix.join("shared", decodeURIComponent(u.pathname));
      // images served by a script (/image.php?id=3) get a name per query and the extension of what they really are
      const magic = body.subarray(0, 12).toString("hex");
      const ext = magic.startsWith("89504e47") ? ".png" : magic.startsWith("ffd8") ? ".jpg" : magic.startsWith("47494638") ? ".gif"
        : magic.startsWith("52494646") && body.subarray(8, 12).toString() === "WEBP" ? ".webp" : null;
      if (ext && path.posix.extname(rel).toLowerCase() !== ext) {
        const q = u.search ? "-" + createHash("sha1").update(u.search).digest("hex").slice(0, 8) : "";
        rel = rel.replace(/\.[a-z0-9]+$/i, "") + q + ext;
      } else if (u.search && !/\.(css|woff2?|ttf|otf|svg|png|jpe?g|gif|webp)$/i.test(u.pathname)) {
        rel += "-" + createHash("sha1").update(u.search).digest("hex").slice(0, 8);
      }
      if (rel.endsWith(".css")) {
        const css = body.toString("utf8");
        // what the stylesheet uses: @import, images, and of each font face only its best format
        const refs = new Set<string>();
        for (const m of css.matchAll(/@import\s+(?:url\()?\s*['"]?([^'")\s;]+)/g)) refs.add(m[1]!);
        for (const face of css.match(/@font-face\s*\{[^}]*\}/g) ?? []) {
          const urls = [...face.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)].map((m) => m[2]!.split(/[?#]/)[0]!);
          const best = urls.filter((r) => FONT_RANK.includes(path.posix.extname(r).toLowerCase())).sort((a, b) => FONT_RANK.indexOf(path.posix.extname(a).toLowerCase()) - FONT_RANK.indexOf(path.posix.extname(b).toLowerCase()))[0];
          if (best) refs.add(best);
        }
        const withoutFaces = css.replace(/@font-face\s*\{[^}]*\}/g, "");
        for (const m of withoutFaces.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)) refs.add(m[2]!.split(/[?#]/)[0]!);
        for (const r of refs) if (r && !/^(data:|#)/.test(r)) await download(new URL(r, url).href);
        body = Buffer.from(css);
      }
      await writeAtomic(path.join(kit.root, rel), body);
      saved.set(url, rel);
      return rel;
    };

    const result: CaptureResult = { scenes: [], assets: 0, warnings };
    for (const sc of cfg.scenes) {
      // scenes run in order even when only some are written: a scene may depend on where the previous one left
      const where = `scene "${sc.name}"`;
      if (sc.url) await page.goto(at(sc.url));
      await settle();
      await run(sc.steps, where);
      if (opts.only && !opts.only.includes(sc.name)) continue;

      for (const [name, sel] of Object.entries(sc.cues)) {
        const el = page.locator(sel).first();
        if ((await el.count()) === 0) warnings.push(`${where}: cue "${name}" — "${sel}" matches nothing`);
        else await el.evaluate((e, n) => e.setAttribute("data-cue", n), name);
      }
      // only marked here: freezePage removes or hides them in the copy, the live page stays usable for the next scene
      for (const sel of [...cfg.remove, ...sc.remove]) await page.locator(sel).evaluateAll((els) => els.forEach((e) => e.setAttribute("data-cf-remove", "")));
      for (const sel of sc.hide) await page.locator(sel).evaluateAll((els) => els.forEach((e) => e.setAttribute("data-cf-hide", "")));
      if (sc.script) {
        const file = path.resolve(kit.root, sc.script);
        if (!file.startsWith(kit.root + path.sep)) throw new Error(`${where}: script "${sc.script}" points outside the kit`);
        const code = await readFile(file, "utf8").catch(() => {
          throw new Error(`${where}: script "${sc.script}" not found in the kit`);
        });
        await page.evaluate(code).catch((e: Error) => {
          throw new Error(`${where}: script "${sc.script}" failed: ${e.message.split("\n")[0]}`);
        });
      }

      const { html, assets } = await page.evaluate(freezePage, { lang: cfg.lang, nativeInputs: cfg.nativeInputs, replace: [...cfg.replace, ...sc.replace] });
      let out = html;
      const file = sceneFile(kit, sc.name);
      for (const url of new Set(assets)) {
        const rel = await download(url);
        if (!rel) continue;
        const local = path.posix.relative(path.posix.dirname(path.relative(kit.root, file).split(path.sep).join("/")), rel);
        // the URL appears in attributes (with &amp;) and in style attributes (url("…"))
        for (const form of [url, url.replace(/&/g, "&amp;")]) out = out.split(`"${form}"`).join(`"${local}"`).split(`&quot;${form}&quot;`).join(`&quot;${local}&quot;`);
      }
      await writeAtomic(file, out);
      result.scenes.push({ name: sc.name, file, kb: Math.round(out.length / 1024) });
    }
    result.assets = [...saved.values()].filter(Boolean).length;
    return result;
  } finally {
    await browser.close();
  }
}
