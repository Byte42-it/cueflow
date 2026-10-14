import assert from "node:assert/strict";
import { appendFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { buildGuide } from "../src/build.ts";
import { loadGuide, openKit, saveGuide, type Kit } from "../src/kit.ts";
import { describeScene } from "../src/scene.ts";
import { Guide } from "../src/schema.ts";
import { spokenText } from "../src/tts.ts";
import { validateGuide } from "../src/validate.ts";

let dir: string;
let kit: Kit;

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "cueflow-"));
  await cp(path.join(import.meta.dirname, "..", "examples", "demo-kit"), dir, { recursive: true, filter: (s) => !/[\\/](dist|audio)([\\/]|$)/.test(s) });
  kit = openKit(dir);
});
after(() => rm(dir, { recursive: true, force: true }));

describe("validation", () => {
  it("accepts the demo guide", async () => {
    const report = await validateGuide(kit, await loadGuide(kit, "upload"));
    assert.deepEqual(report.errors, []);
  });

  it("rejects a selector that matches nothing, like an illegal move", async () => {
    const guide = await loadGuide(kit, "upload");
    guide.steps[0]!.actions.push({ do: "click", to: "#does-not-exist", at: 0 });
    const report = await validateGuide(kit, guide);
    assert.equal(report.errors.length, 1);
    assert.match(report.errors[0]!, /#does-not-exist.*matches nothing/);
  });

  it("rejects duplicate step ids and unknown scenes", async () => {
    const guide = await loadGuide(kit, "upload");
    guide.steps.push({ ...guide.steps[0]!, scene: "nowhere" });
    const report = await validateGuide(kit, guide);
    assert.ok(report.errors.some((e) => /duplicate step id/.test(e)));
    assert.ok(report.errors.some((e) => /scene "nowhere" does not exist/.test(e)));
  });

  it("warns about a missing narration language", async () => {
    const guide = await loadGuide(kit, "upload");
    guide.languages.push("fr");
    const report = await validateGuide(kit, guide);
    assert.ok(report.warnings.some((w) => /no narration in "fr"/.test(w)));
  });
});

describe("schema", () => {
  it("applies defaults and rejects unknown actions", () => {
    const g = Guide.parse({ id: "g", title: "G", scene: "upload", steps: [{ id: "a" }] });
    assert.deepEqual(g.stage, { width: 640, height: 360 });
    assert.equal(g.steps[0]!.hold, 600);
    assert.throws(() => Guide.parse({ id: "g", title: "G", scene: "s", steps: [{ id: "a", actions: [{ do: "teleport", to: "#x" }] }] }));
  });

  it("gives old guides the default player and no pronunciation", () => {
    const g = Guide.parse({ id: "g", title: "G", scene: "upload" });
    assert.deepEqual(g.player, { captions: "below", chapters: true, speeds: [1, 1.5], transcript: true, fallbackVoice: "none" });
    assert.deepEqual(g.pronunciation, {});
    assert.throws(() => Guide.parse({ id: "g", title: "G", scene: "s", player: { captions: "sideways" } }));
    assert.throws(() => Guide.parse({ id: "g", title: "G", scene: "s", player: { speeds: [] } }));
  });
});

describe("pronunciation", () => {
  it("replaces whole words only, leaving captions to the written form", () => {
    assert.equal(spokenText("Open SQL, not MySQL.", { SQL: "sequel" }), "Open sequel, not MySQL.");
    assert.equal(spokenText("Città e CittàNuova", { Città: "Chitta" }), "Chitta e CittàNuova");
    assert.equal(spokenText("a.b and axb", { "a.b": "A B" }), "A B and axb", "entries are literal, not patterns");
  });
});

describe("scene", () => {
  it("lists targetable elements with stable selectors", async () => {
    const els = describeScene(await readFile(path.join(dir, "scenes", "upload.html"), "utf8"));
    const upload = els.find((e) => e.selector === "#upload-btn");
    assert.equal(upload?.text, "Upload");
    assert.equal(els.find((e) => e.selector === "#file-row")?.hidden, true);
  });
});

describe("build", () => {
  it("produces one self-contained html file, silent without a TTS provider", async () => {
    const r = await buildGuide(kit, "upload", null);
    assert.equal(r.silent, true);
    const html = await readFile(r.file, "utf8");
    assert.ok(!/<link[^>]+stylesheet/.test(html), "stylesheets are inlined");
    assert.match(html, /Cueflow\.mount/);
    assert.match(html, /How to upload a document/);
  });

  it("refuses to build an invalid guide", async () => {
    const guide = await loadGuide(kit, "upload");
    guide.id = "broken";
    guide.steps[0]!.camera = { target: "#nope" };
    await saveGuide(kit, guide);
    await assert.rejects(buildGuide(kit, "broken", null), /not valid/);
  });

  it("adds the kit theme after the player's styles and passes its labels to the player", async () => {
    const themed = openKit(await mkdtemp(path.join(tmpdir(), "cueflow-theme-")));
    try {
      await cp(dir, themed.root, { recursive: true });
      await cp(path.join(import.meta.dirname, "..", "examples", "themes", "paper"), path.join(themed.root, "theme"), { recursive: true });
      await writeFile(path.join(themed.root, "theme", "mark.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
      await appendFile(path.join(themed.root, "theme", "theme.css"), '\n.cf-big { background-image: url("mark.svg"); }\n');
      const html = await readFile((await buildGuide(themed, "upload", null)).file, "utf8");
      const player = html.indexOf("--cf-bg: #0f1115"), theme = html.indexOf("--cf-bg: #f6f5f1");
      assert.ok(player > 0 && theme > player, "the theme comes after the defaults, so it wins");
      assert.match(html, /url\("data:image\/svg\+xml;base64,/, "files the theme points at are inlined");
      assert.match(html, /"labels":\{"en":\{"steps":"Chapters"/);
    } finally {
      await rm(themed.root, { recursive: true, force: true });
    }
  });

  it("rejects a misspelt label instead of ignoring it", async () => {
    const themed = openKit(await mkdtemp(path.join(tmpdir(), "cueflow-theme-")));
    try {
      await cp(dir, themed.root, { recursive: true });
      await mkdir(path.join(themed.root, "theme"));
      await writeFile(path.join(themed.root, "theme", "labels.json"), JSON.stringify({ en: { transcipt: "Text" } }));
      await assert.rejects(buildGuide(themed, "upload", null), /labels\.json is not valid/);
    } finally {
      await rm(themed.root, { recursive: true, force: true });
    }
  });

  it("builds with the player's own look when the kit has no theme", async () => {
    const html = await readFile((await buildGuide(kit, "upload", null)).file, "utf8");
    assert.ok(!html.includes("/* kit theme */"));
    assert.match(html, /"labels":\{\}/);
  });

  it("keeps scene text from breaking out of the embedding script", async () => {
    const guide = await loadGuide(kit, "upload");
    guide.id = "tricky";
    guide.steps[0]!.narration.en = "</script><b>boom</b>";
    await saveGuide(kit, guide);
    const html = await readFile((await buildGuide(kit, "tricky", null)).file, "utf8");
    assert.ok(!html.includes("</script><b>boom"));
  });
});
