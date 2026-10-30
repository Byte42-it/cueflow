import assert from "node:assert/strict";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { buildGuide, renderGuideHtml, writeAtomic } from "../src/build.ts";
import { loadGuide, openKit, saveGuide, type Kit } from "../src/kit.ts";
import { launchChromium } from "../src/preview.ts";
import { Guide } from "../src/schema.ts";
import { validateGuide } from "../src/validate.ts";
import { loadTheme } from "../src/theme.ts";
import { setAvatar, stepAvatar } from "../src/avatars.ts";
import { resolveAvatar } from "../src/avatar.ts";
import { mkdir, writeFile } from "node:fs/promises";

/* The motion engine: every effect runs on the step clock, so a seek is exact and repeatable, and a pause stops everything. */
let dir: string;
let kit: Kit;

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "cueflow-motion-"));
  await cp(path.join(import.meta.dirname, "..", "examples", "demo-kit"), dir, { recursive: true, filter: (s) => !/[\\/](dist|audio)([\\/]|$)/.test(s) });
  kit = openKit(dir);
  await saveGuide(
    kit,
    Guide.parse({
      id: "motion",
      title: "Motion",
      scene: "upload",
      languages: ["en"],
      steps: [
        {
          id: "build",
          camera: { target: "#upload-card", padding: 40 },
          actions: [
            { do: "hide", to: "#sidebar a", at: 0, effect: "none", stagger: 0 },
            { do: "show", to: "#sidebar a", at: 200, effect: "slide-right", duration: 400, stagger: 120 },
            { do: "show", to: "#file-row", at: 600, effect: "slide-up", duration: 400 },
            { do: "move", to: "#upload-btn", at: 1200, duration: 800, easing: "spring" },
            { do: "set", to: "#upload-btn", at: 2000, remove: ["disabled"], animate: 300 },
            { do: "count", to: ".size", at: 2200, end: 48.5, duration: 1000, format: { suffix: " MB" } },
            { do: "camera", target: "#sidebar", padding: 30, at: 3400, duration: 700 }
          ],
          narration: { en: "A panel builds piece by piece, the size counts, then the camera moves to the menu." }
        },
        {
          id: "place",
          camera: { target: "#sidebar", padding: 30 },
          actions: [
            { do: "reorder", to: "#nav-documents", into: "#sidebar", index: 1, at: 300, duration: 500 },
            { do: "drag", to: "#nav-documents", after: "#sidebar a:last-child", at: 1200, duration: 1200 },
            { do: "hover", to: "#choose-file", at: 2600, duration: 700 },
            { do: "highlight", to: "#upload-btn", at: 2600, duration: 1500, style: "spotlight" }
          ],
          narration: { en: "Documents goes first, then it is dragged to the bottom." }
        }
      ]
    })
  );
});
after(() => rm(dir, { recursive: true, force: true }));

