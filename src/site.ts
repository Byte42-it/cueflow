import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";
import { buildGuide, embed, escapeHtml, estimateDuration, guideBundle, playerAssets, writeAtomic } from "./build.ts";
import { loadBrief } from "./brief.ts";
import { recordChange } from "./changes.ts";
import { listGuides, loadGuide, type Kit } from "./kit.ts";
import { renderFrame } from "./preview.ts";
import { dataUri } from "./scene.ts";
import { pick, Site, siteLanguages, type Localized, type SiteItem } from "./schema.ts";
import type { TtsProvider } from "./tts.ts";

/**
 * A docs site from the kit's catalog (site.json): a home page with the featured tutorial, quick access and scrolling
 * rows, and one page per item with its video (a Cueflow guide), the transcript and the written guide (pages/<id>.html).
 * The look comes from the kit's theme like the player's; the site's own words from built-in labels or site.json.
 * Output: dist/site/, plain static files that work from any web server (and from file://, except sending requests).
 */
const here = path.dirname(fileURLToPath(import.meta.url));

export const siteFile = (kit: Kit) => path.join(kit.root, "site.json");
/** A page that cannot draw says why, instead of staying blank: the error and the browser, readable and copyable. */
const DIAGNOSTIC = `(function(){var shown=false;function show(m){if(shown)return;shown=true;var d=document.createElement("pre");d.style.cssText="position:fixed;inset:16px;z-index:99999;margin:0;padding:16px;background:#fff;color:#900;font:13px/1.5 monospace;white-space:pre-wrap;overflow:auto;border:2px solid #900";d.textContent="This Cueflow page could not be drawn.\\n\\n"+m+"\\n\\nBrowser: "+navigator.userAgent+"\\nAddress: "+location.href;(document.body||document.documentElement).appendChild(d)}window.addEventListener("error",function(e){show(e.message+" ("+String(e.filename||"").split("/").pop()+":"+e.lineno+")")});window.addEventListener("unhandledrejection",function(e){show("Unhandled: "+(e.reason&&e.reason.message||e.reason))});window.addEventListener("load",function(){setTimeout(function(){if(!document.body.innerText.trim())show("Nothing was drawn and no error was reported.")},1500)})})();`;

export const siteDir = (kit: Kit) => path.join(kit.out, "site");

const exists = (file: string) => stat(file).then(() => true, () => false);
/** A path in the kit that must stay inside it. */
const inKit = (kit: Kit, rel: string) => {
  const file = path.resolve(kit.root, rel);
  if (!file.startsWith(kit.root + path.sep)) throw new Error(`"${rel}" points outside the kit`);
  return file;
};

