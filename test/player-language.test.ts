import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";
import { openKit } from "../src/kit.ts";
import { launchChromium } from "../src/preview.ts";
import { startStudio } from "../src/studio.ts";

it("switches scenes and captions in the timeline, working preview and final preview", { skip: !process.env.CUEFLOW_TEST_BROWSER, timeout: 90000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cueflow-language-"));
  let studio: Awaited<ReturnType<typeof startStudio>> | undefined;
  let browser: Awaited<ReturnType<typeof launchChromium>> | undefined;
  try {
    await mkdir(path.join(root, "guides"));
    await mkdir(path.join(root, "scenes", "en"), { recursive: true });
    await writeFile(path.join(root, "scenes", "screen.html"), '<h1 id="heading">Schermata italiana</h1>');
    await writeFile(path.join(root, "scenes", "en", "screen.html"), '<h1 id="heading">English screen</h1>');
    await writeFile(path.join(root, "cueflow.json"), JSON.stringify({ voices: { default: { provider: "none" } } }));
    await writeFile(path.join(root, "guides", "short.json"), JSON.stringify({ id: "short", title: "Languages", scene: "screen", languages: ["it", "en"], steps: [{ id: "first", narration: { it: "Narrazione italiana", en: "English narration" }, actions: [] }] }));
    studio = await startStudio(openKit(root), { port: 4790, open: false });
    browser = await launchChromium("en");
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(studio.url);
    await page.locator("#lang").selectOption("en");
    await page.frameLocator("#view").frameLocator(".cf-frame").getByText("English screen").waitFor();
    await page.frameLocator("#view").locator(".cf-caption").getByText("English narration", { exact: true }).waitFor();
    await page.locator('[data-page="preview"]').click();
    await page.frameLocator("#prev-view").frameLocator(".cf-frame").getByText("English screen").waitFor();
    await page.locator("#lang").selectOption("it");
    await page.frameLocator("#prev-view").frameLocator(".cf-frame").getByText("Schermata italiana").waitFor();
    await page.getByRole("button", { name: "With the final voices", exact: true }).click();
    await page.waitForFunction(() => document.querySelector<HTMLIFrameElement>("#prev-view")?.src.includes("/out/"));
    await page.frameLocator("#prev-view").frameLocator(".cf-frame").getByText("Schermata italiana").waitFor();
    await page.locator("#lang").selectOption("en");
    await page.frameLocator("#prev-view").frameLocator(".cf-frame").getByText("English screen").waitFor();
    assert.ok((await page.locator("#prev-view").getAttribute("src"))?.includes("/out/short.html?lang=en"));
    await page.goto(studio.url + "out/short.html?lang=unknown");
    await page.frameLocator(".cf-frame").getByText("Schermata italiana").waitFor();
    await page.locator(".cf-lang").selectOption("en");
    await page.frameLocator(".cf-frame").getByText("English screen").waitFor();
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    studio?.close();
    await rm(root, { recursive: true, force: true });
  }
});
