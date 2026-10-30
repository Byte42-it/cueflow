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
import { commandAvatarProvider, fantasticoAvatarProvider, imageMimeOf, stepClip } from "../src/avatar-video.ts";
import { setAvatar } from "../src/avatars.ts";
import { loadGuide, openKit, saveGuide, type Kit } from "../src/kit.ts";
import { launchChromium } from "../src/preview.ts";
import { validateGuide } from "../src/validate.ts";

/* Stand-ins for the two services Cueflow talks to: Fantastico (mints the runtime key from the Fantastico key)
   and the models behind it (a video job polled to its clip, a portrait from a chat completion with an image). */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
let dir: string;
let kit: Kit;
let clipBytes: Buffer = Buffer.from("not really a video");
const seen: { mints: number; jobs: Record<string, unknown>[]; portraits: unknown[]; refuseNext: boolean } = { mints: 0, jobs: [], portraits: [], refuseNext: false };
let pending = 0;
const server = createServer(async (req, res) => {
  const body = await new Promise<string>((r) => { let s = ""; req.on("data", (c) => (s += c)); req.on("end", () => r(s)); });
  const url = req.url ?? "", auth = req.headers.authorization ?? "";
  const json = (code: number, v: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };
  // Fantastico: the key is minted from the Fantastico key, on its surface
  if (url === "/fantastico/edge/key" && req.method === "POST") { if (auth !== "Bearer ck-fant-test") return json(401, { message: "no" }); seen.mints += 1; return json(200, { runtimeKey: `rk-${seen.mints}`, expiresAt: new Date(Date.now() + 3600e3).toISOString(), recordId: "r1" }); }
  // the models: only a minted key opens the door; one refusal, when asked, to see the key minted again
  if (!/^Bearer rk-\d+$/.test(auth)) return json(401, { error: "bad key" });
  if (seen.refuseNext) { seen.refuseNext = false; return json(401, { error: "key expired" }); }
  if (url === "/or/chat/completions" && req.method === "POST") { seen.portraits.push(JSON.parse(body)); return json(200, { choices: [{ message: { content: "", images: [{ image_url: { url: `data:image/png;base64,${PNG.toString("base64")}` } }] } }] }); }
  if (url === "/or/videos" && req.method === "POST") { seen.jobs.push(JSON.parse(body)); pending = 2; return json(202, { id: "job1", status: "pending", polling_url: "/or/videos/job1" }); }
  if (url === "/or/videos/job1") return json(200, pending-- > 0 ? { id: "job1", status: "in_progress" } : { id: "job1", status: "completed", unsigned_urls: [`http://127.0.0.1:${port}/or/videos/job1/content?index=0`], usage: { cost: 0.15 } });
  if (url.startsWith("/or/videos/job1/content")) { res.writeHead(200, { "content-type": "video/mp4" }); return res.end(clipBytes); }
  res.writeHead(404); res.end();
});
let port = 0;
const env = () => ({ FANTASTICO_API_KEY: "ck-fant-test", FANTASTICO_BASE_URL: `http://127.0.0.1:${port}/fantastico`, FANTASTICO_MODELS_URL: `http://127.0.0.1:${port}/or` }) as NodeJS.ProcessEnv;
const withEnv = async <T>(fn: () => Promise<T>) => { for (const [k, v] of Object.entries(env())) process.env[k] = v; try { return await fn(); } finally { for (const k of Object.keys(env())) delete process.env[k]; } };
/** a real (tiny) mp4 with a tone, so FFmpeg can take its voice and a browser can seek it; null without FFmpeg */
async function realClip(): Promise<Buffer | null> {
  const out = path.join(dir, "clip.mp4");
  const args = ["-y", "-f", "lavfi", "-i", "color=c=red:s=96x96:d=3", "-f", "lavfi", "-i", "sine=frequency=220:duration=3", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", out];
  const bundled = path.join(import.meta.dirname, "..", "node_modules", "ffmpeg-static", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
  try { await promisify(execFile)(bundled, args); } catch { try { await promisify(execFile)("ffmpeg", args); } catch { return null; } }
  return readFile(out);
}

before(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as { port: number }).port;
  dir = await mkdtemp(path.join(tmpdir(), "cueflow-clips-"));
  await cp(path.join(import.meta.dirname, "..", "examples", "motion-kit"), dir, { recursive: true, filter: (s) => !/[\\/]dist([\\/]|$)/.test(s) });
  await mkdir(path.join(dir, "shared", "avatar"), { recursive: true });
  await writeFile(path.join(dir, "shared", "avatar", "face.avif"), PNG); // the bytes do not matter to the stand-in; the type travels
  kit = openKit(dir);
  await setAvatar(kit, { scope: "global" }, { provider: "fantastico", image: "shared/avatar/face.avif", background: "#101010" });
  // a wav of silence for one step: real audio, so the step can have a clip
  const wav = Buffer.alloc(44 + 8000); wav.write("RIFF", 0); wav.writeUInt32LE(36 + 8000, 4); wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(8000, 40);
  await mkdir(path.join(dir, "media", "dashboard", "voice"), { recursive: true });
  await writeFile(path.join(dir, "media", "dashboard", "voice", "figures.en.wav"), wav);
  const g = await loadGuide(kit, "dashboard");
  g.steps[1]!.voice = { en: { provider: "file", file: "media/dashboard/voice/figures.en.wav" } };
  await saveGuide(kit, g);
  await setAvatar(kit, { scope: "video", guide: "dashboard" }, { mode: "off" });
  await setAvatar(kit, { scope: "step", guide: "dashboard", step: "figures" }, { mode: "side", position: "left" }); // the only step that shows it
  kit = openKit(dir);
});
after(async () => { server.close(); await rm(dir, { recursive: true, force: true }); });

