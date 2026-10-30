import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { buildGuide, guideBundle } from "../src/build.ts";
import { commandAvatarProvider, fantasticoAvatarProvider, stepClip } from "../src/avatar-video.ts";
import { setAvatar } from "../src/avatars.ts";
import { loadGuide, openKit, saveGuide, type Kit } from "../src/kit.ts";
import { launchChromium } from "../src/preview.ts";
import { validateGuide } from "../src/validate.ts";

/* A stand-in for Fantastico's avatar surface, speaking the contract of avatar-video.ts: a portrait from words, an
   animate job polled to completion, the clip downloaded. What it answers is whatever bytes the test gives it. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
let dir: string;
let kit: Kit;
let clipBytes = Buffer.from("not really a video");
const seen: { animate: unknown[]; portraits: unknown[] } = { animate: [], portraits: [] };
let pending = 0;
const server = createServer(async (req, res) => {
  const body = await new Promise<string>((r) => { let s = ""; req.on("data", (c) => (s += c)); req.on("end", () => r(s)); });
  if (req.headers.authorization !== "Bearer test-key") { res.writeHead(401); return res.end("no key"); }
  const url = req.url ?? "";
  if (url === "/api/avatar/portrait" && req.method === "POST") { seen.portraits.push(JSON.parse(body)); res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ image: PNG.toString("base64"), contentType: "image/png" })); }
  if (url === "/api/avatar/animate" && req.method === "POST") { seen.animate.push(JSON.parse(body)); pending = 2; res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ job: "j1" })); }
  if (url.startsWith("/api/avatar/jobs/j1")) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify(pending-- > 0 ? { status: "processing" } : { status: "completed", url: `http://127.0.0.1:${port}/clips/j1.mp4`, contentType: "video/mp4" })); }
  if (url === "/clips/j1.mp4") { res.writeHead(200, { "content-type": "video/mp4" }); return res.end(clipBytes); }
  res.writeHead(404); res.end();
});
let port = 0;
const env = () => ({ FANTASTICO_API_KEY: "test-key", FANTASTICO_AVATAR_URL: `http://127.0.0.1:${port}/api` }) as NodeJS.ProcessEnv;

before(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as { port: number }).port;
  dir = await mkdtemp(path.join(tmpdir(), "cueflow-clips-"));
  await cp(path.join(import.meta.dirname, "..", "examples", "motion-kit"), dir, { recursive: true, filter: (s) => !/[\\/]dist([\\/]|$)/.test(s) });
  await mkdir(path.join(dir, "shared", "avatar"), { recursive: true });
  await writeFile(path.join(dir, "shared", "avatar", "face.png"), PNG);
  await mkdir(path.join(dir, "media", "dashboard", "voice"), { recursive: true });
  // a wav of silence for one step: the only step with real audio, so the only clip
  const wav = Buffer.alloc(44 + 8000); wav.write("RIFF", 0); wav.writeUInt32LE(36 + 8000, 4); wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(8000, 40);
  await writeFile(path.join(dir, "media", "dashboard", "voice", "figures.en.wav"), wav);
  kit = openKit(dir);
  const g = await loadGuide(kit, "dashboard");
  g.steps[1]!.voice = { en: { provider: "file", file: "media/dashboard/voice/figures.en.wav" } };
  await saveGuide(kit, g);
  await setAvatar(kit, { scope: "global" }, { provider: "fantastico", image: "shared/avatar/face.png", background: "#101010" });
  await setAvatar(kit, { scope: "video", guide: "dashboard" }, {});
  await setAvatar(kit, { scope: "step", guide: "dashboard", step: "figures" }, { mode: "side", position: "left" });
  kit = openKit(dir);
});
after(async () => { server.close(); await rm(dir, { recursive: true, force: true }); });

describe("the generated narrator", () => {
  it("speaks the contract: a portrait from words, an animate job polled to its clip, a cache by content", async () => {
    const p = fantasticoAvatarProvider(env(), { pollMs: 5 })!;
    const pic = await p.portrait!("a calm narrator", "photo");
    assert.equal(pic.mime, "image/png");
    assert.deepEqual(seen.portraits[0], { prompt: "a calm narrator", style: "photo", size: 1024 });
    const req = { image: PNG, imageMime: "image/png", audio: Buffer.from("audio"), audioMime: "audio/wav", silenceAfterMs: 600, background: "transparent", aspect: "9:16" as const };
    const first = await stepClip(kit, p, req);
    assert.equal(first!.made, true);
    assert.equal(first!.clip.data.toString(), "not really a video");
    const sent = seen.animate[0] as Record<string, unknown>;
    assert.equal(sent.silenceAfterMs, 600, "the clip covers the hold too");
    assert.equal(sent.format, "webm", "transparent asks for alpha");
    assert.equal(sent.aspect, "9:16");
    const again = await stepClip(kit, p, req);
    assert.equal(again!.made, false, "the same inputs come from the cache, nothing is paid twice");
    assert.equal(seen.animate.length, 1);
    assert.equal((await stepClip(kit, p, { ...req, silenceAfterMs: 601 }, { previewOnly: true })), null, "a preview never generates");
    assert.equal(fantasticoAvatarProvider({} as NodeJS.ProcessEnv), null, "no key, no provider");
  });

  it("builds a clip only for the steps that show the narrator and have real audio; previews use the picture", async () => {
    for (const [k, v] of Object.entries(env())) process.env[k] = v;
    try {
      const before = seen.animate.length;
      const b = await guideBundle(kit, "dashboard");
      assert.equal(b.clips, 1);
      assert.equal(b.clipsMade, 1);
      assert.match(b.data.avatarVideo.en!.figures!, /^data:video\/mp4;base64,/);
      assert.equal(b.data.avatarVideo.en!.intro, undefined, "no audio, no clip");
      assert.equal(seen.animate.length - before, 1);
      const req = seen.animate[seen.animate.length - 1] as Record<string, unknown>;
      assert.equal(req.silenceAfterMs, 600);
      assert.equal(req.aspect, "9:16", "a side panel wants a tall clip");
      assert.equal(req.background, "#101010");
      const twice = await guideBundle(kit, "dashboard");
      assert.equal(twice.clipsMade, 0, "nothing paid again");
      const preview = await guideBundle(kit, "dashboard", null);
      assert.equal(preview.clipsMade, 0);
      assert.equal(preview.clips, 1, "a preview takes what the cache has, never generates");
    } finally {
      for (const k of Object.keys(env())) delete process.env[k];
    }
  });

  it("refuses a generated narrator without a picture", async () => {
    const own = await mkdtemp(path.join(tmpdir(), "cueflow-nopic-"));
    await cp(path.join(import.meta.dirname, "..", "examples", "demo-kit"), own, { recursive: true, filter: (s) => !/[\\/](dist|audio)([\\/]|$)/.test(s) });
    const k = openKit(own);
    await setAvatar(k, { scope: "video", guide: "upload" }, { provider: "fantastico" });
    const r = await validateGuide(openKit(own), await loadGuide(openKit(own), "upload"));
    assert.match(r.errors.join("\n"), /provider "fantastico" needs `image`/);
    await rm(own, { recursive: true, force: true });
  });

  it("runs a local program through a command template", async () => {
    const p = commandAvatarProvider("cp {image} {out} && test {silence} = 600 && test {aspect} = 1:1", "mp4");
    const clip = await p.animate({ image: PNG, imageMime: "image/png", audio: Buffer.from("a"), audioMime: "audio/wav", silenceAfterMs: 600, background: "#000", aspect: "1:1" });
    assert.equal(clip.mime, "video/mp4");
    assert.ok(clip.data.equals(PNG), "whatever the program wrote at {out}");
    assert.throws(() => commandAvatarProvider("echo"), /must use \{image\}/);
  });

  it("shows the clip in the player, on the step clock", { skip: !process.env.CUEFLOW_TEST_BROWSER, timeout: 90000 }, async () => {
    // a real (tiny) video, so the browser can seek it
    const ffmpeg = path.join(import.meta.dirname, "..", "node_modules", "ffmpeg-static", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
    const mp4 = path.join(dir, "clip.mp4");
    const args = ["-y", "-f", "lavfi", "-i", "color=c=red:s=96x96:d=3", "-pix_fmt", "yuv420p", mp4];
    try { await promisify(execFile)(ffmpeg, args); } catch { try { await promisify(execFile)("ffmpeg", args); } catch { return; } } // no FFmpeg here: nothing to show
    clipBytes = await readFile(mp4);
    await rm(path.join(dir, "avatar"), { recursive: true, force: true }); // forget the fake clip
    for (const [k, v] of Object.entries(env())) process.env[k] = v;
    let built;
    try { built = await buildGuide(kit, "dashboard"); } finally { for (const k of Object.keys(env())) delete process.env[k]; }
    const browser = await launchChromium("en");
    try {
      const page = await browser.newPage({ viewport: { width: 760, height: 520 } });
      await page.goto(pathToFileURL(built.file).href);
      await page.waitForFunction(() => (window as unknown as { __cueflow?: unknown }).__cueflow);
      await page.evaluate(() => (window as unknown as { __cueflow: { seek(i: number, t: number): Promise<unknown> } }).__cueflow.seek(1, 1500));
      const v = page.locator(".cf-avatar video");
      assert.equal(await v.count(), 1, "step 2 shows the generated clip");
      assert.ok(await page.locator(".cf-avatar").evaluate((el) => el.classList.contains("cf-av-side")));
      assert.ok(Math.abs((await v.evaluate((el) => (el as HTMLVideoElement).currentTime)) - 1.5) < 0.2, "the clip sits where the step is");
      await page.evaluate(() => (window as unknown as { __cueflow: { seek(i: number, t: number): Promise<unknown> } }).__cueflow.seek(0, 100));
      assert.equal(await page.locator(".cf-avatar img").count(), 1, "a step without a clip shows the picture");
    } finally {
      await browser.close();
    }
  });
});
