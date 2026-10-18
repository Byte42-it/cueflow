import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";
import { Guide, orientedGuide } from "../src/schema.ts";
import { loadGuide, openKit, saveGuide } from "../src/kit.ts";
import { buildVideo, resolveFFmpeg, videoPreset, windowsFFmpegCandidates } from "../src/video.ts";

it("defaults to Medium and refuses unsupported video sizes", () => {
  assert.deepEqual(videoPreset(), { id: "medium", label: "Medium", width: 1280, height: 720 });
  for (const value of ["huge", "__proto__", "constructor", null, 720]) assert.throws(() => videoPreset(value), /size must be/);
});

it("finds bundled FFmpeg even without a system installation", async () => {
  const originalPath = process.env.PATH;
  const originalOverride = process.env.CUEFLOW_FFMPEG;
  try {
    process.env.PATH = "";
    delete process.env.CUEFLOW_FFMPEG;
    const executable = await resolveFFmpeg();
    assert.ok(path.isAbsolute(executable));
    const result = await promisify(execFile)(executable, ["-version"]);
    assert.match(result.stdout, /ffmpeg version/);
    process.env.CUEFLOW_FFMPEG = path.join(tmpdir(), "cueflow-missing-ffmpeg-executable");
    await assert.rejects(resolveFFmpeg(), (e: Error) => {
      assert.match(e.message, /configured in CUEFLOW_FFMPEG/);
      assert.match(e.message, /ENOENT/);
      assert.ok(e.message.includes(process.platform + "/" + process.arch));
      return true;
    });
    process.env.CUEFLOW_FFMPEG = executable;
    assert.equal(await resolveFFmpeg(), executable);
  } finally {
    if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
    if (originalOverride === undefined) delete process.env.CUEFLOW_FFMPEG; else process.env.CUEFLOW_FFMPEG = originalOverride;
  }
});