describe("narrator", () => {
  it("is chosen at three levels, step over video over project over the defaults, and is off unless asked", async () => {
    assert.deepEqual(Guide.parse({ id: "g", title: "G", scene: "s" }).player.avatar, {});
    assert.equal(resolveAvatar().provider, "none");
    const r = resolveAvatar({ provider: "svg", background: "#000" }, { size: 0.4 }, { mode: "full", background: undefined });
    assert.deepEqual([r.provider, r.size, r.mode, r.background, r.position], ["svg", 0.4, "full", "#000", "bottom-right"]);
    // set at every level, through the same door the assistant and Studio use
    const lv = await mkdtemp(path.join(tmpdir(), "cueflow-avatar-levels-"));
    await cp(path.join(import.meta.dirname, "..", "examples", "demo-kit"), lv, { recursive: true, filter: (s) => !/[\\/](dist|audio)([\\/]|$)/.test(s) });
    const k = openKit(lv);
    await setAvatar(k, { scope: "global" }, { provider: "svg", background: "#123456" });
    await setAvatar(k, { scope: "video", guide: "upload" }, { size: 0.35 });
    await setAvatar(k, { scope: "step", guide: "upload", step: "intro" }, { mode: "off" });
    const kk = openKit(lv);
    assert.deepEqual(kk.settings.avatar, { provider: "svg", background: "#123456" });
    const g = await loadGuide(kk, "upload");
    assert.deepEqual(g.player.avatar, { size: 0.35 });
    assert.deepEqual(stepAvatar(kk, g, g.steps[0]!), { ...resolveAvatar(), provider: "svg", background: "#123456", size: 0.35, mode: "off" });
    assert.equal(stepAvatar(kk, g, g.steps[1]!).mode, "pip");
    await setAvatar(kk, { scope: "step", guide: "upload", step: "intro" }, null);
    assert.equal((await loadGuide(kk, "upload")).steps[0]!.avatar, undefined);
    // a picture must exist in the kit
    await setAvatar(kk, { scope: "video", guide: "upload" }, { provider: "image", image: "shared/avatar/nobody.png" });
    const report = await validateGuide(openKit(lv), await loadGuide(openKit(lv), "upload"));
    assert.match(report.errors.join("\n"), /player.avatar: the picture "shared\/avatar\/nobody.png" does not exist in the kit/);
    await rm(lv, { recursive: true, force: true });
    const own = await mkdtemp(path.join(tmpdir(), "cueflow-avatar-"));
    await mkdir(path.join(own, "theme"));
    await writeFile(path.join(own, "theme", "avatar.svg"), '<svg viewBox="0 0 10 10"><g id="head"><g id="eye-l"/><g id="eye-r"/><path id="mouth-closed"/></g></svg>');
    await assert.rejects(loadTheme(openKit(own)), /theme\/avatar\.svg: no element with id "mouth-mid", "mouth-open"/);
    await writeFile(path.join(own, "theme", "avatar.svg"), '<svg viewBox="0 0 10 10"><g id="head"><g id="eye-l"/><g id="eye-r"/><path id="mouth-closed"/><path id="mouth-mid"/><path id="mouth-open"/></g></svg>');
    assert.match((await loadTheme(openKit(own))).avatar ?? "", /^<svg/);
    await rm(own, { recursive: true, force: true });
  });

  it("blinks on the step clock and closes its mouth when paused", { skip: !process.env.CUEFLOW_TEST_BROWSER, timeout: 90000 }, async () => {
    const own = await mkdtemp(path.join(tmpdir(), "cueflow-showcase-"));
    await cp(path.join(import.meta.dirname, "..", "examples", "motion-kit"), own, { recursive: true, filter: (s) => !/[\\/]dist([\\/]|$)/.test(s) });
    const showcase = openKit(own);
    await setAvatar(showcase, { scope: "step", guide: "dashboard", step: "figures" }, { mode: "side", position: "left", size: 0.35 });
    await setAvatar(showcase, { scope: "step", guide: "dashboard", step: "trend" }, { mode: "off" });
    // silent build read by the browser's voice (Studio's preview): without any voice the narrator would stay silent too
    const { html } = await renderGuideHtml(showcase, "dashboard", null, { browserVoice: true });
    const file = path.join(own, "dist", "dashboard.html");
    await writeAtomic(file, html);
    const browser = await launchChromium("en");
    try {
      const page = await browser.newPage({ viewport: { width: 760, height: 520 } });
      await page.goto(pathToFileURL(file).href);
      await page.waitForFunction(() => (window as unknown as { __cueflow?: unknown }).__cueflow);
      const seek = (t: number) => page.evaluate((t) => (window as unknown as { __cueflow: { seek(i: number, t: number): Promise<unknown> } }).__cueflow.seek(1, t), t);
      assert.equal(await page.locator(".cf-avatar").isVisible(), true);
      assert.ok(await page.locator(".cf-avatar").evaluate((el) => el.classList.contains("cf-av-pip") && el.classList.contains("cf-av-bottom-right")));
      // step 2 keeps the project's face but moves it: a half-bust panel on the left (set below, before the build)
      await seek(100);
      const cls = await page.locator(".cf-avatar").evaluate((el) => [el.className, (el as HTMLElement).style.width]);
      assert.ok(cls[0].includes("cf-av-side") && cls[0].includes("cf-av-left"), cls[0]);
      assert.equal(cls[1], "35%");
      await page.evaluate(() => (window as unknown as { __cueflow: { seek(i: number, t: number): Promise<unknown> } }).__cueflow.seek(2, 100));
      assert.equal(await page.locator(".cf-avatar").isVisible(), false, "step 3 hides it");
      await page.evaluate(() => (window as unknown as { __cueflow: { seek(i: number, t: number): Promise<unknown> } }).__cueflow.seek(1, 100));
      // the first blink of a step is at 400 + noise(0) * 2800 ms: the same noise as the player's
      const noise = (n: number) => { const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453; return x - Math.floor(x); };
      const blink = Math.round(400 + noise(0) * 2800);
      await seek(blink);
      const eye = () => page.locator("#eye-l").evaluate((el) => (el as HTMLElement).style.transform);
      assert.match(await eye(), /scaleY\(0\.0/, "eyes shut at the blink's middle");
      const shut = await page.locator(".cf-avatar").screenshot();
      await seek(blink + 800);
      assert.equal(await eye(), "scaleY(1)");
      await seek(blink);
      assert.ok(Buffer.compare(shut, await page.locator(".cf-avatar").screenshot()) === 0, "the same time, the same face");
      const mouth = () => page.evaluate(() => ["mouth-closed", "mouth-mid", "mouth-open"].filter((id) => document.getElementById(id)!.style.display !== "none").join());
      assert.equal(await mouth(), "mouth-closed", "silent at a seek");
      await page.locator(".cf-play").click(); // from the seek on: the bar's play
      await page.waitForTimeout(1200);
      const seen = new Set<string>();
      for (let i = 0; i < 20; i++) { seen.add(await mouth()); await page.waitForTimeout(50); }
      assert.ok(seen.size >= 2, `the mouth moves while the narration runs: ${[...seen].join(" ")}`);
      await page.locator(".cf-play").click();
      await page.waitForTimeout(100);
      assert.equal(await mouth(), "mouth-closed", "paused: closed");
    } finally {
      await browser.close();
      await rm(own, { recursive: true, force: true });
    }
  });
});

describe("motion", () => {
  it("the showcase kit (examples/motion-kit) uses the whole vocabulary and validates clean", async () => {
    const showcase = openKit(path.join(import.meta.dirname, "..", "examples", "motion-kit"));
    const guide = await loadGuide(showcase, "dashboard");
    const used = new Set<string>(guide.steps.flatMap((s) => s.actions.map((a) => a.do)));
    for (const action of ["show", "hide", "count", "highlight", "grow", "draw", "check", "set", "reorder", "drag"]) assert.ok(used.has(action), action);
    const report = await validateGuide(showcase, guide);
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.warnings, []);
  });

  it("seeks to the same frame twice, counts, and keeps the camera still while paused", { skip: !process.env.CUEFLOW_TEST_BROWSER, timeout: 90000 }, async () => {
    const built = await buildGuide(kit, "motion", null);
    const browser = await launchChromium("en");
    try {
      const page = await browser.newPage({ viewport: { width: 760, height: 520 } });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(pathToFileURL(built.file).href);
      await page.waitForFunction(() => (window as unknown as { __cueflow?: unknown }).__cueflow);
      const seek = (t: number) => page.evaluate((t) => (window as unknown as { __cueflow: { seek(i: number, t: number): Promise<unknown> } }).__cueflow.seek(0, t), t);
      const stage = page.locator(".cf-stage");
      const scene = page.frameLocator(".cf-frame");

      const settled = async () => { await page.waitForTimeout(200); return stage.screenshot(); }; // past any fade of the controls, under load too
      await seek(650); // the file row starting up, four menu entries in, the fifth not yet
      const first = await settled();
      await seek(4200);
      await seek(650);
      assert.ok(Buffer.compare(first, await settled()) === 0, "the same time gives the same picture, whatever was shown before");
      assert.equal(await scene.locator("#sidebar a").nth(0).isVisible(), true);
      assert.equal(await scene.locator("#sidebar a").nth(4).evaluate((el) => getComputedStyle(el).opacity), "0", "the last entry of the stagger has not started");

      await seek(2700);
      assert.match(await scene.locator(".size").textContent() ?? "", /^\d+\.\d MB$/);
      await seek(4200);
      assert.equal(await scene.locator(".size").textContent(), "48.5 MB");
      assert.equal(await scene.locator("#upload-btn").evaluate((el) => el.classList.contains("disabled")), false);

      // live: pause in the middle of the camera move, the picture must not drift
      await seek(3500);
      await page.locator(".cf-play").click();
      await page.waitForTimeout(250);
      await page.locator(".cf-play").click();
      await page.waitForTimeout(50);
      const world = () => page.evaluate(() => (document.querySelector(".cf-world") as HTMLElement).style.transform);
      const t1 = await world();
      await page.waitForTimeout(400);
      assert.equal(await world(), t1, "a paused camera stays where it is");
      // step 2: an element that changes place slides there; a drag shows the element in flight at a seek too
      const seek2 = (t: number) => page.evaluate((t) => (window as unknown as { __cueflow: { seek(i: number, t: number): Promise<unknown> } }).__cueflow.seek(1, t), t);
      await seek2(550); // the reorder half way: Documents is first in the DOM but still sliding
      const links = () => scene.locator("#sidebar a").evaluateAll((els) => els.map((e) => [e.id, (e as HTMLElement).style.transform]));
      let l = await links();
      assert.equal(l[0]![0], "nav-documents");
      assert.notEqual(l[0]![1], "", "still on its way");
      await seek2(1800); // the drag in flight: last in the DOM, lifted, not yet there
      l = await links();
      assert.equal(l[l.length - 1]![0], "nav-documents");
      assert.match(l[l.length - 1]![1]!, /translate\(.*scale\(1\.03\)/);
      await seek2(2500);
      l = await links();
      assert.equal(l[l.length - 1]![0], "nav-documents");
      assert.equal(l[l.length - 1]![1], "", "dropped: no transform left behind");
      await seek2(3000);
      assert.equal(await scene.locator("#choose-file").evaluate((el) => el.classList.contains("cf-hover")), true);
      assert.equal(await page.locator(".cf-spot").evaluate((el) => (el as HTMLElement).style.opacity), "1");
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  });
});
