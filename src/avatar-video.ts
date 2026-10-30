import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Kit } from "./kit.ts";
import { FANTASTICO_PORTAL } from "./tts.ts";
import { resolveFFmpeg } from "./video.ts";

/**
 * The narrator as a generated video: a picture of a person becomes a clip of that person saying the step (lips on the
 * voice), one clip per step and per language. Chosen like a voice: `provider: "fantastico"` or `"command"`.
 *
 * `fantastico`: the video models of Fantastico's catalogue (HeyGen Avatar IV by default), paid with the Fantastico key
 * like the voices. Fantastico is the bank of keys: Cueflow mints a **runtime key** from it (`POST <base>/<surface>/key`,
 * the same thing the Fantastico SDK does inside, rebuilt here because the SDK keeps the key private and has no video
 * surface), calls the models' video API with it, and mints again when it expires or is refused. The clip is **driven by
 * the audio Cueflow already made** for the step (the voice of the tutorial), with the step's hold appended as silence,
 * so lips follow the same voice as everywhere else and the face lives through the pause: nothing frozen, nothing looped.
 * `command`: a local program (LivePortrait, Wav2Lip, SadTalker…) driven by the same audio.
 *
 * Cached under <kit>/avatar/ by content hash like the audio; only a changed step is generated again.
 */
export type ClipRequest = {
  /** the person: a picture of the kit (png, jpg, webp, avif) */
  image: Buffer;
  imageMime: string;
  /** what is said (the spoken form of the narration), for a program that wants the words too */
  text: string;
  lang: string;
  /** the audio Cueflow made for the step: the clip's lips follow it */
  audio: Buffer;
  audioMime: string;
  /** silence appended after the words (the step's hold): the clip covers the whole step */
  silenceAfterMs: number;
  /** a CSS colour, or "transparent" (the person cut out, when the model can) */
  background: string;
  /** the shape of the place the face is shown in */
  aspect: "1:1" | "9:16" | "16:9";
};
export type Clip = { data: Buffer; mime: string; costUsd?: number };
export type AvatarVideoProvider = {
  id: string;
  /** what makes a clip different besides its inputs (model, key…): part of the cache key */
  fingerprint: string;
  animate(req: ClipRequest): Promise<Clip>;
  /** a portrait from words (the service only): the picture then lives in the kit like an uploaded one */
  portrait?(prompt: string, style?: string): Promise<Clip>;
};

export const avatarVideoDir = (kit: Kit) => path.join(kit.root, "avatar");
export const IMAGE_MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".avif": "image/avif", ".gif": "image/gif" };
export const imageMimeOf = (file: string) => IMAGE_MIME[path.extname(file).toLowerCase()] ?? "image/png";

/* ---- the Fantastico runtime key: minted from the Fantastico key, kept until it expires, dropped when refused ---- */
type Minted = { key: string; expiresAt: number };
const minted = new Map<string, Minted>();
function fantasticoBase(env: NodeJS.ProcessEnv) { return (env.FANTASTICO_BASE_URL ?? "https://fantastico.cc/api").replace(/\/$/, ""); }
function surfaceOf(apiKey: string): "runtime" | "edge" {
  if (apiKey.startsWith("sk-fant-")) return "runtime";
  if (apiKey.startsWith("ck-fant-")) return "edge";
  throw new Error('the Fantastico key is not recognised: a project key starts with "sk-fant-", an account key with "ck-fant-"');
}
export async function runtimeKey(env: NodeJS.ProcessEnv, f: typeof fetch, fresh = false): Promise<string> {
  const apiKey = env.FANTASTICO_API_KEY!;
  const have = minted.get(apiKey);
  if (!fresh && have && have.expiresAt - Date.now() > 60_000) return have.key;
  const r = await f(`${fantasticoBase(env)}/${surfaceOf(apiKey)}/key`, { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify(env.FANTASTICO_PRODUCT ? { product: env.FANTASTICO_PRODUCT } : {}) });
  if (!r.ok) {
    const body = (await r.json().catch(() => ({}))) as { message?: string; type?: string };
    if (r.status === 402 || /EXHAUSTED/.test(body.type ?? "")) throw new Error(`Fantastico credit exhausted. Recharge your credit at ${FANTASTICO_PORTAL}`);
    throw new Error(`Fantastico could not mint a key (${r.status}): ${body.message ?? ""}`);
  }
  const data = (await r.json()) as { runtimeKey: string; expiresAt: string };
  if (!data.runtimeKey) throw new Error("Fantastico minted no key");
  minted.set(apiKey, { key: data.runtimeKey, expiresAt: new Date(data.expiresAt).getTime() || Date.now() + 10 * 60_000 });
  return data.runtimeKey;
}

