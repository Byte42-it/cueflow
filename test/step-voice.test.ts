import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { guideBundle } from "../src/build.ts";
import { loadGuide, openKit, saveGuide, type Kit } from "../src/kit.ts";
import { validateGuide } from "../src/validate.ts";

let dir: string;
let kit: Kit;

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "cueflow-stepvoice-"));
  await cp(path.join(import.meta.dirname, "..", "examples", "demo-kit"), path.join(dir, "demo"), { recursive: true, filter: (s) => !/[\\/](dist|audio)([\\/]|$)/.test(s) });
  kit = openKit(path.join(dir, "demo"));
});
after(() => rm(dir, { recursive: true, force: true }));

describe("the voice of one step", () => {
  it("plays an uploaded file for that step and language only", async () => {
    const g = await loadGuide(kit, "upload");
    await mkdir(path.join(kit.root, "media", "upload", "voice"), { recursive: true });
    await writeFile(path.join(kit.root, "media", "upload", "voice", "a.en.mp3"), Buffer.from("ID3fake"));
    g.steps[0]!.voice = { en: { provider: "file", file: "media/upload/voice/a.en.mp3" } };
    await saveGuide(kit, g);
    const b = await guideBundle(kit, "upload", null);
    assert.match(b.data.audio.en![g.steps[0]!.id]!, /^data:audio\/mpeg;base64,/);
    assert.equal(Object.keys(b.data.audio.en!).length, 1);
    assert.equal(b.data.audio.it, undefined);
  });

  it("refuses a file that is missing or outside the kit", async () => {
    const g = await loadGuide(kit, "upload");
    g.steps[0]!.voice = { en: { provider: "file", file: "media/upload/voice/none.mp3" } };
    assert.match((await validateGuide(kit, g)).errors.join("\n"), /does not exist/);
    g.steps[0]!.voice = { en: { provider: "file", file: "../outside.mp3" } };
    assert.match((await validateGuide(kit, g)).errors.join("\n"), /inside the kit/);
  });

  it("leaves a muted step without audio and keeps the voice in the page data", async () => {
    const g = await loadGuide(kit, "upload");
    g.steps[0]!.voice = { en: { provider: "none" } };
    await saveGuide(kit, g);
    const b = await guideBundle(kit, "upload", null);
    assert.equal(b.data.audio.en, undefined);
    assert.equal(b.data.guide.steps[0]!.voice!.en!.provider, "none");
  });
});
