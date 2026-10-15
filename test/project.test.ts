import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { guideBundle, buildGuide } from "../src/build.ts";
import { initKit } from "../src/brief.ts";
import { findKitRoot, openKit, type Kit } from "../src/kit.ts";
import { resolveVoice, Settings } from "../src/settings.ts";
import { readRawSettings, setVoice, voiceFor, voiceOptions, voiceTable } from "../src/voices.ts";

let dir: string;
let kit: Kit;

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "cueflow-project-"));
  const root = path.join(dir, "product", ".cueflow");
  await cp(path.join(import.meta.dirname, "..", "examples", "demo-kit"), root, { recursive: true, filter: (s) => !/[\\/](dist|audio)([\\/]|$)/.test(s) });
  kit = openKit(root);
  await initKit(kit);
});
after(() => rm(dir, { recursive: true, force: true }));

describe("project kit", () => {
  it("is found from any folder below the project, like .git", async () => {
    await mkdir(path.join(dir, "product", "src", "deep"), { recursive: true });
    assert.equal(findKitRoot(path.join(dir, "product", "src", "deep")), path.join(dir, "product", ".cueflow"));
    assert.equal(findKitRoot(dir), null);
  });

  it("fixes the output folder once, next to .cueflow, and builds there", async () => {
    assert.equal(JSON.parse(await readFile(path.join(kit.root, "cueflow.json"), "utf8")).outDir, "../cueflow-dist");
    assert.equal(kit.out, path.join(dir, "product", "cueflow-dist"));
    const r = await buildGuide(openKit(kit.root), "upload");
    assert.equal(r.file, path.join(dir, "product", "cueflow-dist", "upload.html"));
    await stat(r.file);
    assert.match(await readFile(path.join(kit.root, ".gitignore"), "utf8"), /\.env/);
  });

  it("does not change the output folder when init runs again", async () => {
    await initKit(kit, undefined, "somewhere-else");
    assert.equal(openKit(kit.root).out, path.join(dir, "product", "cueflow-dist"));
  });
});

describe("voices", () => {
  const s = (voices: unknown) => Settings.parse({ voices });
  const openai = { provider: "openai", voice: "coral" } as const;
  const say = { provider: "say" } as const;
  const piper = { provider: "command", command: "piper --output_file {out} < {text}" } as const;

  it("is the browser voice when nothing is chosen", () => {
    assert.deepEqual(resolveVoice(Settings.parse({}), "upload", "en"), { spec: { provider: "browser" }, source: "default" });
  });

  it("inherits: video-language > video > language > global > browser", () => {
    const cfg = s({ default: say, languages: { it: piper }, guides: { upload: { default: openai, languages: { it: { provider: "none" } } } } });
    assert.equal(resolveVoice(cfg, "upload", "it").source, "video-language");
    assert.equal(resolveVoice(cfg, "upload", "en").source, "video");
    assert.equal(resolveVoice(cfg, "other", "it").source, "language");
    assert.equal(resolveVoice(cfg, "other", "en").source, "global");
    assert.equal(resolveVoice(cfg, "other", "en").spec.provider, "say");
  });

  it("a language's voice reaches every video that has no voice of its own", () => {
    const cfg = s({ languages: { it: piper }, guides: { upload: { default: openai } } });
    assert.equal(resolveVoice(cfg, "sharing", "it").spec.provider, "command");
    assert.equal(resolveVoice(cfg, "upload", "it").spec.provider, "openai");
  });

  it("an external voice is explicit: OpenAI without a key says what to do", () => {
    const k = { ...kit, settings: s({ default: openai }) };
    assert.throws(() => voiceFor(k, "upload", "en", {}), /OPENAI_API_KEY is missing.*\.env/);
    assert.equal(voiceFor(k, "upload", "en", { OPENAI_API_KEY: "sk-test" }).provider?.id, "openai");
  });

  it("a key alone chooses nothing, and the environment only decides when cueflow.json does not", () => {
    const none = { ...kit, settings: Settings.parse({}) };
    assert.equal(voiceFor(none, "upload", "en", { OPENAI_API_KEY: "sk-test" }).provider, null);
    assert.equal(voiceFor(none, "upload", "en", { CUEFLOW_TTS: "openai", OPENAI_API_KEY: "sk-test" }).provider?.id, "openai");
    const chosen = { ...kit, settings: s({ default: { provider: "browser" } }) };
    assert.equal(voiceFor(chosen, "upload", "en", { CUEFLOW_TTS: "openai", OPENAI_API_KEY: "sk-test" }).provider, null);
  });

  it("setVoice writes only what was asked, and clearing goes back to inheriting", async () => {
    await setVoice(kit, { scope: "language", language: "it" }, { provider: "say" });
    await setVoice(kit, { scope: "video", guide: "upload", language: "en" }, { provider: "none" });
    let raw = await readRawSettings(kit);
    assert.deepEqual(raw.voices.languages, { it: { provider: "say" } });
    assert.deepEqual(raw.voices.guides, { upload: { languages: { en: { provider: "none" } } } });
    assert.equal((await voiceTable(kit)).find((r) => r.guide === "upload" && r.language === "en")?.from, "video-language");
    await setVoice(kit, { scope: "video", guide: "upload", language: "en" }, null);
    await setVoice(kit, { scope: "language", language: "it" }, null);
    raw = await readRawSettings(kit);
    assert.equal(raw.voices.guides.upload, undefined);
    assert.deepEqual(raw.voices.languages, {});
  });

  it("refuses a voice for a video that does not exist, and a malformed voice", async () => {
    await assert.rejects(setVoice(kit, { scope: "video", guide: "nope" }, { provider: "none" }), /does not exist/);
    await assert.rejects(setVoice(kit, { scope: "global" }, { provider: "openai", voice: 3 }), /voice/);
  });

  it("with the browser voice the player reads the narration itself", async () => {
    const bundle = await guideBundle(openKit(kit.root), "upload");
    assert.equal(bundle.guide.player.fallbackVoice, "browser");
    assert.equal(bundle.audioFiles, 0);
  });

  it("describes the options in words, and only OpenAI needs a key", () => {
    const options = voiceOptions({});
    assert.equal(options[0]!.provider, "browser");
    assert.equal(options.find((o) => o.provider === "openai")!.available, false);
    assert.ok(options.every((o) => o.summary.length > 20));
  });
});
