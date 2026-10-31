import { Fantastico, FantasticoError } from "@byte-42/fantastico-sdk";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Kit } from "./kit.ts";
import { audioDir } from "./kit.ts";
import { spokenVoice, type VoiceSpec } from "./settings.ts";

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

export const FANTASTICO_PORTAL = "https://cueflow.fantastico.cc";

let activeClient: { key: string; client: Fantastico } | undefined;
export function fantasticoClient(env: NodeJS.ProcessEnv = process.env): Fantastico {
  const key = env.FANTASTICO_API_KEY;
  if (!key) throw new Error(`FANTASTICO_API_KEY is missing: put it in the kit's .env file, or get a key at ${FANTASTICO_PORTAL}`);
  if (activeClient?.key !== key) activeClient = { key, client: new Fantastico({ apiKey: key }) };
  return activeClient.client;
}

/** Preserve the SDK's credit errors across Studio, CLI and MCP. Never expose upstream provider details. */
export function fantasticoError(error: unknown): Error {
  if (error instanceof FantasticoError && (error.status === 402 || ["ALLOWANCE_EXHAUSTED", "PROJECT_FUNDS_EXHAUSTED"].includes(error.code))) {
    return new FantasticoError(`Fantastico credit exhausted. Recharge your credit at ${FANTASTICO_PORTAL}`, error.code, 402);
  }
  return error instanceof Error ? error : new Error(String(error));
}

export async function speechModels(env: NodeJS.ProcessEnv = process.env) {
  try {
    const models = await fantasticoClient(env).audio.speech.models();
    // Models requiring a reference recording cannot be chosen with a voice selector.
    return models.filter((model) => model.supported_voices?.length).map((model) => ({
      id: model.id, name: model.name, voices: model.supported_voices!, pricing: model.pricing
    }));
  } catch (error) { throw fantasticoError(error); }
}

/** Account keys have one balance; project keys can cover multiple separate accounts. */
export async function keyCredit(env: NodeJS.ProcessEnv = process.env) {
  if (!env.FANTASTICO_API_KEY) return { available: false as const, reason: "Connect a Fantastico key to view your credit." };
  const client = fantasticoClient(env);
  if (client.surface !== "edge") return { available: false as const, reason: "Credit is available for account keys (ck-fant-…). For project keys, check the Fantastico portal." };
  try {
    const balance = await client.balance();
    return { available: true as const, remainingUsd: balance.remainingUsd, lowBalance: balance.lowBalance, status: balance.status };
  } catch (error) { throw fantasticoError(error); }
}

/** The cache always stores a playable WAV, including when the model returns raw PCM. */
export async function speechWav(audio: Uint8Array, contentType: string): Promise<Buffer> {
  const mime = contentType.split(";")[0]!.trim().toLowerCase();
  if (mime === "audio/wav" || mime === "audio/x-wav") return Buffer.from(audio);
  if (mime === "audio/pcm" || mime === "audio/l16") {
    if (mime === "audio/l16") throw new Error("Fantastico returned unsupported big-endian PCM audio");
    const rate = Number(/(?:^|;)\s*rate=(\d+)/i.exec(contentType)?.[1]);
    const channels = Number(/(?:^|;)\s*channels=(\d+)/i.exec(contentType)?.[1]);
    if (!Number.isInteger(rate) || rate < 8000 || rate > 192000 || !Number.isInteger(channels) || channels < 1 || channels > 8 || audio.byteLength % (channels * 2)) {
      throw new Error("Fantastico returned PCM audio without valid sample rate or channels");
    }
    const header = Buffer.alloc(44);
    header.write("RIFF", 0); header.writeUInt32LE(36 + audio.byteLength, 4); header.write("WAVEfmt ", 8);
    header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * channels * 2, 28);
    header.writeUInt16LE(channels * 2, 32); header.writeUInt16LE(16, 34);
    header.write("data", 36); header.writeUInt32LE(audio.byteLength, 40);
    return Buffer.concat([header, audio]);
  }
  if (!["audio/mpeg", "audio/mp3", "audio/ogg", "audio/mp4"].includes(mime)) throw new Error(`Fantastico returned unsupported audio: ${contentType}`);
  const dir = await mkdtemp(path.join(tmpdir(), "cueflow-speech-"));
  try {
    const input = path.join(dir, "speech"), output = path.join(dir, "speech.wav");
    await writeFile(input, audio);
    const { resolveFFmpeg } = await import("./video.ts");
    await run(await resolveFFmpeg(), ["-y", "-i", input, "-c:a", "pcm_s16le", output], { windowsHide: true });
    return await readFile(output);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

export function fantasticoProvider(
  env: NodeJS.ProcessEnv = process.env,
  options: { voice?: string; model?: string; style?: string } = {},
  client: () => Pick<Fantastico, "audio"> = () => fantasticoClient(env)
): TtsProvider | null {
  if (!env.FANTASTICO_API_KEY) return null;
  const model = options.model ?? env.CUEFLOW_TTS_MODEL;
  const voice = options.voice ?? env.CUEFLOW_TTS_VOICE;
  if (!model || !voice) throw new Error("Choose a Fantastico speech model and voice in Studio's audio settings (or set CUEFLOW_TTS_MODEL and CUEFLOW_TTS_VOICE)");
  return {
    id: "fantastico",
    format: "wav",
    fingerprint: JSON.stringify([model, voice, options.style, createHash("sha256").update(env.FANTASTICO_API_KEY).digest("hex")]),
    async synthesize(text, lang) {
      try {
        const result = await client().audio.speech.create({
          model, voice, input: text,
          instructions: `Speak in ${languageName(lang)}. ${options.style || "Calm, clear and friendly, like the narrator of a product tutorial."}`
        });
        if (!result.audio.byteLength) throw new Error("Fantastico returned empty audio");
        return await speechWav(result.audio, result.contentType);
      } catch (error) { throw fantasticoError(error); }
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
 * The provider chosen by CUEFLOW_TTS: fantastico, say (macOS voices), command (any local program, e.g. Piper) or none.
 * Having a FANTASTICO_API_KEY is not a choice: without CUEFLOW_TTS (or a voice set in cueflow.json) nothing is sent to a
 * paid service.
 */
export function defaultProvider(env: NodeJS.ProcessEnv = process.env): TtsProvider | null {
  const choice = env.CUEFLOW_TTS ?? "none";
  if (choice === "none") return null;
  if (choice === "fantastico") return providerFromSpec({ provider: "fantastico", model: env.CUEFLOW_TTS_MODEL ?? "", voice: env.CUEFLOW_TTS_VOICE ?? "" }, env);
  if (choice === "say") return sayProvider(env);
  if (choice === "command") return commandProvider(env);
  throw new Error(`unknown CUEFLOW_TTS "${choice}" (expected fantastico, say, command or none)`);
}

/** The provider for a voice chosen in cueflow.json. External voices are explicit: a missing key is an error, not a silent build. */
export function providerFromSpec(spec: VoiceSpec, env: NodeJS.ProcessEnv = process.env): TtsProvider | null {
  if (spec.provider === "narrator") return providerFromSpec(spokenVoice(spec), env); // the clips carry their own voice; this reads the other steps
  switch (spec.provider) {
    case "browser":
    case "none":
      return null;
    case "fantastico": {
      const p = fantasticoProvider(env, spec);
      if (!p) throw new Error(`FANTASTICO_API_KEY is missing: put it in the kit's .env file, or get a key at ${FANTASTICO_PORTAL}`);
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
