import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";
import { loadGuide, openKit, saveGuide } from "../src/kit.ts";
import { startStudio } from "../src/studio.ts";
import { readRawSettings, setVoice } from "../src/voices.ts";

it("opens projects with retired OpenAI choices and lets Studio replace them with Fantastico", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cueflow-legacy-voices-"));
  let studio: Awaited<ReturnType<typeof startStudio>> | undefined;
  try {
    await cp(path.join(import.meta.dirname, "..", "examples", "demo-kit"), root, { recursive: true, filter: (s) => !/[\\/](dist|audio)([\\/]|$)/.test(s) });
    const settings = {
      outDir: "../custom-output", customSetting: "keep",
      voices: {
        default: { provider: "browser" },
        languages: { it: { provider: "openai", voice: "coral" }, fr: { provider: "none" } },
        guides: { upload: { default: { provider: "openai", voice: "coral", style: "Calm" }, languages: { en: { provider: "openai", voice: "fable" } } } }
      }
    };
    const file = path.join(root, "cueflow.json"), original = JSON.stringify(settings);
    await writeFile(file, original);
    const kit = openKit(root);
    assert.deepEqual(kit.settings.voices.guides.upload!.default, { provider: "browser" });
    assert.deepEqual(kit.settings.voices.guides.upload!.languages.en, { provider: "browser" });
    assert.deepEqual(kit.settings.voices.languages.it, { provider: "browser" });
    assert.deepEqual(kit.settings.voices.languages.fr, { provider: "none" });
    assert.equal(await readFile(file, "utf8"), original, "opening alone does not rewrite the project");
    studio = await startStudio(kit, { port: 4897, open: false });
    assert.equal((await fetch(studio.url + "api/state")).status, 200);
    const voices = await (await fetch(studio.url + "api/voices")).json() as any;
    assert.equal(voices.current.guides.upload.languages.en.provider, "browser");
    const professional = { provider: "fantastico", model: "test/speech", voice: "Voice A" };
    await setVoice(kit, { scope: "global" }, professional);
    const saved = await readRawSettings(kit);
    assert.deepEqual(saved.voices.default, professional);
    assert.equal(saved.outDir, "../custom-output");
    assert.equal(saved.customSetting, "keep");
    assert.ok(!(await readFile(file, "utf8")).includes('"openai"'));

    const guideFile = path.join(root, "guides", "upload.json");
    const guide = JSON.parse(await readFile(guideFile, "utf8"));
    guide.steps[0].voice = { en: { provider: "openai", voice: "fable" }, it: { provider: "none" } };
    await writeFile(guideFile, JSON.stringify(guide));
    const loaded = await loadGuide(kit, "upload");
    assert.deepEqual(loaded.steps[0]!.voice, { en: { provider: "browser" }, it: { provider: "none" } });
    await saveGuide(kit, loaded);
    assert.ok(!(await readFile(guideFile, "utf8")).includes('"openai"'));
    await setVoice(kit, { scope: "video", guide: "upload" }, { provider: "none" });
    await setVoice(kit, { scope: "video", guide: "upload", language: "en" }, null);
    const perLanguage = (await readRawSettings(kit)).voices.guides.upload;
    assert.equal(perLanguage.default, undefined);
    assert.equal(perLanguage.languages.en, undefined);
    assert.deepEqual(perLanguage.languages.it, { provider: "none" }, "removing a legacy default for English preserves Italian");
  } finally {
    studio?.close();
    await rm(root, { recursive: true, force: true });
  }
});
