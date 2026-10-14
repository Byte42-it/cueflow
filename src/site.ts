import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";
import { buildGuide, embed, escapeHtml, guideBundle, playerAssets, writeAtomic } from "./build.ts";
import { listGuides, type Kit } from "./kit.ts";
import { renderFrame } from "./preview.ts";
import { dataUri } from "./scene.ts";
import { Site, type SiteItem } from "./schema.ts";
import type { TtsProvider } from "./tts.ts";

/**
 * A docs site from the kit's catalog (site.json): a home page with the featured tutorial, quick access and scrolling
 * rows, and one page per item with its video (a Cueflow guide), the transcript and the written guide (pages/<id>.html).
 * The look comes from the kit's theme like the player's; the site's own words from built-in labels or site.json.
 * Output: dist/site/, plain static files that work from any web server (and from file://, except sending requests).
 */
const here = path.dirname(fileURLToPath(import.meta.url));

export const siteFile = (kit: Kit) => path.join(kit.root, "site.json");
export const siteDir = (kit: Kit) => path.join(kit.root, "dist", "site");
const pagesDir = (kit: Kit) => path.join(kit.root, "pages");

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

const articleFile = async (kit: Kit, it: SiteItem) => {
  if (it.article) return inKit(kit, path.join("pages", it.article));
  const def = path.join(pagesDir(kit), `${it.id}.html`);
  return (await exists(def)) ? def : null;
};

/** Mistakes that would produce a broken page are errors; gaps a reader would notice are warnings. */
export async function validateSite(kit: Kit, site: Site): Promise<{ errors: string[]; warnings: string[] }> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const guides = await listGuides(kit);
  const ids = new Set<string>();
  const rows = new Set(site.rows.map((r) => r.id));
  for (const it of site.items) {
    if (ids.has(it.id)) errors.push(`duplicate item id "${it.id}"`);
    ids.add(it.id);
    if (!rows.has(it.row)) errors.push(`item "${it.id}": row "${it.row}" does not exist (rows: ${[...rows].join(", ") || "none"})`);
    if (it.status === "video" && !it.guide) errors.push(`item "${it.id}" is a video but names no guide`);
    if (it.guide && !guides.includes(it.guide)) errors.push(`item "${it.id}": guide "${it.guide}" does not exist (guides: ${guides.join(", ") || "none"})`);
    for (const [what, rel] of [["poster", it.poster], ["icon", it.icon]] as const) {
      if (rel && !(await exists(inKit(kit, rel)))) errors.push(`item "${it.id}": ${what} "${rel}" not found in the kit`);
    }
    if (it.article && !(await exists(inKit(kit, path.join("pages", it.article))))) errors.push(`item "${it.id}": article pages/${it.article} not found`);
    if (it.status === "guide" && !(await articleFile(kit, it))) warnings.push(`item "${it.id}" is a written guide but has no pages/${it.id}.html`);
  }
  if (site.featured) {
    const f = site.items.find((i) => i.id === site.featured);
    if (!f) errors.push(`featured "${site.featured}" is not an item`);
    else if (f.status === "soon") errors.push(`featured "${site.featured}" has no page yet (status soon)`);
  }
  if (site.brand?.logo && !(await exists(inKit(kit, site.brand.logo)))) errors.push(`brand logo "${site.brand.logo}" not found in the kit`);
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

async function svgInline(kit: Kit, rel?: string): Promise<string | undefined> {
  if (!rel) return undefined;
  const svg = await readFile(inKit(kit, rel), "utf8");
  return svg.replace(/<\?xml[^>]*>/, "").replace(/<script[\s\S]*?<\/script>/gi, "").trim();
}

export type SiteResult = { dir: string; pages: string[]; posters: string[]; warnings: string[] };

