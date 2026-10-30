import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
 * Slides as a PDF: one page per slide, complete (every press done), at the size of the scenes. The pages are pictures
 * of the slides, so the PDF looks exactly like the presentation, fonts and colors included; it is a handout and a
 * file to send, not an editable deck. Needs Chromium, like the previews.
 */
export async function buildSlidesPdf(kit: Kit, id: string, lang: string, onProgress: (progress: PdfProgress) => void = () => {}) {
  onProgress({ percent: 0, phase: "Preparing the slides…" });
  const guide = orientedGuide(await loadGuide(kit, id));
  if (guide.format !== "slides") throw new Error(`"${id}" is a video, not slides: a PDF is made from slides only (export a video as MP4)`);
  if (!guide.languages.includes(lang)) throw new Error(`"${id}" has no language "${lang}" (languages: ${guide.languages.join(", ")})`);
  if (!guide.steps.length) throw new Error("Add at least one slide before exporting the PDF.");
  const { width, height } = guide.viewport;
  const browser = await launchChromium(lang);
  const temp = await mkdtemp(path.join(tmpdir(), "cueflow-pdf-"));
  try {
    const { html } = await renderGuideHtml(kit, id, null, { lang });
    await writeFile(path.join(temp, "player.html"), html);
    onProgress({ percent: 5, phase: "Opening the slides…" });
    // the stage at the scene's own size: the camera frames each slide as in the presentation, at scale 1
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2, locale: lang });
    await page.goto(pathToFileURL(path.join(temp, "player.html")).href);
    await page.waitForFunction("!!window.__cueflow && !window.__cueflow.state().loading");
    await page.addStyleTag({
      content: `html,body{margin:0!important;padding:0!important} .cf-page{display:block!important;padding:0!important} .cf-app{width:${width}px!important;max-width:none!important}
        .cf-bar,.cf-big,.cf-veil-text,.cf-sl-notes,.cf-cursor,.cf-ring,.cf-brand,.cf-up-next{display:none!important}
        .cf-stage{height:${height}px!important;aspect-ratio:auto!important;border-radius:0!important;box-shadow:none!important}`
    });
    const pictures: Buffer[] = [];
    for (let i = 0; i < guide.steps.length; i++) {
      onProgress({ percent: Math.floor(10 + (80 * i) / guide.steps.length), phase: `Slide ${i + 1} of ${guide.steps.length}…` });
      await page.evaluate(async ({ i, lang, at }) => (window as unknown as { __cueflow: { seek(i: number, t: number, l: string): Promise<unknown> } }).__cueflow.seek(i, at, lang), { i, lang, at: COMPLETE });
      await page.waitForTimeout(300); // fonts and layout settle; seek itself applies everything without transitions
      pictures.push(await page.locator(".cf-stage").screenshot());
    }

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
    await rm(temp, { recursive: true, force: true });
  }
}
