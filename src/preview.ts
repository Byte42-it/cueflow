import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

/**
 * Looks at a built guide in a real browser: renders frames as PNG (previews, posters, contact sheets) and measures
 * where elements are (layout checks). Needs the optional `playwright` package and a Chromium: the one Playwright
 * installs (`npx playwright install chromium`), or any Chromium/Chrome named by CUEFLOW_CHROMIUM.
 */

/** When to look: ms from the start of the step, or a percentage of its narration ("80%"), like an action's `at`. */
export type At = number | string;
export type Probe =
  | { found: false }
  | {
      found: true;
      visible: boolean;
      rect: { x: number; y: number; width: number; height: number };
      inView: "full" | "part" | "none";
      viewport: { width: number; height: number };
    };

/** The mounted player of the built page (src/player/player.js returns it as window.__cueflow). */
const PLAYER = "window.__cueflow";

export type PreviewSession = {
  /** step titles, in order */
  steps: string[];
  /** Goes to a point of the guide (replaying what comes before instantly) and returns the step's timing in ms. */
  seek(step: number, at: At): Promise<{ total: number; narration: number }>;
  /** The current picture: the whole player, or the stage alone without cursor, ring and mark (posters). */
  frame(only?: "player" | "stage"): Promise<Buffer>;
  probe(selector: string): Promise<Probe>;
  /** Several pictures with captions on one PNG (contact sheets). */
  sheet(frames: { png: Buffer; caption: string }[], columns?: number): Promise<Buffer>;
  close(): Promise<void>;
};

/** The guide's language, read from the built page: the browser runs in it so that native date and time fields match. */
const pageLang = async (htmlFile: string) => /<html lang="([^"]+)"/.exec((await readFile(htmlFile, "utf8")).slice(0, 400))?.[1] ?? "en";

/** Chromium through the optional playwright package, in a language (native fields, number and date formats). */
export async function launchChromium(lang: string) {
  let chromium: typeof import("playwright").chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    throw new Error("this needs the optional dependency playwright: npm install playwright && npx playwright install chromium");
  }
  return chromium.launch({ executablePath: process.env.CUEFLOW_CHROMIUM || undefined, args: [`--lang=${lang}`] }).catch((e: Error) => {
    throw new Error(
      `could not start Chromium (${e.message.split("\n")[0]}): run "npx playwright install chromium", or set CUEFLOW_CHROMIUM to the path of a Chromium or Chrome executable`
    );
  });
}

export async function openPreview(htmlFile: string, opts: { lang?: string } = {}): Promise<PreviewSession> {
  const lang = opts.lang ?? (await pageLang(htmlFile));
  const browser = await launchChromium(lang);
  try {
    const page = await browser.newPage({ viewport: { width: 760, height: 520 }, deviceScaleFactor: 2, locale: lang });
    await page.goto(pathToFileURL(htmlFile).href);
    await page.waitForFunction(() => (window as unknown as { __cueflow?: unknown }).__cueflow !== undefined);
    const steps = await page.evaluate(`${PLAYER}.steps()`) as string[];
    let posterStyle = false;
    return {
      steps,
      async seek(step, at) {
        if (!Number.isInteger(step) || step < 0 || step >= steps.length) throw new Error(`the guide has ${steps.length} steps (0 to ${steps.length - 1}): step ${step} does not exist`);
        const r = await page.evaluate(`${PLAYER}.seek(${step}, ${JSON.stringify(at)}, ${JSON.stringify(opts.lang ?? "")} || undefined)`) as { total: number; narration: number };
        return { total: r.total, narration: r.narration };
      },
      async frame(only = "player") {
        if (only === "stage" && !posterStyle) {
          await page.addStyleTag({ content: ".cf-cursor, .cf-ring, .cf-brand, .cf-big { visibility: hidden !important; }" });
          posterStyle = true;
        }
        await page.waitForTimeout(600); // seek applies everything without transitions, but fonts and layout need a beat
        return await page.locator(only === "stage" ? ".cf-stage" : ".cf-app").screenshot();
      },
      probe: async (selector) => (await page.evaluate(`${PLAYER}.probe(${JSON.stringify(selector)})`)) as Probe,
      async sheet(frames, columns = 3) {
        const sheet = await browser.newPage({ viewport: { width: 1600, height: 900 } });
        const esc = (s: string) => s.replace(/[&<>]/g, (c) => `&#${c.charCodeAt(0)};`);
        const cells = frames.map((f) => `<figure><img src="data:image/png;base64,${f.png.toString("base64")}"><figcaption>${esc(f.caption)}</figcaption></figure>`).join("");
        await sheet.setContent(
          "<style>body{margin:0;padding:16px;background:#e9e9ec;font:600 14px system-ui,sans-serif;color:#222}" +
            `main{display:grid;grid-template-columns:repeat(${columns},1fr);gap:16px}figure{margin:0}img{width:100%;display:block;border-radius:4px}figcaption{padding:6px 2px 0}</style><main>${cells}</main>`
        );
        await sheet.waitForFunction(() => [...document.images].every((i) => i.complete));
        const png = await sheet.screenshot({ fullPage: true });
        await sheet.close();
        return png;
      },
      close: () => browser.close()
    };
  } catch (e) {
    await browser.close();
    throw e;
  }
}

/** One frame of a built guide as a PNG: the model (or a human) checks the framing without playing the whole thing. */
export async function renderFrame(htmlFile: string, opts: { step: number; at?: At; lang?: string; only?: "player" | "stage" }): Promise<Buffer> {
  const session = await openPreview(htmlFile, { lang: opts.lang });
  try {
    await session.seek(opts.step, opts.at ?? 0);
    return await session.frame(opts.only);
  } finally {
    await session.close();
  }
}
