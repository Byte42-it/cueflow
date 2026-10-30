import assert from "node:assert/strict";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { buildGuide } from "../src/build.ts";
import { openKit, saveGuide, type Kit } from "../src/kit.ts";
import { launchChromium } from "../src/preview.ts";
import { Guide } from "../src/schema.ts";

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
        }
      ]
    })
  );
});
after(() => rm(dir, { recursive: true, force: true }));

describe("motion", () => {
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

      await seek(650); // the file row starting up, four menu entries in, the fifth not yet
      const first = await stage.screenshot();
      await seek(4200);
      await seek(650);
      assert.ok(Buffer.compare(first, await stage.screenshot()) === 0, "the same time gives the same picture, whatever was shown before");
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
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  });
});
