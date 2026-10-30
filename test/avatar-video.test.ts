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
import { loadGuide, openKit, type Kit } from "../src/kit.ts";
import { launchChromium } from "../src/preview.ts";
import { validateGuide } from "../src/validate.ts";

/* Stand-ins for the two services Cueflow talks to: Fantastico (mints the runtime key from the Fantastico key)
   and the models behind it (a video job polled to its clip, a portrait from a chat completion with an image). */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
let dir: string;
let kit: Kit;
let clipBytes: Buffer = Buffer.from("not really a video");
const seen: { mints: number; jobs: Record<string, unknown>[]; portraits: unknown[]; refuseNext: boolean; refused: number } = { mints: 0, jobs: [], portraits: [], refuseNext: false, refused: 0 };
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
  if (url === "/or/videos" && req.method === "POST") { const j = JSON.parse(body); if (!j.provider?.options?.heygen?.voice_id) { seen.refused += 1; return json(400, { error: { message: "avatar-iv requires provider.options.heygen.voice_id when using a text prompt (script); supply an audio input reference instead, or pick a voice such as: 16a09e4706f74997ba4ed05ea1e3d3ea, 1bd001e7e50f421d891986aad5158bc8", code: 400 } }); } seen.jobs.push(j); pending = 2; return json(202, { id: "job1", status: "pending", polling_url: "/or/videos/job1" }); }
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
  await setAvatar(kit, { scope: "global" }, { provider: "fantastico", image: "shared/avatar/face.avif", background: "#101010", voices: { en: "Daniel" } });
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

  it("asks for the clip of the person saying the text, with the place's shape and the background, and caches it", async () => {
    const real = await realClip();
    if (real) clipBytes = real;
    const p = fantasticoAvatarProvider(env(), { pollMs: 5 })!;
    assert.equal(p.voiced, true);
    const req = { image: PNG, imageMime: "image/avif", text: "Hello there.", lang: "en", voice: "Daniel", silenceAfterMs: 600, background: "transparent", aspect: "9:16" as const };
    if (!real) { // without FFmpeg the clip's voice cannot be taken: the request itself is still checked
      await assert.rejects(stepClip(kit, p, req), /ffmpeg|FFmpeg/i);
      return;
    }
    const first = await stepClip(kit, p, req);
    assert.equal(first!.made, true);
    assert.equal(first!.clip.mime, "video/mp4");
    assert.equal(first!.clip.costUsd, 0.15);
    assert.equal(first!.audio!.mime, "audio/wav");
    assert.ok(first!.audio!.data.length > 44, "the clip's voice became the step's audio");
    const job = seen.jobs[seen.jobs.length - 1] as { model: string; prompt: string; aspect_ratio: string; input_references: { image_url: { url: string } }[]; provider: { options: Record<string, Record<string, unknown>> } };
    assert.equal(job.model, "heygen/avatar-iv");
    assert.equal(job.prompt, "Hello there.");
    assert.equal(job.aspect_ratio, "9:16");
    assert.match(job.input_references[0]!.image_url.url, /^data:image\/avif;base64,/);
    assert.deepEqual(job.provider.options.heygen, { voice_id: "Daniel", remove_background: true });
    const again = await stepClip(kit, p, req);
    assert.equal(again!.made, false, "the same inputs come from the cache, nothing is paid twice");
    assert.equal(again!.audio!.mime, "audio/wav");
    assert.equal(await stepClip(kit, p, { ...req, text: "Other words." }, { previewOnly: true }), null, "a preview never generates");
  });

  it("builds a clip only for the step that shows the narrator; its voice is the clip's; a preview reads the cache", async () => {
    if (!(await realClip())) return;
    await withEnv(async () => {
      const jobs = seen.jobs.length;
      const b = await guideBundle(kit, "dashboard");
      assert.equal(b.clips, 2, "English has a voice; Italian has none, so the model is asked for one and the clip made with it");
      assert.equal(b.clipsMade, 2);
      assert.equal(seen.refused, 1, "one job without a voice, refused before anything is paid");
      assert.match(b.warnings.join("\n"), /no voice was chosen for "it": "16a09e4706f74997ba4ed05ea1e3d3ea" from the model's own voices is now the narrator's/);
      assert.equal(openKit(dir).settings.avatar?.voices?.it, "16a09e4706f74997ba4ed05ea1e3d3ea", "kept in cueflow.json, where Studio shows it");
      assert.equal(kit.settings.avatar?.voices?.it, "16a09e4706f74997ba4ed05ea1e3d3ea", "and the kit in hand sees it");
      assert.match(b.data.avatarVideo.en!.figures!, /^data:video\/mp4;base64,/);
      assert.match(b.data.audio.en!.figures!, /^data:audio\/wav;base64,/, "the step's audio is the clip's voice");
      assert.equal(b.data.avatarVideo.en!.intro, undefined, "hidden there: no clip, no credit");
      const en = (seen.jobs.slice(jobs) as { prompt: string; aspect_ratio: string; provider: { options: { heygen: Record<string, unknown> } } }[]).find((j) => j.provider.options.heygen.voice_id === "Daniel")!;
      assert.match(en.prompt, /^Documents, open cases/);
      assert.equal(en.aspect_ratio, "9:16");
      assert.equal(en.provider.options.heygen.background, "#101010");
      const twice = await guideBundle(kit, "dashboard");
      assert.equal(twice.clipsMade, 0, "nothing paid again");
      const preview = await guideBundle(kit, "dashboard", null);
      assert.equal(preview.clipsMade, 0);
      assert.equal(preview.clips, 2, "a preview takes what the cache has, never generates");
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
    assert.equal(p.voiced, false);
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
