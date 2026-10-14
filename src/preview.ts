import { pathToFileURL } from "node:url";

/**
 * Renders one frame of a built guide as a PNG: the model (or a human) can look at the framing without playing
 * the whole thing. Needs the optional `playwright` package and a Chromium (`npx playwright install chromium`).
 */
export async function renderFrame(htmlFile: string, opts: { step: number; atMs: number; lang?: string }): Promise<Buffer> {
  let chromium: typeof import("playwright").chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    throw new Error("preview needs the optional dependency playwright: npm install playwright && npx playwright install chromium");
  }
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 760, height: 520 }, deviceScaleFactor: 2 });
    await page.goto(pathToFileURL(htmlFile).href);
    await page.waitForFunction(() => (window as unknown as { __cueflow?: unknown }).__cueflow !== undefined);
    const info = await page.evaluate(
      ([step, at, lang]) => (window as unknown as { __cueflow: { seek(s: number, t: number, l?: string): Promise<{ steps: number }> } }).__cueflow.seek(step as number, at as number, (lang as string) || undefined),
      [opts.step, opts.atMs, opts.lang ?? ""] as const
    );
    if (opts.step >= info.steps) throw new Error(`the guide has ${info.steps} steps, step ${opts.step} does not exist`);
    await page.waitForTimeout(900); // let the camera transition settle (seek applies it without one, but fonts/layout need a beat)
    return await page.locator(".cf-app").screenshot();
  } finally {
    await browser.close();
  }
}