export async function buildSite(kit: Kit, opts: { provider: TtsProvider | null; posters?: boolean }): Promise<SiteResult> {
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
  const posters: string[] = [];
  const posterOf: Record<string, string> = {};
  for (const it of site.items) {
    const target = (ext: string) => path.join(out, "posters", `${it.id}${ext}`);
    if (it.poster) {
      const ext = path.extname(it.poster).toLowerCase();
      await writeAtomic(target(ext), await readFile(inKit(kit, it.poster)));
      posterOf[it.id] = `posters/${it.id}${ext}`;
    } else if (it.guide && opts.posters) {
      try {
        const built = await buildGuide(kit, it.guide, null);
        const at = it.posterAt ?? { step: 0, at: 1500 };
        await writeAtomic(target(".png"), await renderFrame(built.file, { step: at.step, atMs: at.at, lang: site.lang, only: "stage" }));
        posterOf[it.id] = `posters/${it.id}.png`;
        posters.push(it.id);
      } catch (e) {
        warnings.push(`poster of "${it.id}" not rendered: ${e instanceof Error ? e.message : e}`);
      }
    } else if (await exists(target(".png"))) {
      posterOf[it.id] = `posters/${it.id}.png`;
    }
  }

  // the catalog as the pages see it
  const chapters: Record<string, string[]> = {};
  const bundles: Record<string, Awaited<ReturnType<typeof guideBundle>>> = {};
  for (const it of site.items) {
    if (!it.guide || it.status === "soon") continue;
    const b = (bundles[it.guide] ??= await guideBundle(kit, it.guide, opts.provider));
    warnings.push(...b.warnings.map((w) => `${it.guide}: ${w}`));
    chapters[it.id] = b.guide.steps.map((s, i) => s.title ?? `${i + 1}`);
  }
  const catalog = {
    title: site.title,
    lang: site.lang,
    brand: site.brand ? { name: site.brand.name, logo: await svgInline(kit, site.brand.logo) } : { name: site.title },
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
        duration: it.duration,
        contents: it.contents,
        chapters: chapters[it.id] ?? [],
        href: it.status === "soon" ? undefined : `${it.id}/index.html`,
        poster: posterOf[it.id],
        icon: await svgInline(kit, it.icon)
      }))
    )
  };

  const favicon = site.favicon ? await dataUri(inKit(kit, site.favicon)) : null;
  const head =
    (favicon ? `<link rel="icon" href="${favicon}">\n` : "") +
    site.stylesheets.map((href) => `<link rel="stylesheet" href="${escapeHtml(href)}">\n`).join("");
  const page = (title: string, root: string, body: string, data: unknown) => `<!doctype html>
<html lang="${escapeHtml(site.lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
${head}<link rel="stylesheet" href="${root}assets/cueflow.css">
</head>
<body class="cf-site">
${body}
<script>window.CUEFLOW_SITE = ${embed(data)};</script>
<script src="${root}assets/cueflow.js"></script>
</body>
</html>
`;

  const pages: string[] = [];
  await writeAtomic(path.join(out, "index.html"), page(site.title, "", '<main id="cf-home"></main>', { page: "home", root: "", catalog }));
  pages.push("index.html");

  for (const it of site.items) {
    if (it.status === "soon") continue;
    const file = await articleFile(kit, it);
    const article = file ? await readArticle(file) : { html: "", sections: [] };
    const b = it.guide ? bundles[it.guide] : undefined;
    const body =
      `<div id="cf-print-cover"></div>\n<div class="cf-layout"><nav class="cf-side" aria-label="index"></nav><main class="cf-main">\n` +
      `<div class="cf-video-zone"><h1>${escapeHtml(it.title)}</h1>${b ? '<div id="cf-player"></div><section id="transcript" class="cf-section cf-transcript-section"></section>' : ""}</div>\n` +
      (article.html ? `<div class="cf-deep-head"></div>\n<div class="cf-article">${article.html}</div>\n` : "") +
      (site.footer ? `<p class="cf-foot">${escapeHtml(site.footer)}</p>` : "") +
      `</main></div>`;
    const data = {
      page: "item",
      root: "../",
      catalog,
      item: it.id,
      sections: article.sections,
      guide: b ? { ...b.data, labels: theme.labels } : undefined
    };
    await writeAtomic(path.join(out, it.id, "index.html"), page(`${it.title} · ${site.title}`, "../", body, data));
    pages.push(`${it.id}/index.html`);
  }
  return { dir: out, pages, posters, warnings };
}
