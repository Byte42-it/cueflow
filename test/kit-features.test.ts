import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { buildGuide, estimateDuration, guideBundle } from "../src/build.ts";
import { Capture } from "../src/capture.ts";
import { loadGuide, openKit, saveGuide, type Kit } from "../src/kit.ts";
import { bestFontSources, expandShared, inlineScene } from "../src/scene.ts";
import { Guide, Site } from "../src/schema.ts";
import { buildSite, siteFile, validateSite } from "../src/site.ts";
import { commandProvider, narrationAudio } from "../src/tts.ts";
import { validateGuide } from "../src/validate.ts";

let dir: string;
let kit: Kit;

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "cueflow-features-"));
  await cp(path.join(import.meta.dirname, "..", "examples", "demo-kit"), dir, { recursive: true, filter: (s) => !/[\\/](dist|audio)([\\/]|$)/.test(s) });
  kit = openKit(dir);
});
after(() => rm(dir, { recursive: true, force: true }));

describe("fonts", () => {
  it("keeps only the best local format of each face, also in minified CSS", async () => {
    const fonts = path.join(dir, "shared", "fonts");
    await mkdir(fonts, { recursive: true });
    for (const f of ["icons.woff2", "icons.woff", "icons.ttf"]) await writeFile(path.join(fonts, f), "x");
    const css =
      "@font-face{font-family:'Icons';src:url('fonts/icons.eot?v=1');src:url('fonts/icons.eot?#iefix') format('embedded-opentype'),url('fonts/icons.woff2?v=1') format('woff2'),url('fonts/icons.woff') format('woff');font-weight:normal}";
    const out = await bestFontSources(css, path.join(dir, "shared"));
    assert.equal(out, `@font-face{src: url("fonts/icons.woff2") format("woff2");font-family:'Icons';font-weight:normal}`);
  });

  it("falls back to the next format on disk, and leaves remote faces alone", async () => {
    const out = await bestFontSources("@font-face { font-family: A; src: url(fonts/missing.woff2) format('woff2'), url(fonts/icons.ttf); }", path.join(dir, "shared"));
    assert.match(out, /src: url\("fonts\/icons\.ttf"\) format\("truetype"\)/);
    const remote = "@font-face { src: url(https://cdn.example/a.woff2); }";
    assert.equal(await bestFontSources(remote, dir), remote);
  });
});

describe("shared parts of the scenes", () => {
  it("keeps each stylesheet and image once and puts it back when the scene loads", async () => {
    await writeFile(path.join(dir, "shared", "logo.png"), Buffer.from("89504e470d0a1a0a", "hex"));
    await writeFile(
      path.join(dir, "scenes", "second.html"),
      '<!doctype html><html><head><link rel="stylesheet" href="../shared/style.css"></head><body><img src="../shared/logo.png"><img src="../shared/logo.png"></body></html>'
    );
    const shared: Record<string, string> = {};
    const a = await inlineScene(kit, "upload", undefined, shared);
    const b = await inlineScene(kit, "second", undefined, shared);
    assert.match(a, /<style data-cf-style="[0-9a-f]{16}"><\/style>/);
    const sheets = Object.values(shared).filter((v) => !v.startsWith("data:"));
    assert.equal(sheets.length, 1, "the same stylesheet linked by two scenes is kept once");
    assert.equal(Object.values(shared).filter((v) => v.startsWith("data:image/png")).length, 1, "the same image twice is kept once");
    assert.equal((b.match(/cf-shared:/g) ?? []).length, 2);
    const full = expandShared(b, shared);
    assert.ok(!full.includes("cf-shared:") && full.includes("data:image/png;base64,") && full.includes(sheets[0]!.slice(0, 40)));
    // without the map the scene stays standalone, as before
    assert.ok(!(await inlineScene(kit, "upload")).includes("data-cf-style"));
  });

  it("ships the shared parts with the guide", async () => {
    const b = await guideBundle(kit, "upload", null);
    assert.ok(Object.keys(b.data.shared).length >= 1);
    assert.match(b.data.scenes.upload!, /data-cf-style=/);
  });
});

describe("form actions", () => {
  it("accepts select, value and check, and validates their targets and texts", async () => {
    const g = Guide.parse({
      id: "forms",
      title: "Forms",
      scene: "upload",
      languages: ["en", "it"],
      steps: [
        {
          id: "a",
          narration: { en: "x", it: "x" },
          actions: [
            { do: "value", to: "#doc-title", value: { en: "Contract" } },
            { do: "check", to: "#doc-title", checked: false },
            { do: "select", to: "#nowhere", option: "B" }
          ]
        }
      ]
    });
    assert.equal(g.steps[0]!.actions[1]!.do === "check" && g.steps[0]!.actions[1]!.checked, false);
    const report = await validateGuide(kit, g);
    assert.ok(report.errors.some((e) => /action 3 \(select\): "#nowhere" matches nothing/.test(e)));
    assert.ok(report.warnings.some((w) => /action 1 \(value\): no text in "it"/.test(w)));
  });
});

