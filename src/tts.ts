import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Kit } from "./kit.ts";
import { audioDir } from "./kit.ts";
import type { VoiceSpec } from "./settings.ts";

/**
 * Text-to-speech behind a small interface, with an on-disk cache. The file name is a hash of everything that
 * shapes the sound (provider, model, voice, language, text), so editing a text produces a new file and the same
 * text is never paid for twice. Without a provider the guides are built silent: captions only, timings estimated.
 */
export type TtsProvider = {
  id: string;
  /** Everything besides the text that changes the sound; part of the cache key. */
  fingerprint: string;
  /** the audio container the provider returns; mp3 when not given */
  format?: AudioFormat;
  synthesize(text: string, lang: string): Promise<Buffer>;
};

export type AudioFormat = "mp3" | "m4a" | "wav" | "ogg";
const MIME: Record<AudioFormat, string> = { mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", ogg: "audio/ogg" };
export const audioMime = (provider: TtsProvider) => MIME[provider.format ?? "mp3"];

const languageName = (lang: string) => new Intl.DisplayNames(["en"], { type: "language" }).of(lang) ?? lang;

export function openAiProvider(env: NodeJS.ProcessEnv = process.env, options: { voice?: string; model?: string; style?: string } = {}): TtsProvider | null {
  const key = env.OPENAI_API_KEY;
  if (!key) return null;
  const baseUrl = (env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const model = options.model ?? env.CUEFLOW_TTS_MODEL ?? "gpt-4o-mini-tts";
  const voice = options.voice ?? env.CUEFLOW_TTS_VOICE ?? "coral";
  const style = options.style;
  return {
    id: "openai",
    fingerprint: JSON.stringify(style ? [baseUrl, model, voice, style] : [baseUrl, model, voice]),
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
            ? { instructions: `Speak in ${languageName(lang)}. ${style ?? "Calm, clear and friendly, like the narrator of a product tutorial."}` }
            : {})
        })
      });
      if (!res.ok) throw new Error(`text-to-speech failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
      return Buffer.from(await res.arrayBuffer());
    }
  };
}

const run = promisify(execFile);
/** A value safe inside a POSIX shell command. */
const shellQuote = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;

/**
 * A local program as the voice, so that nobody needs an API key: CUEFLOW_TTS_COMMAND is a shell command with
 * placeholders {text} (a file holding the text), {out} (the file to write), {lang} and {voice}. The format of {out}
 * comes from CUEFLOW_TTS_FORMAT (mp3, m4a, wav, ogg; default wav). Example with Piper:
 *   CUEFLOW_TTS=command CUEFLOW_TTS_COMMAND='piper --model it_IT-paola-medium.onnx --output_file {out} < {text}'
 */
export function commandProvider(env: NodeJS.ProcessEnv = process.env, preset?: { id: string; command: string; format: AudioFormat; voice?: (lang: string) => Promise<string> }): TtsProvider {
  const command = preset?.command ?? env.CUEFLOW_TTS_COMMAND;
  if (!command) throw new Error("CUEFLOW_TTS=command needs CUEFLOW_TTS_COMMAND, a shell command with {text} and {out}, e.g. 'piper --model voice.onnx --output_file {out} < {text}'");
  if (!command.includes("{out}")) throw new Error(`CUEFLOW_TTS_COMMAND must write to {out}: "${command}"`);
  const format = preset?.format ?? ((env.CUEFLOW_TTS_FORMAT ?? "wav") as AudioFormat);
  if (!(format in MIME)) throw new Error(`unknown CUEFLOW_TTS_FORMAT "${format}" (expected mp3, m4a, wav or ogg)`);
  const fixedVoice = env.CUEFLOW_TTS_VOICE ?? "";
  return {
    id: preset?.id ?? "command",
    fingerprint: JSON.stringify([command, format, fixedVoice]),
    format,
    async synthesize(text, lang) {
      const dir = await mkdtemp(path.join(tmpdir(), "cueflow-tts-"));
      try {
        const textFile = path.join(dir, "text.txt");
        const out = path.join(dir, `out.${format}`);
        await writeFile(textFile, text);
        const voice = fixedVoice || (preset?.voice ? await preset.voice(lang) : "");
        const values: Record<string, string> = { text: textFile, out, lang, voice };
        const cmd = command.replace(/\{(text|out|lang|voice)\}/g, (_, k: string) => shellQuote(values[k]!));
        await run("/bin/sh", ["-c", cmd], { maxBuffer: 1 << 20 }).catch((e: Error & { stderr?: string }) => {
          throw new Error(`text-to-speech command failed: ${(e.stderr || e.message).trim().slice(0, 300)}\ncommand: ${cmd}`);
        });
        return await readFile(out).catch(() => {
          throw new Error(`text-to-speech command wrote nothing to {out}\ncommand: ${cmd}`);
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  };
}

/**
 * macOS's own voices (the `say` command), as AAC in m4a: free, offline, good enough to hear a guide with its real
 * timings. The voice is CUEFLOW_TTS_VOICE, or the first installed one for the language (say -v '?').
 */
export function sayProvider(env: NodeJS.ProcessEnv = process.env): TtsProvider {
  if (process.platform !== "darwin") throw new Error("CUEFLOW_TTS=say uses the macOS say command: on other systems use CUEFLOW_TTS=command (e.g. with Piper)");
  let voices: Promise<{ name: string; locale: string }[]> | null = null;
  const installed = () =>
    (voices ??= run("say", ["-v", "?"]).then(({ stdout }) =>
      stdout
        .split("\n")
        // "Alice (Italiano (Italia)) it_IT    # Ciao!" or "Albert              en_US    # Hello": name, locale, sample
        .map((l) => /^(.+?)\s+([a-z]{2,3}_[A-Za-z0-9]+)\s+#/.exec(l))
        .filter((m): m is RegExpExecArray => m !== null)
        .map((m) => ({ name: m[1]!.trim(), locale: m[2]!.replace("_", "-") }))
    ));
  return commandProvider(env, {
    id: "say",
    command: "say -v {voice} -f {text} -o {out} --file-format=m4af --data-format=aac",
    format: "m4a",
    voice: async (lang) => {
      const base = lang.toLowerCase().split(/[-_]/)[0]!;
      const v = (await installed()).find((x) => x.locale.toLowerCase().startsWith(base));
      if (!v) throw new Error(`no macOS voice for "${lang}": install one in System Settings > Accessibility > Spoken Content, or set CUEFLOW_TTS_VOICE`);
      return v.name;
    }
  });
}

/**
 * The provider chosen by CUEFLOW_TTS: openai, say (macOS voices), command (any local program, e.g. Piper) or none.
 * Having an OPENAI_API_KEY is not a choice: without CUEFLOW_TTS (or a voice set in cueflow.json) nothing is sent to a
 * paid service.
 */
export function defaultProvider(env: NodeJS.ProcessEnv = process.env): TtsProvider | null {
  const choice = env.CUEFLOW_TTS ?? "none";
  if (choice === "none") return null;
  if (choice === "openai") return openAiProvider(env);
  if (choice === "say") return sayProvider(env);
  if (choice === "command") return commandProvider(env);
  throw new Error(`unknown CUEFLOW_TTS "${choice}" (expected openai, say, command or none)`);
}

/** The provider for a voice chosen in cueflow.json. External voices are explicit: a missing key is an error, not a silent build. */
export function providerFromSpec(spec: VoiceSpec, env: NodeJS.ProcessEnv = process.env): TtsProvider | null {
  switch (spec.provider) {
    case "browser":
    case "none":
      return null;
    case "openai": {
      const p = openAiProvider(env, spec);
      if (!p) throw new Error('the voice is set to "openai" but OPENAI_API_KEY is missing: put it in the kit\'s .env file (OPENAI_API_KEY=sk-…) or choose another voice (get_voices lists them)');
      return p;
    }
    case "say":
      return sayProvider({ ...env, ...(spec.voice ? { CUEFLOW_TTS_VOICE: spec.voice } : {}) });
    case "command":
      return commandProvider({ ...env, CUEFLOW_TTS_COMMAND: spec.command, CUEFLOW_TTS_FORMAT: spec.format, ...(spec.voice ? { CUEFLOW_TTS_VOICE: spec.voice } : {}) });
  }
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

/** The audio for this text, from the cache or freshly generated (in the provider's format, mp3 by default). */
function cacheKey(kit: Kit, provider: TtsProvider, text: string, lang: string) {
  const spoken = text.replace(/\s+/g, " ").trim();
  const hash = createHash("sha256").update(JSON.stringify([provider.id, provider.fingerprint, lang, spoken])).digest("hex").slice(0, 40);
  return { spoken, hash, file: path.join(audioDir(kit), `${hash}.${provider.format ?? "mp3"}`) };
}

/** The audio of this text only if it was generated before: never calls the provider (previews must not cost anything). */
export async function cachedNarration(kit: Kit, provider: TtsProvider, text: string, lang: string): Promise<Buffer | null> {
  return readFile(cacheKey(kit, provider, text, lang).file).catch(() => null);
}

export async function narrationAudio(kit: Kit, provider: TtsProvider, text: string, lang: string): Promise<Buffer> {
  const { spoken, hash, file } = cacheKey(kit, provider, text, lang);
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
