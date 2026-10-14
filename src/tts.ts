import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Kit } from "./kit.ts";
import { audioDir } from "./kit.ts";

/**
 * Text-to-speech behind a small interface, with an on-disk cache. The file name is a hash of everything that
 * shapes the sound (provider, model, voice, language, text), so editing a text produces a new file and the same
 * text is never paid for twice. Without a provider the guides are built silent: captions only, timings estimated.
 */
export type TtsProvider = {
  id: string;
  /** Everything besides the text that changes the sound; part of the cache key. */
  fingerprint: string;
  synthesize(text: string, lang: string): Promise<Buffer>;
};

const languageName = (lang: string) => new Intl.DisplayNames(["en"], { type: "language" }).of(lang) ?? lang;

export function openAiProvider(env: NodeJS.ProcessEnv = process.env): TtsProvider | null {
  const key = env.OPENAI_API_KEY;
  if (!key) return null;
  const baseUrl = (env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const model = env.CUEFLOW_TTS_MODEL ?? "gpt-4o-mini-tts";
  const voice = env.CUEFLOW_TTS_VOICE ?? "coral";
  return {
    id: "openai",
    fingerprint: JSON.stringify([baseUrl, model, voice]),
    async synthesize(text, lang) {
      const res = await fetch(`${baseUrl}/audio/speech`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({
          model,
          voice,
          input: text,
          response_format: "mp3",
          ...(model.startsWith("gpt-4o")
            ? { instructions: `Speak in ${languageName(lang)}, in a calm, clear and friendly voice, like the narrator of a product tutorial.` }
            : {})
        })
      });
      if (!res.ok) throw new Error(`text-to-speech failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
      return Buffer.from(await res.arrayBuffer());
    }
  };
}

/** The provider chosen by CUEFLOW_TTS ("openai" | "none"); by default OpenAI when a key is present, else none. */
export function defaultProvider(env: NodeJS.ProcessEnv = process.env): TtsProvider | null {
  const choice = env.CUEFLOW_TTS ?? "auto";
  if (choice === "none") return null;
  if (choice === "openai" || choice === "auto") return openAiProvider(env);
  throw new Error(`unknown CUEFLOW_TTS "${choice}" (expected openai or none)`);
}

/**
 * The text the voice actually reads: the guide's pronunciation entries replaced as whole words (a short entry must
 * not change the inside of a longer word). Captions keep the written form.
 */
export function spokenText(text: string, pronunciation: Record<string, string> = {}): string {
  let out = text;
  for (const [written, said] of Object.entries(pronunciation)) {
    if (!written) continue;
    const escaped = written.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "gu"), said);
  }
  return out;
}

const inFlight = new Map<string, Promise<Buffer>>();

/** The mp3 for this text, from the cache or freshly generated. */
export async function narrationAudio(kit: Kit, provider: TtsProvider, text: string, lang: string): Promise<Buffer> {
  const spoken = text.replace(/\s+/g, " ").trim();
  const hash = createHash("sha256").update(JSON.stringify([provider.id, provider.fingerprint, lang, spoken])).digest("hex").slice(0, 40);
  const file = path.join(audioDir(kit), `${hash}.mp3`);
  try {
    return await readFile(file);
  } catch {
    // not generated yet
  }
  let job = inFlight.get(hash);
  if (!job) {
    job = (async () => {
      const audio = await provider.synthesize(spoken, lang);
      await mkdir(audioDir(kit), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, audio);
      await rename(tmp, file); // never leave a half-written file where readers look
      return audio;
    })().finally(() => inFlight.delete(hash));
    inFlight.set(hash, job);
  }
  return job;
}