describe("duration", () => {
  it("estimates a guide like the silent player: narration or last action, plus the hold", async () => {
    const g = Guide.parse({
      id: "d",
      title: "D",
      scene: "upload",
      steps: [
        { id: "a", narration: { en: "x".repeat(100) } }, // 6500 ms + 600
        { id: "b", narration: { en: "short" }, actions: [{ do: "highlight", to: "#x", at: 2000, duration: 3000 }], hold: 0 } // 5000
      ]
    });
    assert.equal(estimateDuration(g), 6500 + 600 + 5000);
  });

  it("fills the catalog duration when site.json gives none", async () => {
    const site = JSON.parse(await readFile(siteFile(kit), "utf8"));
    delete site.items.find((i: { id: string }) => i.id === "upload").duration;
    await writeFile(siteFile(kit), JSON.stringify(site));
    const r = await buildSite(kit, { provider: null });
    const home = JSON.parse(/window\.CUEFLOW_SITE = (.*);<\/script>/.exec(await readFile(path.join(r.dir, "index.html"), "utf8"))![1]!);
    const upload = home.catalog.items.find((i: { id: string }) => i.id === "upload");
    assert.match(upload.duration.en, /^about \d+ s$/);
    assert.match(upload.duration.it, /^circa \d+ s$/);
  });
});

describe("site look", () => {
  it("marks the page with its color scheme, light by default", async () => {
    assert.equal(Site.parse({ title: "x" }).colorScheme, "light");
    const site = JSON.parse(await readFile(siteFile(kit), "utf8"));
    site.colorScheme = "auto";
    await writeFile(siteFile(kit), JSON.stringify(site));
    const r = await buildSite(kit, { provider: null });
    assert.match(await readFile(path.join(r.dir, "index.html"), "utf8"), /<html lang="en" data-cf-scheme="auto">/);
  });

  it("takes a png logo as an image, and refuses a logo that is not a picture", async () => {
    await writeFile(path.join(dir, "logo.png"), Buffer.from("89504e470d0a1a0a", "hex"));
    const site = JSON.parse(await readFile(siteFile(kit), "utf8"));
    site.brand.logo = "logo.png";
    await writeFile(siteFile(kit), JSON.stringify(site));
    const r = await buildSite(kit, { provider: null });
    const home = JSON.parse(/window\.CUEFLOW_SITE = (.*);<\/script>/.exec(await readFile(path.join(r.dir, "index.html"), "utf8"))![1]!);
    assert.match(home.catalog.brand.logo, /^<img src="data:image\/png;base64,/);
    await writeFile(path.join(dir, "logo.txt"), "x");
    const { errors } = await validateSite(kit, Site.parse({ ...site, brand: { name: "A", logo: "logo.txt" } }));
    assert.ok(errors.some((e) => /brand logo "logo\.txt" must be an svg, png/.test(e)));
  });
});

describe("local voice", () => {
  it("runs a command with {text} and {out}, caches by format and embeds the right type", async () => {
    // a "voice" that copies the text: enough to follow the files, no audio tool needed
    const provider = commandProvider({ CUEFLOW_TTS_COMMAND: "cp {text} {out}", CUEFLOW_TTS_FORMAT: "m4a" });
    const audio = await narrationAudio(kit, provider, "Hello there", "en");
    assert.equal(audio.toString(), "Hello there");
    const guide = await loadGuide(kit, "upload");
    guide.id = "voiced";
    guide.languages = ["en"];
    await saveGuide(kit, guide);
    const html = await readFile((await buildGuide(kit, "voiced", provider)).file, "utf8");
    assert.match(html, /data:audio\/mp4;base64,/);
  });

  it("explains a missing or failing command", async () => {
    assert.throws(() => commandProvider({}), /needs CUEFLOW_TTS_COMMAND/);
    assert.throws(() => commandProvider({ CUEFLOW_TTS_COMMAND: "say {text}" }), /must write to \{out\}/);
    await assert.rejects(commandProvider({ CUEFLOW_TTS_COMMAND: "false {out}" }).synthesize("x", "en"), /text-to-speech command failed/);
  });
});

describe("capture config", () => {
  it("describes scenes as data and rejects unknown steps", () => {
    const c = Capture.parse({ base: "http://localhost:8080", scenes: [{ name: "home", url: "/", steps: [{ click: "text=Login" }], cues: { menu: "nav" } }] });
    assert.equal(c.lang, "en");
    assert.equal(c.nativeInputs, false);
    assert.deepEqual(c.viewport, { width: 1280, height: 720 });
    assert.throws(() => Capture.parse({ base: "http://x", scenes: [{ name: "a", steps: [{ teleport: "#x" }] }] }));
    assert.throws(() => Capture.parse({ base: "http://x", scenes: [{ name: "../evil" }] }));
  });
});