/* ---- the models' video API behind Fantastico, with the minted key: submit, poll, download ---- */
export const DEFAULT_AVATAR_MODEL = "heygen/avatar-iv";
export const DEFAULT_PORTRAIT_MODEL = "google/gemini-2.5-flash-image";
export function fantasticoAvatarProvider(env: NodeJS.ProcessEnv = process.env, options: { model?: string; portraitModel?: string; fetchImpl?: typeof fetch; pollMs?: number } = {}): AvatarVideoProvider | null {
  const apiKey = env.FANTASTICO_API_KEY;
  if (!apiKey) return null;
  const or = (env.FANTASTICO_MODELS_URL ?? "https://openrouter.ai/api/v1").replace(/\/$/, "");
  const f = options.fetchImpl ?? fetch;
  const model = options.model || env.CUEFLOW_AVATAR_MODEL || DEFAULT_AVATAR_MODEL;
  const portraitModel = options.portraitModel || env.CUEFLOW_PORTRAIT_MODEL || DEFAULT_PORTRAIT_MODEL;
  /* every call to the models runs with the key in hand; a refusal of the key (401/402) mints one more and tries once again */
  async function withKey<T>(run: (headers: Record<string, string>) => Promise<T>): Promise<T> {
    const headers = (k: string) => ({ Authorization: `Bearer ${k}`, "Content-Type": "application/json", "HTTP-Referer": "https://cueflow.fantastico.cc", "X-Title": "Cueflow" });
    try {
      return await run(headers(await runtimeKey(env, f)));
    } catch (e) {
      if (!(e instanceof RefusedKey)) throw e;
      return run(headers(await runtimeKey(env, f, true)));
    }
  }
  class RefusedKey extends Error {}
  const check = async (r: Response, what: string) => {
    if (r.ok) return;
    const body = await r.text().catch(() => "");
    if (r.status === 401 || r.status === 402) throw new RefusedKey(`Fantastico refused the key for ${what} (${r.status}): ${body.slice(0, 160)}`);
    throw new Error(`Fantastico ${what} failed (${r.status}): ${body.slice(0, 600)}`);
  };
  return {
    id: "fantastico",
    fingerprint: JSON.stringify(["fantastico", model, createHash("sha256").update(apiKey).digest("hex").slice(0, 16)]),
    async portrait(prompt, style) {
      return withKey(async (headers) => {
        const r = await f(`${or}/chat/completions`, { method: "POST", headers, body: JSON.stringify({ model: portraitModel, modalities: ["image", "text"], messages: [{ role: "user", content: `A portrait of a narrator for a product tutorial, head and shoulders, facing the camera, plain background${style ? `, ${style}` : ""}: ${prompt}` }] }) });
        await check(r, "portrait");
        const j = (await r.json()) as { choices?: { message?: { images?: { image_url?: { url?: string } }[] } }[] };
        const url = j.choices?.[0]?.message?.images?.[0]?.image_url?.url ?? "";
        const m = /^data:([^;,]+);base64,(.*)$/s.exec(url);
        if (!m) throw new Error(`the portrait model (${portraitModel}) returned no picture`);
        return { data: Buffer.from(m[2]!, "base64"), mime: m[1]! };
      });
    },
    async animate(req) {
      // the words come as audio (the tutorial's own voice) with the hold appended; the model lip-syncs to it
      const voice = await padAudio(req.audio, req.audioMime, req.silenceAfterMs);
      const modelOptions: Record<string, unknown> = req.background === "transparent" ? { remove_background: true } : { background: req.background };
      const body = {
        model,
        prompt: req.text,
        input_references: [
          { type: "image_url", image_url: { url: `data:${req.imageMime};base64,${req.image.toString("base64")}` } },
          { type: "audio_url", audio_url: { url: `data:audio/wav;base64,${voice.toString("base64")}` } }
        ],
        aspect_ratio: req.aspect,
        resolution: env.CUEFLOW_AVATAR_RESOLUTION ?? "720p",
        provider: { options: { [model.split("/")[0]!]: modelOptions } }
      };
      const { id } = await withKey(async (headers) => {
        const r = await f(`${or}/videos`, { method: "POST", headers, body: JSON.stringify(body) });
        await check(r, "video job");
        return (await r.json()) as { id: string };
      });
      if (!id) throw new Error("Fantastico returned no job id for the clip");
      const started = Date.now(), limit = 20 * 60 * 1000;
      for (;;) {
        const j = await withKey(async (headers) => { const r = await f(`${or}/videos/${encodeURIComponent(id)}`, { headers }); await check(r, "job status"); return (await r.json()) as { status: string; error?: unknown; usage?: { cost?: number } }; });
        if (j.status === "completed") {
          const data = await withKey(async (headers) => { const r = await f(`${or}/videos/${encodeURIComponent(id)}/content?index=0`, { headers }); await check(r, "clip download"); return Buffer.from(await r.arrayBuffer()); });
          return { data, mime: "video/mp4", costUsd: j.usage?.cost };
        }
        if (j.status === "failed" || j.status === "cancelled" || j.status === "expired") throw new Error(`Fantastico could not make the clip (${j.status}): ${typeof j.error === "string" ? j.error : JSON.stringify(j.error ?? "")}`);
        if (Date.now() - started > limit) throw new Error("the clip took more than 20 minutes: try again later");
        const wait: number = options.pollMs ?? 3000;
        await new Promise<void>((res) => setTimeout(res, wait));
      }
    }
  };
}

