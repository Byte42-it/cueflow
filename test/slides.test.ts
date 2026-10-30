import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { buildGuide, guideBundle } from "../src/build.ts";
import { loadGuide, openKit, type Kit } from "../src/kit.ts";
import { buildSlidesPdf } from "../src/pdf.ts";
import { launchChromium } from "../src/preview.ts";
import { Guide } from "../src/schema.ts";
import { buildSite, siteDir } from "../src/site.ts";
import { validateGuide } from "../src/validate.ts";

let dir: string;
let kit: Kit;

/* two slides: the first opens with its title, then two presses (a group of two actions, then one); the second has notes */
const deck = {
  id: "deck",
  title: "Deck",
  scene: "slide",
  format: "slides",
  languages: ["it", "en"],
  steps: [
    {
      id: "one",
      title: { it: "Uno", en: "One" },
      actions: [
        { do: "set", to: "#title", text: { it: "Titolo", en: "Title" }, at: 0 },
        { do: "show", to: "#a", at: "30%" },
        { do: "highlight", to: "#a", at: "30%", duration: 400 },
        { do: "show", to: "#b", at: "60%" }
      ]
    },
    { id: "two", title: { it: "Due", en: "Two" }, actions: [{ do: "show", to: "#c", at: 1000 }], narration: { it: "Le note del relatore.", en: "The speaker's notes." } }
  ]
};

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "cueflow-slides-"));
  await mkdir(path.join(dir, "guides"));
  await mkdir(path.join(dir, "scenes"));
  await writeFile(
    path.join(dir, "scenes", "slide.html"),
    '<!doctype html><html><body><h1 id="title">…</h1><p id="a" hidden>A</p><p id="b" hidden>B</p><p id="c" hidden>C</p></body></html>'
  );
  // a voice is configured on purpose: slides must stay silent all the same
  await writeFile(path.join(dir, "cueflow.json"), JSON.stringify({ voices: { default: { provider: "browser" } } }));
  await writeFile(path.join(dir, "guides", "deck.json"), JSON.stringify(deck));
  await writeFile(
    path.join(dir, "site.json"),
    JSON.stringify({ title: "Docs", lang: "it", languages: ["it", "en"], rows: [{ id: "r", title: "R" }], items: [{ id: "deck", row: "r", status: "video", guide: "deck", title: "Deck" }] })
  );
  kit = openKit(dir);
});
after(() => rm(dir, { recursive: true, force: true }));

describe("slides", () => {
  it("is a video unless asked otherwise", () => {
    assert.equal(Guide.parse({ id: "g", title: "G", scene: "s" }).format, "video");
    assert.equal(Guide.parse({ ...deck }).format, "slides");
  });

  it("asks for no narration: in slides it is optional speaker's notes", async () => {
    const report = await validateGuide(kit, await loadGuide(kit, "deck"));
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.warnings.filter((w) => /narration|sentences|lasts about/.test(w)), []);
  });

  it("builds without any audio, whatever voice the project has", async () => {
    const bundle = await guideBundle(kit, "deck");
    assert.deepEqual(bundle.data.audio, {});
    assert.equal(bundle.audioFiles, 0);
    assert.notEqual(bundle.guide.player.fallbackVoice, "browser");
  });

  it("is listed as a presentation with its number of slides", async () => {
    await buildSite(kit, {});
    const html = await readFile(path.join(siteDir(kit), "index.html"), "utf8");
    const catalog = JSON.parse(/window\.CUEFLOW_SITE = (.*);<\/script>/.exec(html)![1]!).catalog;
    assert.equal(catalog.items[0].format, "slides");
    assert.deepEqual(catalog.items[0].duration, { it: "2 slide", en: "2 slides" });
  });

  it("exports a PDF of one page per slide, complete, and refuses a video", { skip: !process.env.CUEFLOW_TEST_BROWSER, timeout: 60000 }, async () => {
    const r = await buildSlidesPdf(kit, "deck", "it");
    const pdf = await readFile(r.file);
    assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
    assert.equal(r.pages, 2);
    assert.equal(pdf.toString("latin1").match(/\/Type\s*\/Page\b/g)?.length, 2, "one page per slide, not one per press");
    await writeFile(path.join(dir, "guides", "film.json"), JSON.stringify({ ...deck, id: "film", format: "video" }));
    await assert.rejects(buildSlidesPdf(kit, "film", "it"), /is a video, not slides/);
  });

  it("advances one press at a time, in the page and in full screen", { skip: !process.env.CUEFLOW_TEST_BROWSER, timeout: 60000 }, async () => {
    const built = await buildGuide(kit, "deck");
    const browser = await launchChromium("it");
    try {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(pathToFileURL(built.file).href + "?lang=it");
      const scene = page.frameLocator(".cf-frame");
      const visible = (id: string) => scene.locator(id).isVisible();
      await page.locator(".cf-veil-text strong").getByText("Avvia la presentazione").waitFor();
      assert.equal(await page.locator(".cf-sl-count").textContent(), "1 / 2");
      assert.equal(await scene.locator("#title").textContent(), "Titolo", "the actions at 0 come with the slide");
      assert.equal(await visible("#a"), false);

      await page.locator(".cf-app").focus();
      await page.keyboard.press("Space"); // starts the presentation (full screen where the browser allows it)
      await page.keyboard.press("Space"); // first group: #a with its highlight
      await scene.locator("#a").waitFor();
      assert.equal(await visible("#b"), false, "one group per press");
      await page.keyboard.press("Space"); // a press while the group plays completes it
      await page.keyboard.press("Space"); // second group
      await scene.locator("#b").waitFor();
      assert.equal(await page.locator(".cf-sl-count").textContent(), "1 / 2", "still on the first slide");
      await page.waitForTimeout(600); // #b fades in (show, 300 ms): a press meanwhile would complete it, not change slide
      await page.keyboard.press("Space");
      await page.locator(".cf-sl-count").getByText("2 / 2").waitFor();
      assert.equal(await visible("#c"), false, "an action at 1000 ms waits for its press");

      // speaker's notes, on demand
      assert.equal(await page.locator(".cf-sl-notes").isVisible(), false);
      await page.keyboard.press("n");
      await page.locator(".cf-sl-notes").getByText("Le note del relatore.").waitFor();

      // back: the previous slide complete, as it was left
      await page.keyboard.press("ArrowLeft");
      await page.locator(".cf-sl-count").getByText("1 / 2").waitFor();
      assert.equal(await visible("#b"), true);

      // the buttons of the bar browse in the page
      if (await page.evaluate(() => !!document.fullscreenElement)) await page.evaluate(() => document.exitFullscreen());
      await page.locator(".cf-sl-next").click();
      await page.locator(".cf-sl-count").getByText("2 / 2").waitFor();
      await page.locator(".cf-sl-next").click();
      await scene.locator("#c").waitFor();
      await page.waitForTimeout(600); // let its fade end: a press meanwhile completes the group instead of ending the deck
      await page.locator(".cf-sl-next").click();
      await page.locator(".cf-veil-text strong").getByText("Fine della presentazione").waitFor();
      assert.equal(await page.locator(".cf-sl-next").isDisabled(), true);
      assert.equal(await page.locator(".cf-play").isVisible(), false, "no play button: slides are advanced by hand");
      assert.equal(await page.locator(".cf-caption").isVisible(), false, "no captions");
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  });
});
