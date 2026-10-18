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


it("shows a silent opening still and supports scene editing, deletion, undo and leaving Edit", { skip: !process.env.CUEFLOW_TEST_BROWSER, timeout: 30000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cueflow-silent-intro-"));
  let studio: Awaited<ReturnType<typeof startStudio>> | undefined;
  let browser: Awaited<ReturnType<typeof launchChromium>> | undefined;
  try {
    await mkdir(path.join(root, "guides"));
    await mkdir(path.join(root, "scenes"));
    await writeFile(path.join(root, "cueflow.json"), JSON.stringify({ voices: { default: { provider: "none" } } }));
    await writeFile(path.join(root, "scenes", "intro.html"), '<main id="frame" style="width:1280px;height:720px;background:#c2f542"><h1>Opening still</h1></main>');
    await writeFile(path.join(root, "guides", "short.json"), JSON.stringify({
      id: "short", title: "Silent opening", scene: "intro", stage: { width: 960, height: 540 }, languages: ["en"],
      player: { captions: "below" },
      steps: [{ id: "intro", narration: { en: "" }, voice: { en: { provider: "none" } }, hold: 2500, camera: { target: "#frame", padding: 0 }, actions: [] },
        { id: "next", narration: { en: "The next scene has narration." }, actions: [] }]
    }));
    studio = await startStudio(openKit(root), { port: 4791, open: false });
    browser = await launchChromium("en");
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    page.setDefaultTimeout(10000);
    const browserErrors: string[] = [];
    page.on("pageerror", (error) => browserErrors.push(error.message));
    await page.goto(studio.url);
    const preview = page.frameLocator("#view");
    await preview.frameLocator(".cf-frame").getByText("Opening still").waitFor();
    const stage = await preview.locator(".cf-stage").boundingBox();
    assert.ok(stage && stage.width >= 600, `Opening stage should fill the preview, got ${JSON.stringify(stage)}`);
    assert.ok(Math.abs(stage.width / stage.height - 16 / 9) < 0.01);
    assert.equal(await preview.locator(".cf-caption").textContent(), "");
    assert.equal(await preview.locator(".cf-stage").evaluate((stage) => getComputedStyle(stage, "::after").display), "none");
    const state = await page.locator("#view").evaluate((iframe) => ((iframe as HTMLIFrameElement).contentWindow as any).__cueflow.state());
    assert.equal(state.step, 0);
    assert.equal(state.t, 0);
    assert.equal(state.playing, false);
    const guide = async () => (await (await page.request.get(studio!.url + "api/guide/short")).json()).guide;
    const originalCamera = (await guide()).steps[0].camera;
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await page.frameLocator("#view").getByText("Opening still").click();
    assert.equal(await page.getByRole("button", { name: "Copy selector", exact: true }).count(), 0);
    assert.deepEqual((await guide()).steps[0].camera, originalCamera);
    assert.equal(await page.getByRole("button", { name: /Set camera/ }).count(), 0);
    await page.getByRole("textbox", { name: "Element text", exact: true }).fill("Changed opening");
    await page.getByRole("button", { name: "Save element", exact: true }).click();
    await page.frameLocator("#view").getByText("Changed opening", { exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>("#undo")!.disabled);
    assert.deepEqual((await guide()).steps[0].camera, originalCamera);
    await page.locator("#undo").click();
    await page.frameLocator("#view").getByText("Opening still", { exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>("#redo")!.disabled);
    await page.locator("#redo").click();
    await page.frameLocator("#view").getByText("Changed opening", { exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>("#undo")!.disabled);
    await page.frameLocator("#view").getByText("Changed opening", { exact: true }).click();
    await page.getByRole("button", { name: "Delete element", exact: true }).click();
    await page.waitForFunction(async () => !(await (await fetch("/scene/intro?lang=en")).text()).includes("Changed opening"));
    await page.getByText("Element deleted. Undo can restore it.", { exact: true }).waitFor();
    await page.locator("#undo").click();
    await page.frameLocator("#view").getByText("Changed opening", { exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>("#redo")!.disabled);
    await page.frameLocator("#view").getByText("Changed opening", { exact: true }).click();
    await page.getByRole("button", { name: "Video", exact: true }).click();
    assert.equal(await page.locator("#pickinfo").isVisible(), false);
    assert.equal(await page.locator("#pickinfo").textContent(), "");
    assert.equal(await page.getByRole("textbox", { name: "Element text", exact: true }).count(), 0);
    await page.reload();
    await page.frameLocator("#view").frameLocator(".cf-frame").getByText("Changed opening", { exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>("#redo")!.disabled);
    await page.locator("body").click({ position: { x: 3, y: 3 } });
    const [undoResponse] = await Promise.all([
      page.waitForResponse((response) => response.url().endsWith("/api/history") && response.request().method() === "POST"),
      page.keyboard.press("Control+z")
    ]);
    assert.equal(undoResponse.status(), 200);
    const previewAfterUndo = page.frameLocator("#view").frameLocator(".cf-frame");
    await previewAfterUndo.getByText("Opening still", { exact: true }).waitFor();
    assert.deepEqual((await guide()).steps[0].camera, originalCamera);
    assert.deepEqual(browserErrors, []);

  } finally {
    await browser?.close();
    studio?.close();
    await rm(root, { recursive: true, force: true });
  }
});
