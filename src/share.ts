import path from "node:path";
import { escapeHtml, renderGuideHtml, writeAtomic } from "./build.ts";
import type { Kit } from "./kit.ts";
import { loadGuide } from "./kit.ts";
import { renderFrame } from "./preview.ts";
import { loadSite } from "./site.ts";
import { orientedGuide, pick } from "./schema.ts";

/**
 * The page of a video made to be sent on a phone: <output>/share/<id>/index.html plus poster.png. It is the same
 * player, fluid and without the docs-site chrome, that follows the phone's orientation (the picture fills the screen
 * turned sideways, with captions and controls over it) and the phone's language. The head carries the tags a chat
 * app reads to draw its link card (title, description, picture). Those need absolute addresses: they come from
 * site.json `url`; without it the page still works, only the card has no picture.
 */

export const shareDir = (kit: Kit, id: string) => path.join(kit.out, "share", id);

/** Picture and controls of a phone: portrait = picture, captions and bar one under the other; landscape = picture fills the screen, captions and bar over it. */
const CSS = `
html:has(> .cf-page), .cf-page { overscroll-behavior: none; -webkit-text-size-adjust: 100%; }
.cf-page { display: block; min-height: 100vh; min-height: 100dvh; padding: 0; }
.cf-app { max-width: none; }
.cf-stage { border-radius: 0; box-shadow: none; }
.cf-caption { padding: 12px 16px 0; font-size: 17px; line-height: 1.45; }
.cf-app { min-width: 0; overflow-x: clip; }
.cf-brand { top: 10px; bottom: auto; } /* the corner of the bar is for the controls */
/* portrait: the chapters take a row, the buttons the row under it */
.cf-bar { margin: 0; padding: 8px 12px calc(10px + env(safe-area-inset-bottom)); gap: 8px; flex-wrap: wrap; }
.cf-bar .cf-chapters { order: -1; flex: 1 1 100%; }
.cf-bar .cf-track { order: -1; flex: 1 1 100%; }
.cf-bar .cf-lang { margin-left: auto; }
.cf-bar button, .cf-bar select { min-height: 40px; min-width: 40px; font-size: 15px; }
.cf-transcript { margin: 14px 16px 0; }
.cf-share-fs svg { width: 18px; height: 18px; display: block; margin: auto; }
.cf-app:fullscreen { background: #000; display: flex; flex-direction: column; justify-content: center; }
@media (orientation: landscape) and (max-height: 620px) {
  .cf-page { display: block; overflow: hidden; background: #000; }
  .cf-app { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; background: #000; }
  .cf-stage { width: min(100vw, calc(100dvh * var(--cf-ar, 1.7778))); flex: none; }
  .cf-caption { position: absolute; left: 0; right: 0; bottom: 58px; min-height: 0; padding: 0 9%; pointer-events: none; font-size: clamp(13px, 3.4vh, 20px); }
  .cf-caption:not(:empty) { text-shadow: 0 1px 3px #000, 0 0 8px #000; color: #fff; }
  .cf-bar { position: absolute; left: 0; right: 0; bottom: 0; padding: 18px 16px 8px; flex-wrap: nowrap; background: linear-gradient(transparent, rgba(0, 0, 0, .7)); }
  .cf-bar .cf-chapters, .cf-bar .cf-track { order: 0; flex: 1 1 0; }
  .cf-bar .cf-lang { margin-left: 0; }
  .cf-bar button, .cf-bar select { min-height: 34px; }
  .cf-transcript { display: none; }
}`;

/** Full screen where the browser allows it (Android, desktop, iPad; an iPhone does not allow it for a page, which then simply fills the screen). Rotation is left to the phone. */
const SCRIPT = `
(function () {
  var app = document.querySelector(".cf-app"), cf = window.__cueflow;
  if (!app) return;
  var g = app.querySelector(".cf-stage");
  var W = __W__, H = __H__;
  document.documentElement.style.setProperty("--cf-ar", W / H);
  var can = document.fullscreenEnabled && app.requestFullscreen;
  if (!can) return;
  var words = { en: "Full screen", it: "Schermo intero", es: "Pantalla completa", fr: "Plein écran", de: "Vollbild" };
  var b = document.createElement("button");
  b.className = "cf-share-fs"; b.type = "button";
  b.setAttribute("aria-label", words[document.documentElement.lang.slice(0, 2)] || words.en);
  b.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>';
  var bar = app.querySelector(".cf-bar");
  bar.insertBefore(b, app.querySelector(".cf-lang"));
  function toggle() { if (document.fullscreenElement) document.exitFullscreen(); else app.requestFullscreen({ navigationUI: "hide" }).catch(function () {}); }
  b.onclick = toggle;
  // the first tap on Play also goes full screen: a request needs a tap
  var done = false;
  app.addEventListener("click", function (e) {
    if (done || !e.target.closest(".cf-big, .cf-play")) return;
    done = true;
    if (!document.fullscreenElement) app.requestFullscreen({ navigationUI: "hide" }).catch(function () {});
  }, true);
})();`;

