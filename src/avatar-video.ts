import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Kit } from "./kit.ts";
import { FANTASTICO_PORTAL } from "./tts.ts";

/**
 * The narrator as a generated video: a picture of a person and the step's audio become a clip of that person saying
 * it (lips on the voice), one clip per step and per language, covering the narration AND the hold (the service gets
 * the silence after the words, so the face lives through the pause too; nothing is frozen or looped). Chosen like a
 * voice: `provider: "fantastico"` (the service, with the key of the voices) or `"command"` (a local program).
 * Cached under <kit>/avatar/ by content hash like the audio; only a changed step is generated again.
 */
export type ClipRequest = {
  /** the person: a picture of the kit (png/jpg) */
  image: Buffer;
  imageMime: string;
  /** what is said, with silence to add after it so the clip covers the whole step */
  audio: Buffer;
  audioMime: string;
  silenceAfterMs: number;
  /** a CSS colour, or "transparent" (a clip with alpha, when the provider can) */
  background: string;
  /** the shape the face is shown in: a square pip, a tall side panel, a wide band, the whole 16:9 picture */
  aspect: "1:1" | "9:16" | "16:9";
};
export type Clip = { data: Buffer; mime: string };
export type AvatarVideoProvider = {
  id: string;
  /** what makes a clip different besides its inputs (model, key…): part of the cache key */
  fingerprint: string;
  animate(req: ClipRequest): Promise<Clip>;
  /** a portrait from words (the service only): the picture then lives in the kit like an uploaded one */
  portrait?(prompt: string, style?: string): Promise<Clip>;
};

export const avatarVideoDir = (kit: Kit) => path.join(kit.root, "avatar");

/* ---- Fantastico: the service, over HTTP with the key of the voices, until the SDK has an `avatar` surface ----
 * Contract (what Cueflow sends and expects), under `${FANTASTICO_AVATAR_URL ?? https://fantastico.cc/api}/avatar`:
 *   POST /portrait  { prompt, style?, size }                                   → { image: base64, contentType }
 *   POST /animate   { image: base64, imageContentType, audio: base64, audioContentType, silenceAfterMs, background,
 *                     aspect, format: "webm" | "mp4", model? }                  → { job }
 *   GET  /jobs/:job                                                             → { status: "pending" | "processing" | "completed" | "failed", url?, error?, contentType? }
 *   GET  url                                                                    → the clip's bytes
 * Errors: 402 / ALLOWANCE_EXHAUSTED = credit to recharge at the portal. */
export function fantasticoAvatarProvider(env: NodeJS.ProcessEnv = process.env, options: { model?: string; fetchImpl?: typeof fetch; pollMs?: number } = {}): AvatarVideoProvider | null {
  const key = env.FANTASTICO_API_KEY;
  if (!key) return null;
  const base = (env.FANTASTICO_AVATAR_URL ?? "https://fantastico.cc/api").replace(/\/$/, "") + "/avatar";
  const f = options.fetchImpl ?? fetch;
  const headers = { Authorization: `Bearer ${key}`, "content-type": "application/json", "HTTP-Referer": "https://cueflow.fantastico.cc" };
  const fail = async (r: Response, what: string): Promise<never> => {
    const body = await r.text().catch(() => "");
    if (r.status === 402 || /ALLOWANCE_EXHAUSTED|FUNDS_EXHAUSTED/.test(body)) throw new Error(`Fantastico credit exhausted. Recharge your credit at ${FANTASTICO_PORTAL}`);
    throw new Error(`Fantastico ${what} failed (${r.status}): ${body.slice(0, 200)}`);
  };
  return {
    id: "fantastico",
    fingerprint: JSON.stringify(["fantastico", options.model ?? env.CUEFLOW_AVATAR_MODEL ?? "", createHash("sha256").update(key).digest("hex")]),
    async portrait(prompt, style) {
      const r = await f(`${base}/portrait`, { method: "POST", headers, body: JSON.stringify({ prompt, style, size: 1024 }) });
      if (!r.ok) await fail(r, "portrait");
      const j = (await r.json()) as { image: string; contentType?: string };
      if (!j.image) throw new Error("Fantastico returned no picture");
      return { data: Buffer.from(j.image, "base64"), mime: j.contentType ?? "image/png" };
    },
    async animate(req) {
      const r = await f(`${base}/animate`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          image: req.image.toString("base64"), imageContentType: req.imageMime,
          audio: req.audio.toString("base64"), audioContentType: req.audioMime,
          silenceAfterMs: req.silenceAfterMs, background: req.background, aspect: req.aspect,
          format: req.background === "transparent" ? "webm" : "mp4", model: options.model ?? env.CUEFLOW_AVATAR_MODEL
        })
      });
      if (!r.ok) await fail(r, "animate");
      const { job } = (await r.json()) as { job: string };
      if (!job) throw new Error("Fantastico returned no job id");
      const started = Date.now(), limit = 20 * 60 * 1000;
      for (;;) {
        const s = await f(`${base}/jobs/${encodeURIComponent(job)}`, { headers });
        if (!s.ok) await fail(s, "job status");
        const j = (await s.json()) as { status: string; url?: string; error?: string; contentType?: string };
        if (j.status === "completed" && j.url) {
          const c = await f(j.url, { headers });
          if (!c.ok) await fail(c, "clip download");
          return { data: Buffer.from(await c.arrayBuffer()), mime: j.contentType ?? c.headers.get("content-type") ?? "video/mp4" };
        }
        if (j.status === "failed") throw new Error(`Fantastico could not make the clip: ${j.error ?? "unknown error"}`);
        if (Date.now() - started > limit) throw new Error("Fantastico took more than 20 minutes for a clip: try again later");
        await new Promise((res) => setTimeout(res, options.pollMs ?? 3000));
      }
    }
  };
}

/* ---- a local program (LivePortrait, Wav2Lip, SadTalker…) through a command template, like Piper for the voices ---- */
const run = promisify(execFile);
const shellQuote = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
export function commandAvatarProvider(template: string, format: "mp4" | "webm" = "mp4"): AvatarVideoProvider {
  if (!/\{image\}|\{audio\}|\{out\}/.test(template)) throw new Error("CUEFLOW_AVATAR_COMMAND must use {image}, {audio} and {out} (optional {background}, {silence}, {aspect})");
  return {
    id: "command",
    fingerprint: JSON.stringify(["command", template, format]),
    async animate(req) {
      const dir = await mkdtemp(path.join(tmpdir(), "cueflow-avatar-"));
      try {
        const image = path.join(dir, "face." + (req.imageMime.includes("png") ? "png" : "jpg")), audio = path.join(dir, "voice." + (req.audioMime.includes("wav") ? "wav" : "mp3")), out = path.join(dir, "clip." + format);
        await writeFile(image, req.image);
        await writeFile(audio, req.audio);
        const cmd = template
          .replace(/\{image\}/g, shellQuote(image)).replace(/\{audio\}/g, shellQuote(audio)).replace(/\{out\}/g, shellQuote(out))
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
    const file = path.join(dir, `${hash}.${e}`);
    const data = await readFile(file).catch(() => null);
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

/** The shape a clip should have for the place the narrator is shown in. */
export function clipAspect(mode: string): ClipRequest["aspect"] {
  return mode === "side" ? "9:16" : mode === "band" || mode === "full" ? "16:9" : "1:1";
}