/* ---- a local program (LivePortrait, Wav2Lip, SadTalker…) through a command template, like Piper for the voices ---- */
const run = promisify(execFile);
const shellQuote = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
export function commandAvatarProvider(template: string, format: "mp4" | "webm" = "mp4"): AvatarVideoProvider {
  if (!/\{image\}|\{audio\}|\{out\}/.test(template)) throw new Error("CUEFLOW_AVATAR_COMMAND must use {image}, {audio} and {out} (optional {text}, {background}, {silence}, {aspect})");
  return {
    id: "command",
    fingerprint: JSON.stringify(["command", template, format]),
    async animate(req) {
      const dir = await mkdtemp(path.join(tmpdir(), "cueflow-avatar-"));
      try {
        const image = path.join(dir, "face" + (path.extname(Object.keys(IMAGE_MIME).find((e) => IMAGE_MIME[e] === req.imageMime) ?? ".png"))), audio = path.join(dir, "voice." + (req.audioMime.includes("wav") ? "wav" : "mp3")), text = path.join(dir, "text.txt"), out = path.join(dir, "clip." + format);
        await writeFile(image, req.image);
        await writeFile(audio, req.audio);
        await writeFile(text, req.text);
        const cmd = template
          .replace(/\{image\}/g, shellQuote(image)).replace(/\{audio\}/g, shellQuote(audio)).replace(/\{out\}/g, shellQuote(out)).replace(/\{text\}/g, shellQuote(text))
          .replace(/\{background\}/g, shellQuote(req.background)).replace(/\{silence\}/g, String(req.silenceAfterMs)).replace(/\{aspect\}/g, req.aspect);
        await run("sh", ["-c", cmd], { maxBuffer: 64 * 1024 * 1024 });
        const data = await readFile(out).catch(() => { throw new Error(`the avatar command produced no file at {out} (${out})`); });
        return { data, mime: format === "webm" ? "video/webm" : "video/mp4" };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  };
}

/** The provider for a resolved narrator, or null when it is not a generated one (svg, image, none). */
export function avatarVideoProviderFor(provider: string | undefined, env: NodeJS.ProcessEnv = process.env, model?: string): AvatarVideoProvider | null {
  if (provider === "fantastico") {
    const p = fantasticoAvatarProvider(env, { model });
    if (!p) throw new Error(`FANTASTICO_API_KEY is missing: put it in the kit's .env file, or get a key at ${FANTASTICO_PORTAL}`);
    return p;
  }
  if (provider === "command") {
    if (!env.CUEFLOW_AVATAR_COMMAND) throw new Error("CUEFLOW_AVATAR_COMMAND is missing: a command template with {image}, {audio} and {out}");
    return commandAvatarProvider(env.CUEFLOW_AVATAR_COMMAND, env.CUEFLOW_AVATAR_FORMAT === "webm" ? "webm" : "mp4");
  }
  return null;
}

const ext = (mime: string) => (mime.includes("webm") ? "webm" : "mp4");

/** The clip of one step, from the cache or made now; `made` tells whether the provider was called. */
export async function stepClip(kit: Kit, p: AvatarVideoProvider, req: ClipRequest, opts: { previewOnly?: boolean } = {}): Promise<{ clip: Clip; made: boolean } | null> {
  const hash = createHash("sha256")
    .update(p.fingerprint).update("\0").update(req.image).update("\0").update(req.audio).update("\0")
    .update(JSON.stringify([req.silenceAfterMs, req.background, req.aspect])).digest("hex").slice(0, 24);
  const dir = avatarVideoDir(kit);
  for (const e of ["mp4", "webm"]) {
    const data = await readFile(path.join(dir, `${hash}.${e}`)).catch(() => null);
    if (data) return { clip: { data, mime: e === "webm" ? "video/webm" : "video/mp4" }, made: false };
  }
  if (opts.previewOnly) return null; // a preview never spends credit
  const clip = await p.animate(req);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${hash}.${ext(clip.mime)}`);
  await writeFile(`${file}.tmp`, clip.data);
  await rename(`${file}.tmp`, file);
  return { clip, made: true };
}

/** The step's audio as a wav with silence appended (the hold): what the clip must cover. */
export async function padAudio(audio: Buffer, mime: string, silenceMs: number): Promise<Buffer> {
  const ffmpeg = await resolveFFmpeg();
  const dir = await mkdtemp(path.join(tmpdir(), "cueflow-pad-"));
  try {
    const src = path.join(dir, "voice." + (mime.includes("wav") ? "wav" : mime.includes("ogg") ? "ogg" : mime.includes("mp4") || mime.includes("m4a") ? "m4a" : "mp3")), out = path.join(dir, "padded.wav");
    await writeFile(src, audio);
    await run(ffmpeg, ["-y", "-i", src, "-af", `apad=pad_dur=${Math.max(0, silenceMs) / 1000}`, "-acodec", "pcm_s16le", "-ar", "24000", "-ac", "1", out]);
    return await readFile(out);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The shape a clip should have for the place the narrator is shown in. */
export function clipAspect(mode: string): ClipRequest["aspect"] {
  return mode === "side" ? "9:16" : mode === "band" || mode === "full" ? "16:9" : "1:1";
}