export async function loadSite(kit: Kit): Promise<Site> {
  let raw: string;
  try {
    raw = await readFile(siteFile(kit), "utf8");
  } catch {
    throw new Error(`the kit has no site.json (the catalog of the docs site): create it at ${siteFile(kit)}`);
  }
  const parsed = Site.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new Error(`site.json is not valid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return parsed.data;
}

/** The written guide of an item: pages/<lang>/<name> for a translation, pages/<name> in the site's own language. */
const articleFile = async (kit: Kit, it: SiteItem, lang?: string) => {
  const name = it.article ?? `${it.id}.html`;
  const file = inKit(kit, path.join("pages", ...(lang ? [lang] : []), name));
  return (await exists(file)) ? file : null;
};
/** Every value of a text given once or per language. */
const values = (v: Localized | undefined): string[] => (v == null ? [] : typeof v === "string" ? [v] : Object.values(v));

/** Mistakes that would produce a broken page are errors; gaps a reader would notice are warnings. */
export async function validateSite(kit: Kit, site: Site): Promise<{ errors: string[]; warnings: string[] }> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const guides = await listGuides(kit);
  const { languages, fallback } = siteLanguages(site);
  if (!languages.includes(fallback)) errors.push(`fallback "${fallback}" is not one of the languages (${languages.join(", ")})`);
  const ids = new Set<string>();
  const rows = new Set(site.rows.map((r) => r.id));
  for (const it of site.items) {
    if (ids.has(it.id)) errors.push(`duplicate item id "${it.id}"`);
    ids.add(it.id);
    if (!rows.has(it.row)) errors.push(`item "${it.id}": row "${it.row}" does not exist (rows: ${[...rows].join(", ") || "none"})`);
    if (it.status === "video" && !it.guide) errors.push(`item "${it.id}" is a video but names no guide`);
    if (it.guide && !guides.includes(it.guide)) errors.push(`item "${it.id}": guide "${it.guide}" does not exist (guides: ${guides.join(", ") || "none"})`);
    for (const [what, rel] of [...values(it.poster).map((p) => ["poster", p] as const), ["icon", it.icon] as const]) {
      if (rel && !(await exists(inKit(kit, rel)))) errors.push(`item "${it.id}": ${what} "${rel}" not found in the kit`);
    }
    for (const lang of languages) {
      const missing = (["title", "desc"] as const).filter((k) => typeof it[k] === "object" && (it[k] as Record<string, string>)[lang] == null);
      if (missing.length) warnings.push(`item "${it.id}": no ${missing.join(", ")} in "${lang}"`);
    }
    if (it.article && !(await articleFile(kit, it))) errors.push(`item "${it.id}": article pages/${it.article} not found`);
    if (it.status === "guide" && !(await articleFile(kit, it))) warnings.push(`item "${it.id}" is a written guide but has no pages/${it.id}.html`);
  }
  if (site.featured) {
    const f = site.items.find((i) => i.id === site.featured);
    if (!f) errors.push(`featured "${site.featured}" is not an item`);
    else if (f.status === "soon") errors.push(`featured "${site.featured}" has no page yet (status soon)`);
  }
  const cors = corsNeed(site);
  if (cors) warnings.push(cors);
  if (site.requestEndpoint && !site.url) warnings.push("requestEndpoint is set but url is not: set url (where the site is published) to check that the endpoint accepts requests from it");
  if (site.brand?.logo && !(await exists(inKit(kit, site.brand.logo)))) errors.push(`brand logo "${site.brand.logo}" not found in the kit`);
  for (const [what, rel] of [["brand logo", site.brand?.logo], ...site.items.map((it) => [`item "${it.id}": icon`, it.icon])] as const) {
    if (rel && !/\.(svg|png|jpe?g|gif|webp)$/i.test(rel)) errors.push(`${what} "${rel}" must be an svg, png, jpg, gif or webp file`);
  }
  if (site.favicon && !(await exists(inKit(kit, site.favicon)))) errors.push(`favicon "${site.favicon}" not found in the kit`);
  return { errors, warnings };
}

type Section = { id: string; title: string; subs: { id: string; title: string }[] };

/** The written guide: sections with their h3 for the side index; local images become data URIs. */
async function readArticle(file: string): Promise<{ html: string; sections: Section[] }> {
  const { document } = parseHTML(`<!doctype html><html><body><div id="cf-root">${await readFile(file, "utf8")}</div></body></html>`);
  const box = document.getElementById("cf-root")!;
  for (const img of [...box.querySelectorAll("img[src]")]) {
    const src = img.getAttribute("src")!;
    if (/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(src)) continue;
    const uri = await dataUri(path.resolve(path.dirname(file), src));
    if (uri) img.setAttribute("src", uri);
  }
  let sections = [...box.querySelectorAll("section[id]")];
  if (!sections.length) {
    // an article without sections is one section: it can still be printed and indexed
    const s = document.createElement("section");
    s.id = "article";
    s.innerHTML = box.innerHTML;
    box.innerHTML = "";
    box.appendChild(s);
    sections = [s];
  }
  const out: Section[] = sections.map((s) => {
    const h2 = s.querySelector("h2");
    const title = s.getAttribute("data-title") || h2?.textContent?.trim() || s.id;
    s.setAttribute("data-title", title);
    s.classList.add("cf-section");
    const subs = [...s.querySelectorAll("h3[id]")].map((h) => ({ id: h.id, title: (h.textContent ?? "").trim() }));
    return { id: s.id, title, subs };
  });
  return { html: box.innerHTML, sections: out };
}

/** A logo or icon as markup: an SVG file inlined (it takes the text color), any other picture as an <img>. */
async function imageInline(kit: Kit, rel?: string): Promise<string | undefined> {
  if (!rel) return undefined;
  const file = inKit(kit, rel);
  if (path.extname(file).toLowerCase() === ".svg") {
    const svg = await readFile(file, "utf8");
    return svg.replace(/<\?xml[^>]*>/, "").replace(/<script[\s\S]*?<\/script>/gi, "").trim();
  }
  const uri = await dataUri(file);
  if (!uri) throw new Error(`"${rel}" is not an image Cueflow can embed (svg, png, jpg, gif, webp)`);
  return `<img src="${uri}" alt="">`;
}

const ABOUT: Record<string, string> = { en: "about", it: "circa", fr: "environ", de: "etwa", es: "unos", pt: "cerca de" };

/** "about 3 min" in each language of the site, from the guide's estimated length when site.json gives none. */
function durationLabel(guide: Parameters<typeof estimateDuration>[0], languages: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const lang of languages) {
    const sec = estimateDuration(guide, guide.languages.includes(lang) ? lang : guide.languages[0]) / 1000;
    const about = ABOUT[lang.slice(0, 2)] ?? ABOUT.en;
    out[lang] = sec < 90 ? `${about} ${Math.max(10, Math.round(sec / 10) * 10)} s` : `${about} ${Math.round(sec / 60)} min`;
  }
  return out;
}

export type SiteResult = { dir: string; pages: string[]; posters: string[]; warnings: string[] };

export async function buildSite(kit: Kit, opts: { provider?: TtsProvider | null; posters?: boolean }): Promise<SiteResult> {
  const site = await loadSite(kit);
  const report = await validateSite(kit, site);
  if (report.errors.length) throw new Error(`the site is not valid:\n- ${report.errors.join("\n- ")}`);
  const warnings = [...report.warnings];
  const out = siteDir(kit);

  // one stylesheet and one script for every page: site + player + kit theme
  const { js: playerJs, css: playerCss, theme } = await playerAssets(kit);
  const [siteJs, siteCss] = await Promise.all([readFile(path.join(here, "site", "site.js"), "utf8"), readFile(path.join(here, "site", "site.css"), "utf8")]);
  await writeAtomic(path.join(out, "assets", "cueflow.css"), `${siteCss}\n${playerCss}\n${theme.css ? `/* kit theme */\n${theme.css}\n` : ""}`);
  await writeAtomic(path.join(out, "assets", "cueflow.js"), `${playerJs}\n${siteJs}\n`);

  // posters: the kit's own image, a frame of the guide (when asked), or one rendered by an earlier build
  // posters, per language: the kit's own image, a frame of the guide (when asked), or one rendered by an earlier build
  const { languages, fallback } = siteLanguages(site);
  const posters: string[] = [];
  const posterOf: Record<string, Record<string, string>> = {};
  for (const it of site.items) {
    const mine: Record<string, string> = {};
    for (const lang of languages) {
      const target = (ext: string) => path.join(out, "posters", `${it.id}.${lang}${ext}`);
      const own = pick(it.poster, lang, fallback);
      if (own) {
        const ext = path.extname(own).toLowerCase();
        await writeAtomic(target(ext), await readFile(inKit(kit, own)));
        mine[lang] = `posters/${it.id}.${lang}${ext}`;
      } else if (it.guide && opts.posters) {
        try {
          const built = await buildGuide(kit, it.guide, null);
          const at = it.posterAt ?? { step: 0, at: 1500 };
          await writeAtomic(target(".png"), await renderFrame(built.file, { step: at.step, at: at.at, lang, only: "stage" }));
          mine[lang] = `posters/${it.id}.${lang}.png`;
          posters.push(`${it.id} (${lang})`);
        } catch (e) {
          warnings.push(`poster of "${it.id}" (${lang}) not rendered: ${e instanceof Error ? e.message : e}`);
        }
      } else if (await exists(target(".png"))) {
        mine[lang] = `posters/${it.id}.${lang}.png`;
      }
    }
    if (Object.keys(mine).length) posterOf[it.id] = mine;
  }

  // the catalog as the pages see it
  const chapters: Record<string, Localized[]> = {};
  const durations: Record<string, Localized> = {};
  const bundles: Record<string, Awaited<ReturnType<typeof guideBundle>>> = {};
  for (const it of site.items) {
    if (!it.guide || it.status === "soon") continue;
    const b = (bundles[it.guide] ??= await guideBundle(kit, it.guide, opts.provider));
    warnings.push(...b.warnings.map((w) => `${it.guide}: ${w}`));
    chapters[it.id] = b.guide.steps.map((s, i) => s.title ?? `${i + 1}`);
    if (!it.duration) durations[it.id] = durationLabel(b.guide, languages);
  }
  const catalog = {
    title: site.title,
    lang: site.lang,
    languages,
    fallback,
    brand: site.brand ? { name: site.brand.name, logo: await imageInline(kit, site.brand.logo), url: site.brand.url } : { name: site.title },
    footer: site.footer,
    requestEndpoint: site.requestEndpoint,
    featured: site.featured,
    quickAccess: site.quickAccess,
    rows: site.rows,
    labels: site.labels,
    items: await Promise.all(
      site.items.map(async (it) => ({
        id: it.id,
        row: it.row,
        status: it.status,
        title: it.title,
        kicker: it.kicker,
        desc: it.desc,
        duration: it.duration ?? durations[it.id],
        contents: it.contents,
        chapters: chapters[it.id] ?? [],
        href: it.status === "soon" ? undefined : `${it.id}/index.html`,
        poster: posterOf[it.id],
        icon: await imageInline(kit, it.icon)
      }))
    )
  };

  const favicon = site.favicon ? await dataUri(inKit(kit, site.favicon)) : null;
  const head =
    (favicon ? `<link rel="icon" href="${favicon}">\n` : "") +
    site.stylesheets.map((href) => `<link rel="stylesheet" href="${escapeHtml(href)}">\n`).join("");
  const page = (title: string, root: string, body: string, data: unknown) => `<!doctype html>
<html lang="${escapeHtml(fallback)}" data-cf-scheme="${site.colorScheme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
${head}<link rel="stylesheet" href="${root}assets/cueflow.css">
</head>
<body class="cf-site">
${body}
<noscript><p style="padding:24px;font:16px sans-serif">This page needs JavaScript.</p></noscript>
<script>${DIAGNOSTIC}</script>
<script>window.CUEFLOW_SITE = ${embed(data)};</script>
<script src="${root}assets/cueflow.js"></script>
</body>
</html>
`;

  const pages: string[] = [];
  const name = (v: Localized) => pick(v, fallback, fallback) ?? "";
  await writeAtomic(path.join(out, "index.html"), page(name(site.title), "", '<main id="cf-home"></main>', { page: "home", root: "", catalog }));
  pages.push("index.html");

  for (const it of site.items) {
    if (it.status === "soon") continue;
    // the written guide in every language that has it; the page shows the original where a translation is missing
    const articles: Record<string, { lang: string; html: string; sections: Section[] }> = {};
    const base = await articleFile(kit, it);
    if (base) articles[site.lang] = { lang: site.lang, ...(await readArticle(base)) };
    for (const lang of languages) {
      if (lang === site.lang) continue;
      const own = await articleFile(kit, it, lang);
      if (own) articles[lang] = { lang, ...(await readArticle(own)) };
      else if (base) warnings.push(`item "${it.id}": no pages/${lang}/${it.article ?? `${it.id}.html`}, the ${site.lang} article is shown`);
    }
    const b = it.guide ? bundles[it.guide] : undefined;
    const body =
      `<div id="cf-print-cover"></div>\n<div class="cf-layout"><nav class="cf-side" aria-label="index"></nav><main class="cf-main">\n` +
      `<div class="cf-video-zone"><h1></h1>${b ? '<div id="cf-player"></div><section id="transcript" class="cf-section cf-transcript-section"></section>' : ""}</div>\n` +
      (Object.keys(articles).length ? `<div class="cf-deep-head"></div>\n<div class="cf-article"></div>\n` : "") +
      (site.footer ? `<p class="cf-foot"></p>` : "") +
      `</main></div>`;
    const data = {
      page: "item",
      root: "../",
      catalog,
      item: it.id,
      articles,
      guide: b ? { ...b.data, labels: theme.labels } : undefined
    };
    await writeAtomic(path.join(out, it.id, "index.html"), page(`${name(it.title)} · ${name(site.title)}`, "../", body, data));
    pages.push(`${it.id}/index.html`);
  }
  return { dir: out, pages, posters, warnings };
}

/**
 * Makes the catalog follow the tutorials: creates site.json when there is none, and adds an item for every tutorial
 * that has no entry yet (nothing is removed or rewritten: the catalog is also edited by hand).
 */
export async function syncSite(kit: Kit): Promise<{ created: boolean; added: string[] }> {
  const ids = await listGuides(kit);
  const guides = await Promise.all(ids.map((id) => loadGuide(kit, id)));
  const brief = await loadBrief(kit);
  let created = false;
  let site: Site;
  try {
    site = await loadSite(kit);
  } catch (e) {
    if (await readFile(siteFile(kit), "utf8").then(() => true, () => false)) throw e; // invalid, not missing: do not overwrite
    created = true;
    const languages = brief.languages.length ? brief.languages : [...new Set(guides.flatMap((g) => g.languages))];
    site = Site.parse({ title: brief.site ?? "Tutorials", lang: languages[0] ?? "en", languages, rows: [{ id: "tutorials", title: "Tutorials" }] });
  }
  const row = site.rows[0]?.id ?? "tutorials";
  if (!site.rows.length) site.rows.push({ id: row, title: "Tutorials", band: false, askTile: false });
  const known = new Set(site.items.map((i) => i.guide).filter(Boolean));
  const added: string[] = [];
  for (const g of guides) {
    if (known.has(g.id) || site.items.some((i) => i.id === g.id)) continue;
    site.items.push({ id: g.id, row, status: "video", guide: g.id, title: g.title, desc: "", contents: [] } as SiteItem);
    added.push(g.id);
  }
  if (!site.featured && site.items[0]) site.featured = site.items[0].id;
  if (created || added.length || !site.featured) await writeAtomic(siteFile(kit), JSON.stringify(site, null, 2) + "\n");
  return { created, added };
}

/** Changes one text of a catalog item (title, kicker, desc) in one language; other languages keep theirs. */
export async function setSiteText(kit: Kit, itemId: string, field: "title" | "kicker" | "desc", lang: string, value: string): Promise<void> {
  const raw = JSON.parse(await readFile(siteFile(kit), "utf8"));
  const site = Site.parse(raw);
  const item = (raw.items as any[]).find((i) => i.id === itemId);
  if (!item) throw new Error(`the dashboard has no item "${itemId}"`);
  const languages = siteLanguages(site).languages;
  const old = item[field];
  const before = pick(old, lang, site.lang) ?? "";
  let next: any = old;
  if (typeof old === "object" && old) next = { ...old, [lang]: value };
  else if (languages.length > 1 || lang !== site.lang) {
    next = {};
    for (const l of languages) next[l] = typeof old === "string" ? old : "";
    next[lang] = value;
  } else next = value;
  item[field] = next;
  Site.parse(raw);
  await writeAtomic(siteFile(kit), JSON.stringify(raw, null, 2) + "\n");
  await recordChange(kit, { kind: "catalog", lang, tutorial: item.guide, target: `${itemId}.${field}`, before, after: value });
}

/** When the request endpoint lives on another origin than the site, browsers ask it first (CORS preflight). */
function corsNeed(site: Site): string | null {
  if (!site.url || !site.requestEndpoint) return null;
  const from = new URL(site.url).origin, to = new URL(site.requestEndpoint).origin;
  if (from === to) return null;
  return `requestEndpoint is on ${to}, the site on ${from}: the endpoint must allow the origin ${from} (CORS, POST with Content-Type: application/json). Check it with \`cueflow check-endpoint\``;
}

export type EndpointCheck = { ok: boolean; origin: string; endpoint: string; status?: number; allowOrigin?: string | null; message: string };

/**
 * Asks the request endpoint what a browser on the site would ask before sending the form (the CORS preflight), so a
 * missing origin is found before publishing, not by the first visitor. Sends no request body and creates nothing.
 */
export async function checkEndpoint(site: Site, fetchImpl: typeof fetch = fetch): Promise<EndpointCheck> {
  if (!site.requestEndpoint) return { ok: true, origin: "", endpoint: "", message: "no requestEndpoint: the request form is not shown" };
  if (!site.url) throw new Error("site.json has no url: set where the site is published (e.g. https://help.example.com) to check the endpoint from there");
  const origin = new URL(site.url).origin, endpoint = site.requestEndpoint;
  if (new URL(endpoint).origin === origin) return { ok: true, origin, endpoint, message: "same origin as the site: no CORS needed" };
  let res: Response;
  try {
    res = await fetchImpl(endpoint, {
      method: "OPTIONS",
      headers: { Origin: origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" }
    });
  } catch (e) {
    return { ok: false, origin, endpoint, message: `the endpoint does not answer: ${e instanceof Error ? e.message : e}` };
  }
  const allowOrigin = res.headers.get("access-control-allow-origin");
  const allowHeaders = (res.headers.get("access-control-allow-headers") ?? "").toLowerCase();
  const originOk = allowOrigin === "*" || allowOrigin === origin;
  const headersOk = allowHeaders === "*" || allowHeaders.split(",").map((h) => h.trim()).includes("content-type");
  const ok = res.status < 300 && originOk && headersOk;
  const message = ok
    ? `the endpoint accepts requests from ${origin}`
    : !originOk
      ? `the endpoint refuses requests from ${origin} (status ${res.status}${allowOrigin ? `, it allows ${allowOrigin}` : ", no Access-Control-Allow-Origin"}): add ${origin} to the origins it allows`
      : !headersOk
        ? `the endpoint allows ${origin} but not the Content-Type header: allow it for the preflight`
        : `the preflight failed with status ${res.status}`;
  return { ok, origin, endpoint, status: res.status, allowOrigin, message };
}