describe("the generated narrator", () => {
  it("mints the models' key from the Fantastico key, mints again when refused, and keeps the key out of the kit", async () => {
    const p = fantasticoAvatarProvider(env(), { pollMs: 5 })!;
    const pic = await p.portrait!("a calm narrator", "photo");
    assert.equal(pic.mime, "image/png");
    assert.equal(seen.mints, 1);
    const sent = seen.portraits[0] as { model: string; modalities: string[]; messages: { content: string }[] };
    assert.deepEqual(sent.modalities, ["image", "text"]);
    assert.match(sent.messages[0]!.content, /head and shoulders.*photo: a calm narrator/);
    seen.refuseNext = true;
    const again = await p.portrait!("another", undefined);
    assert.equal(again.mime, "image/png");
    assert.equal(seen.mints, 2, "a refused key is minted once more");
    assert.equal(fantasticoAvatarProvider({} as NodeJS.ProcessEnv), null, "no Fantastico key, no provider");
    assert.doesNotMatch(JSON.stringify(kit.settings), /rk-/, "no runtime key is ever written");
  });

  it("asks for the clip of the person lip-synced to the step's audio with the hold appended, the place's shape and the background, and caches it", async () => {
    const real = await realClip();
    if (real) clipBytes = real;
    const p = fantasticoAvatarProvider(env(), { pollMs: 5 })!;
    const wav = await readFile(path.join(dir, "media", "dashboard", "voice", "figures.en.wav"));
    const req = { image: PNG, imageMime: "image/avif", text: "Hello there.", lang: "en", audio: wav, audioMime: "audio/wav", silenceAfterMs: 600, background: "transparent", aspect: "9:16" as const };
    let first;
    try { first = await stepClip(kit, p, req); } catch (e) { if (/ffmpeg/i.test(String(e))) return; throw e; } // no FFmpeg: nothing to pad with
    assert.equal(first!.made, true);
    assert.equal(first!.clip.mime, "video/mp4");
    assert.equal(first!.clip.costUsd, 0.15);
    const job = seen.jobs[seen.jobs.length - 1] as { model: string; prompt: string; aspect_ratio: string; input_references: { type: string; image_url?: { url: string }; audio_url?: { url: string } }[]; provider: { options: Record<string, Record<string, unknown>> } };
    assert.equal(job.model, "heygen/avatar-iv");
    assert.equal(job.prompt, "Hello there.");
    assert.equal(job.aspect_ratio, "9:16");
    assert.match(job.input_references[0]!.image_url!.url, /^data:image\/avif;base64,/);
    assert.equal(job.input_references[1]!.type, "audio_url");
    const sent = Buffer.from(job.input_references[1]!.audio_url!.url.replace(/^data:audio\/wav;base64,/, ""), "base64");
    assert.ok(sent.length > 44 + 24000 * 2 * 0.5 + 24000 * 2 * 0.6 - 2000, "the audio sent is the step's voice plus 600 ms of silence (24 kHz mono)");
    assert.deepEqual(job.provider.options.heygen, { remove_background: true });
    const again = await stepClip(kit, p, req);
    assert.equal(again!.made, false, "the same inputs come from the cache, nothing is paid twice");
    assert.equal(await stepClip(kit, p, { ...req, silenceAfterMs: 601 }, { previewOnly: true }), null, "a preview never generates");
  });

  it("builds a clip only for the step that shows the narrator; its voice is the clip's; a preview reads the cache", async () => {
    if (!(await realClip())) return;
    await withEnv(async () => {
      const jobs = seen.jobs.length;
      const b = await guideBundle(kit, "dashboard");
      assert.equal(b.clips, 1, "the one step that shows the narrator and has real audio (English only has a file)");
      assert.equal(b.clipsMade, 1);
      assert.match(b.data.avatarVideo.en!.figures!, /^data:video\/mp4;base64,/);
      assert.match(b.data.audio.en!.figures!, /^data:audio\/wav;base64,/, "the step keeps its own voice");
      assert.equal(b.data.avatarVideo.en!.intro, undefined, "hidden there: no clip, no credit");
      const en = seen.jobs[jobs] as { prompt: string; aspect_ratio: string; provider: { options: { heygen: Record<string, unknown> } } };
      assert.match(en.prompt, /^Documents, open cases/);
      assert.equal(en.aspect_ratio, "9:16");
      assert.equal(en.provider.options.heygen.background, "#101010");
      const twice = await guideBundle(kit, "dashboard");
      assert.equal(twice.clipsMade, 0, "nothing paid again");
      const preview = await guideBundle(kit, "dashboard", null);
      assert.equal(preview.clipsMade, 0);
      assert.equal(preview.clips, 1, "a preview takes what the cache has, never generates");
    });
  });

  it("refuses a generated narrator without a picture, and knows the picture types", async () => {
    const own = await mkdtemp(path.join(tmpdir(), "cueflow-nopic-"));
    await cp(path.join(import.meta.dirname, "..", "examples", "demo-kit"), own, { recursive: true, filter: (s) => !/[\\/](dist|audio)([\\/]|$)/.test(s) });
    const k = openKit(own);
    await setAvatar(k, { scope: "video", guide: "upload" }, { provider: "fantastico" });
    const r = await validateGuide(openKit(own), await loadGuide(openKit(own), "upload"));
    assert.deepEqual(r.errors, [], "a missing picture must not block the tutorial");
    assert.match(r.warnings.join("\n"), /provider "fantastico" has no picture of the person yet/);
    await rm(own, { recursive: true, force: true });
    assert.equal(imageMimeOf("x/me.AVIF"), "image/avif");
    assert.equal(imageMimeOf("x/me.jpg"), "image/jpeg");
  });

  it("runs a local program through a command template, driven by the audio Cueflow made", async () => {
    const p = commandAvatarProvider("cp {image} {out} && test {silence} = 600 && test {aspect} = 1:1 && grep -q Hello {text}", "mp4");
    const clip = await p.animate({ image: PNG, imageMime: "image/png", text: "Hello", lang: "en", audio: Buffer.from("a"), audioMime: "audio/wav", silenceAfterMs: 600, background: "#000", aspect: "1:1" });
    assert.equal(clip.mime, "video/mp4");
    assert.ok(clip.data.equals(PNG), "whatever the program wrote at {out}");
    assert.throws(() => commandAvatarProvider("echo"), /must use \{image\}/);
  });

  it("shows the clip in the player, on the step clock, and the picture where there is none", { skip: !process.env.CUEFLOW_TEST_BROWSER, timeout: 90000 }, async () => {
    if (!(await realClip())) return;
    const built = await withEnv(() => buildGuide(kit, "dashboard"));
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
      assert.equal(await page.locator(".cf-avatar").isVisible(), false, "the video hides the narrator elsewhere");
    } finally {
      await browser.close();
    }
  });
});