export type ShareResult = { dir: string; file: string; poster: string | null; link: string | null; warnings: string[] };

/** The address the folder will have once published, from site.json `url`; null when the kit has none. */
async function publicBase(kit: Kit, id: string): Promise<string | null> {
  try {
    const site = await loadSite(kit);
    return site.url ? `${site.url.replace(/\/+$/, "")}/share/${id}/` : null;
  } catch {
    return null; // a kit without a catalog can still make a page for a phone
  }
}

/** A short line for the link card: the catalog's description when the video is in it, else the first narration. */
async function describe(kit: Kit, id: string, lang: string, fallback: string): Promise<{ title: string; description: string; posterAt: { step: number; at: number | string } }> {
  const guide = await loadGuide(kit, id);
  try {
    const site = await loadSite(kit);
    const item = site.items.find((i) => i.guide === id);
    if (item) {
      return {
        title: pick(item.title, lang, site.lang) ?? guide.title,
        description: pick(item.desc, lang, site.lang) ?? fallback,
        posterAt: item.posterAt ?? { step: 0, at: 1500 }
      };
    }
  } catch {
    // no catalog: use the guide's own words
  }
  return { title: guide.title, description: fallback, posterAt: { step: 0, at: 1500 } };
}

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1).replace(/\s+\S*$/, "")}…`);

/** Builds the page for phones of one video; `lang` is the language of the link card (the page itself follows the viewer's phone, or ?lang=). */
export async function buildShare(kit: Kit, id: string, opts: { lang?: string } = {}): Promise<ShareResult> {
  const guide = orientedGuide(await loadGuide(kit, id));
  const lang = opts.lang && guide.languages.includes(opts.lang) ? opts.lang : guide.languages[0]!;
  const warnings: string[] = [];
  const first = guide.steps[0]?.narration[lang] ?? "";
  const info = await describe(kit, id, lang, clip(first, 160));
  const base = await publicBase(kit, id);
  if (!base) warnings.push(`site.json has no "url": the page works, but a chat app cannot show a picture in the link card until the address is known. Add the address of the site (e.g. https://help.example.com) and build again.`);

  const dir = shareDir(kit, id);
  const posterUrl = base ? `${base}poster.png` : null;
  const tags = [
    `<meta property="og:type" content="video.other">`,
    `<meta property="og:title" content="${escapeHtml(info.title)}">`,
    `<meta property="og:description" content="${escapeHtml(info.description)}">`,
    `<meta property="og:locale" content="${escapeHtml(lang)}">`,
    base ? `<meta property="og:url" content="${escapeHtml(base)}">` : "",
    posterUrl ? `<meta property="og:image" content="${escapeHtml(posterUrl)}">\n<meta name="twitter:card" content="summary_large_image">\n<meta name="twitter:image" content="${escapeHtml(posterUrl)}">` : `<meta name="twitter:card" content="summary">`,
    `<meta name="description" content="${escapeHtml(info.description)}">`,
    `<meta name="theme-color" content="#0f1115">`
  ].filter(Boolean);
  // ?lang=it wins, then the phone's languages, then the video's first
  const mountOptions = `{ fluid: true, lang: (function (a) { var q = new URLSearchParams(location.search).get("lang"); return [q].concat((navigator.languages || [navigator.language || ""]).map(function (l) { return String(l).slice(0, 2).toLowerCase(); })).filter(function (l) { return a.indexOf(l) >= 0; })[0]; })(${JSON.stringify(guide.languages)}) }`;

  const { html } = await renderGuideHtml(kit, id, undefined, {
    extras: { head: tags.join("\n"), css: CSS, bodyEnd: SCRIPT.replace("__W__", String(guide.stage.width)).replace("__H__", String(guide.stage.height)), mountOptions }
  });
  const file = path.join(dir, "index.html");
  await writeAtomic(file, html);

  let poster: string | null = null;
  try {
    const png = await renderFrame(file, { step: info.posterAt.step, at: info.posterAt.at, lang, only: "stage" });
    poster = path.join(dir, "poster.png");
    await writeAtomic(poster, png);
  } catch (e) {
    warnings.push(`no picture for the link card (it needs a browser, Playwright): ${e instanceof Error ? e.message.split("\n")[0] : e}`);
  }
  return { dir, file, poster, link: base, warnings };
}
