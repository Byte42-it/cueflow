import assert from "node:assert/strict";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { buildGuide, estimateStepDuration } from "../src/build.ts";
import { describeChange } from "../src/changes.ts";
import { loadGuide, openKit, saveGuide, type Kit } from "../src/kit.ts";
import { Step, spokenOf } from "../src/schema.ts";
import { openPreview } from "../src/preview.ts";
import { stepAudio } from "../src/voices.ts";
import { validateGuide } from "../src/validate.ts";
import type { TtsProvider } from "../src/tts.ts";

let dir: string;
let kit: Kit;

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "cueflow-speech-"));
  await cp(path.join(import.meta.dirname, "..", "examples", "demo-kit"), path.join(dir, "demo"), { recursive: true, filter: (s) => !/[\\/](dist|audio)([\\/]|$)/.test(s) });
  kit = openKit(path.join(dir, "demo"));
});
after(() => rm(dir, { recursive: true, force: true }));

describe("what the voice reads, apart from the caption", () => {
  it("falls back to the narration, per language, and ignores an empty text", () => {
    const st = Step.parse({ id: "a", narration: { en: "Open the file", it: "Apri il file" }, speech: { it: "Apri il faile", en: "  " } });
    assert.equal(spokenOf(st, "it"), "Apri il faile");
    assert.equal(spokenOf(st, "en"), "Open the file");
    assert.equal(spokenOf(Step.parse({ id: "b", narration: { en: "x" } }), "en"), "x");
  });

  it("sends the spoken text to the voice, and the length estimate follows it", async () => {
    const g = await loadGuide(kit, "upload");
    const st = g.steps[0]!;
    st.speech = { en: "A much longer sentence, written only for the voice, that the caption never shows anywhere at all." };
    const said: string[] = [];
    const provider = { id: "fake", voice: "v", format: "mp3", speak: async (t: string) => (said.push(t), Buffer.from("ID3")), synthesize: async (t: string) => (said.push(t), Buffer.from("ID3")) } as unknown as TtsProvider;
    await stepAudio(kit, g, st, "en", provider);
    assert.equal(said.length, 1);
    assert.match(said[0]!, /only for the voice/);
    assert.ok(estimateStepDuration(st, "en").narration > estimateStepDuration({ ...st, speech: undefined }, "en").narration);
  });

  it("warns about a language the guide does not have, and notes a hand edit", async () => {
    const g = await loadGuide(kit, "upload");
    g.steps[0]!.speech = { de: "Hallo" };
    assert.match((await validateGuide(kit, g)).warnings.join("\n"), /spoken text in "de"/);
    assert.match(describeChange({ id: "1", at: "", seen: false, kind: "speech", target: "intro", before: "", after: "faile" }), /the caption did not change/);
  });

  it("the player keeps the caption and times the step on the spoken text", async (t) => {
    const g = await loadGuide(kit, "upload");
    const st = g.steps[0]!;
    const caption = st.narration.en!;
    st.speech = { en: caption + " " + "x".repeat(200) };
    await saveGuide(kit, g);
    const built = await buildGuide(kit, "upload", null);
    const pv = await openPreview(built.file, { lang: "en" }).catch((e) => (t.skip(`no browser: ${e.message}`), null));
    if (!pv) return;
    try {
      const r = await pv.seek(0, 0);
      assert.ok(r.narration >= (caption.length + 201) * 65 - 1);
    } finally { await pv.close(); }
  });
});