it("finds Windows WinGet installations even when the PATH is stale", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cueflow-winget-"));
  try {
    const bin = path.join(root, "Microsoft", "WinGet", "Packages", "Gyan.FFmpeg_test", "ffmpeg-full_build", "bin");
    await mkdir(bin, { recursive: true });
    const executable = path.join(bin, "ffmpeg.exe");
    await writeFile(executable, "fixture");
    const found = await windowsFFmpegCandidates({ LOCALAPPDATA: root });
    assert.ok(found.includes(executable));
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("uses the running OS even if npm was configured for another platform", async () => {
  const video = new URL("../src/video.ts", import.meta.url).href;
  const result = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", `const {resolveFFmpeg} = await import(${JSON.stringify(video)}); console.log(await resolveFFmpeg());`], { env: { ...process.env, CUEFLOW_FFMPEG: "", npm_config_platform: process.platform === "win32" ? "linux" : "win32" } });
  assert.equal(path.basename(result.stdout.trim()), process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
});

it("exports a short animated tutorial as an MP4", { skip: !process.env.CUEFLOW_TEST_VIDEO, timeout: 120000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cueflow-video-test-"));
  try {
    await mkdir(path.join(dir, "guides"));
    await mkdir(path.join(dir, "scenes"));
    await writeFile(path.join(dir, "scenes", "screen.html"), '<html><body><button id="target">Hello</button></body></html>');
    await writeFile(path.join(dir, "cueflow.json"), JSON.stringify({ voices: { default: { provider: "none" } } }));
    await writeFile(path.join(dir, "guides", "short.json"), JSON.stringify({ id: "short", title: "Short", scene: "screen", languages: ["en"], viewport: { width: 1280, height: 720 }, steps: [
      { id: "first", narration: { en: "Hi" }, hold: 0, actions: [{ do: "move", to: "#target", at: 0, duration: 400 }] },
      { id: "second", narration: { en: "Bye" }, hold: 0, actions: [] }
    ] }));
    const wav = Buffer.alloc(44 + 16000);
    wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
    wav.write("data", 36); wav.writeUInt32LE(16000, 40);
    for (let i = 0; i < 8000; i++) wav.writeInt16LE(Math.round(8000 * Math.sin(i * Math.PI * 880 / 16000)), 44 + i * 2);
    await writeFile(path.join(dir, "tone.wav"), wav);
    const guideFile = path.join(dir, "guides", "short.json");
    const guide = JSON.parse(await readFile(guideFile, "utf8"));
    guide.steps[0].voice = { en: { provider: "file", file: "tone.wav" } };
    await writeFile(guideFile, JSON.stringify(guide));
    const kit = openKit(dir);
    await assert.rejects(buildVideo(kit, "short", "it"), /Unknown tutorial language/);
    for (const [size, vertical] of [["medium", false], ["large", false], ["small", false], ["small", true]] as const) {
      await writeFile(guideFile, JSON.stringify({ ...guide, vertical }));
      const progress: { percent: number; phase: string }[] = [];
      const result = await buildVideo(kit, "short", "en", (value) => progress.push(value), size === "medium" ? {} : { size });
      assert.equal(progress[0]!.percent, 0);
      assert.equal(progress.at(-1)!.percent, 100);
      assert.ok(progress.some((p) => /Rendering step 2 of 2/.test(p.phase)));
      assert.ok(progress.some((p) => /Encoding/.test(p.phase)));
      assert.ok(progress.every((p, i) => p.percent >= 0 && p.percent <= 100 && (!i || p.percent >= progress[i - 1]!.percent)));
      const data = await readFile(result.file);
      assert.equal(data.toString("ascii", 4, 8), "ftyp");
      assert.ok(data.length > 1000);
      const decoded = await promisify(execFile)(await resolveFFmpeg(), ["-i", result.file, "-f", "null", "-"]);
      assert.match(decoded.stderr, /Video: h264/);
      const preset = videoPreset(size, vertical);
      assert.match(decoded.stderr, new RegExp(preset.width + "x" + preset.height));
      assert.match(result.name, new RegExp("\\." + size + "\\.mp4$"));
      assert.match(decoded.stderr, /Audio: aac/);
      assert.match(decoded.stderr, /Duration: 00:00:02\.0[34]/);
      assert.ok(result.warnings.some((w) => /silent/.test(w)));
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});


it("keeps old tutorials unchanged and frames vertical tutorials without mutating saved dimensions", () => {
  const legacy = Guide.parse({ id: "old", title: "Old", scene: "screen" });
  assert.equal(legacy.vertical, false);
  assert.equal(orientedGuide(legacy), legacy);
  assert.deepEqual(legacy.viewport, { width: 1280, height: 720 });
  for (const vertical of [false, true]) {
    const guide = Guide.parse({ ...legacy, vertical });
    const oriented = orientedGuide(guide);
    assert.deepEqual(oriented.viewport, vertical ? { width: 720, height: 1280 } : legacy.viewport);
    assert.deepEqual(oriented.stage, vertical ? { width: 360, height: 640 } : legacy.stage);
    assert.deepEqual(guide.viewport, legacy.viewport);
    assert.deepEqual(orientedGuide(oriented), oriented);
    for (const size of ["large", "medium", "small"]) {
      const preset = videoPreset(size, vertical), original = videoPreset(size);
      assert.equal(preset.width, vertical ? original.height : original.width);
      assert.equal(preset.height, vertical ? original.width : original.height);
    }
  }
  assert.equal(Guide.safeParse({ ...legacy, vertical: "true" }).success, false);
});


it("refuses orientation changes when saving existing tutorials, including legacy files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cueflow-orientation-"));
  const kit = openKit(root);
  try {
    for (const vertical of [false, true]) {
      const guide = Guide.parse({ id: vertical ? "portrait" : "landscape", title: "Test", scene: "screen", vertical });
      await saveGuide(kit, guide);
      await saveGuide(kit, { ...guide, title: "Updated" });
      await assert.rejects(saveGuide(kit, { ...guide, vertical: !vertical }), /orientation is fixed at creation/);
      assert.equal((await loadGuide(kit, guide.id)).vertical, vertical);
    }
    const file = path.join(root, "guides", "legacy.json");
    await writeFile(file, JSON.stringify({ id: "legacy", title: "Old", scene: "screen" }));
    const legacy = await loadGuide(kit, "legacy");
    await assert.rejects(saveGuide(kit, { ...legacy, vertical: true }), /orientation is fixed at creation/);
    await saveGuide(kit, { ...legacy, title: "Updated" });
    assert.equal((await loadGuide(kit, "legacy")).vertical, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
