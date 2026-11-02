import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { renderGuideHtml, writeAtomic } from "./build.ts";
import { loadGuide, type Kit } from "./kit.ts";
import { orientedGuide } from "./schema.ts";
import { launchChromium } from "./preview.ts";

export type PdfProgress = { percent: number; phase: string };

/** Far enough in a step that every group of a slide has played: the slide as it is left, complete. */
const COMPLETE = 1e9;

/**
 * Every slide as a picture of the stage, complete (every press done), at the scenes' own size times `scale`, with the
 * player's chrome hidden. The one loop behind the PDF (scale 2) and the images (scale 1: exactly the viewport's pixels).
 * Needs Chromium, like the previews.
 */
async function captureSlides(kit: Kit, id: string, lang: string, opts: { scale: number; type: "png" | "jpeg"; what: string; from: number; to: number }, onProgress: (progress: PdfProgress) => void) {
  onProgress({ percent: 0, phase: "Preparing the slides…" });
  const guide = orientedGuide(await loadGuide(kit, id));
  if (guide.format !== "slides") throw new Error(`"${id}" is a video, not slides: ${opts.what} is made from slides only (export a video as MP4)`);
  if (!guide.languages.includes(lang)) throw new Error(`"${id}" has no language "${lang}" (languages: ${guide.languages.join(", ")})`);
  if (!guide.steps.length) throw new Error(`Add at least one slide before exporting ${opts.what}.`);
  const { width, height } = guide.viewport;
  const browser = await launchChromium(lang);
  const temp = await mkdtemp(path.join(tmpdir(), "cueflow-slides-"));
  try {
    const { html } = await renderGuideHtml(kit, id, null, { lang });
    await writeFile(path.join(temp, "player.html"), html);
    onProgress({ percent: 5, phase: "Opening the slides…" });
    // the stage at the scene's own size: the camera frames each slide as in the presentation, at scale 1
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: opts.scale, locale: lang });
    await page.goto(pathToFileURL(path.join(temp, "player.html")).href);
    await page.waitForFunction("!!window.__cueflow && !window.__cueflow.state().loading");
    await page.addStyleTag({
      content: `html,body{margin:0!important;padding:0!important} .cf-page{display:block!important;padding:0!important} .cf-app{width:${width}px!important;max-width:none!important}
        .cf-bar,.cf-big,.cf-veil-text,.cf-sl-notes,.cf-cursor,.cf-ring,.cf-brand,.cf-up-next{display:none!important}
        .cf-stage{height:${height}px!important;aspect-ratio:auto!important;border-radius:0!important;box-shadow:none!important}`
    });
    const pictures: Buffer[] = [];
    for (let i = 0; i < guide.steps.length; i++) {
      onProgress({ percent: Math.floor(opts.from + ((opts.to - opts.from) * i) / guide.steps.length), phase: `Slide ${i + 1} of ${guide.steps.length}…` });
      await page.evaluate(async ({ i, lang, at }) => (window as unknown as { __cueflow: { seek(i: number, t: number, l: string): Promise<unknown> } }).__cueflow.seek(i, at, lang), { i, lang, at: COMPLETE });
      await page.waitForTimeout(300); // fonts and layout settle; seek itself applies everything without transitions
      pictures.push(await page.locator(".cf-stage").screenshot(opts.type === "jpeg" ? { type: "jpeg", quality: 92 } : { type: "png" }));
    }
    return { guide, width, height, pictures, browser };
  } catch (e) {
    await browser.close();
    throw e;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

/**
 * Slides as a PDF: one page per slide, complete (every press done), at the size of the scenes. The pages are pictures
 * of the slides, so the PDF looks exactly like the presentation, fonts and colors included; it is a handout and a
 * file to send, not an editable deck.
 */
export async function buildSlidesPdf(kit: Kit, id: string, lang: string, onProgress: (progress: PdfProgress) => void = () => {}) {
  const { guide, width, height, pictures, browser } = await captureSlides(kit, id, lang, { scale: 2, type: "png", what: "a PDF", from: 10, to: 90 }, onProgress);
  try {
    onProgress({ percent: 90, phase: "Writing the PDF…" });
    const doc = await browser.newPage();
    await doc.setContent(
      `<!doctype html><style>@page{size:${width}px ${height}px;margin:0}html,body{margin:0;padding:0}` +
        `img{display:block;width:${width}px;height:${height}px;page-break-after:always;break-after:page}img:last-child{page-break-after:auto;break-after:auto}</style>` +
        pictures.map((png) => `<img src="data:image/png;base64,${png.toString("base64")}">`).join("")
    );
    await doc.waitForFunction(() => [...document.images].every((img) => img.complete));
    const pdf = await doc.pdf({ width: `${width}px`, height: `${height}px`, printBackground: true, margin: { top: "0", right: "0", bottom: "0", left: "0" } });

    await mkdir(kit.out, { recursive: true });
    const name = `${guide.id}.${encodeURIComponent(lang)}.pdf`;
    const file = path.join(kit.out, name);
    await writeAtomic(file, pdf);
    onProgress({ percent: 100, phase: "PDF ready" });
    return { file, name, pages: pictures.length };
  } finally {
    await browser.close();
  }
}

/**
 * Slides as separate pictures, for a carousel: one file per slide, complete, at the exact size of the viewport (not
 * doubled), the same elements hidden as in the PDF. Files go to `<out>/<id>.<lang>.slides/01.png, 02.png…`; the folder
 * is replaced as a whole, so a shorter deck leaves no stale slide behind.
 */
export async function buildSlidesImages(kit: Kit, id: string, lang: string, format: "png" | "jpeg", onProgress: (progress: PdfProgress) => void = () => {}) {
  if (format !== "png" && format !== "jpeg") throw new Error('Image format must be "png" or "jpeg".');
  const { guide, width, height, pictures, browser } = await captureSlides(kit, id, lang, { scale: 1, type: format, what: "images", from: 5, to: 90 }, onProgress);
  try {
    onProgress({ percent: 90, phase: "Writing the images…" });
    const ext = format === "png" ? "png" : "jpg";
    const folder = `${guide.id}.${encodeURIComponent(lang)}.slides`;
    const dir = path.join(kit.out, folder), pending = `${dir}.tmp-${process.pid}`;
    await rm(pending, { recursive: true, force: true });
    await mkdir(pending, { recursive: true });
    const pad = Math.max(2, String(pictures.length).length);
    const names = pictures.map((_, i) => `${String(i + 1).padStart(pad, "0")}.${ext}`);
    await Promise.all(pictures.map((picture, i) => writeFile(path.join(pending, names[i]!), picture)));
    await rm(dir, { recursive: true, force: true });
    await rename(pending, dir);
    onProgress({ percent: 100, phase: "Images ready" });
    return { dir, folder, width, height, format, files: names.map((name) => ({ name, file: path.join(dir, name), url: `/out/${encodeURIComponent(folder)}/${name}` })) };
  } finally {
    await browser.close();
  }
}
