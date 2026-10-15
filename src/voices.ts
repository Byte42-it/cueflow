import { readFile } from "node:fs/promises";
import { writeAtomic } from "./build.ts";
import { listGuides, loadGuide, openKit, type Kit } from "./kit.ts";
import { resolveVoice, Settings, settingsFile, VoiceSpec as VoiceSpecSchema, type VoiceSource, type VoiceSpec } from "./settings.ts";
import { defaultProvider, providerFromSpec, type TtsProvider } from "./tts.ts";

export type ResolvedVoice = { spec: VoiceSpec; source: VoiceSource; provider: TtsProvider | null; browser: boolean };

/**
 * The voice for a video in a language. cueflow.json decides (video > language > global); when it decides nothing,
 * an explicit CUEFLOW_TTS in the environment still applies, and otherwise the browser's voice is used.
 */
export function voiceFor(kit: Kit, guideId: string, lang: string, env: NodeJS.ProcessEnv = process.env): ResolvedVoice {
  const { spec, source } = resolveVoice(kit.settings, guideId, lang);
  if (source === "default" && env.CUEFLOW_TTS && env.CUEFLOW_TTS !== "none") {
    return { spec, source, provider: defaultProvider(env), browser: false };
  }
  return { spec, source, provider: providerFromSpec(spec, env), browser: spec.provider === "browser" };
}

/** The choices, in words a person can choose from. Studio shows these; the assistant reads them with get_voices. */
export function voiceOptions(env: NodeJS.ProcessEnv = process.env) {
  const hasKey = Boolean(env.OPENAI_API_KEY);
  return [
    {
      provider: "browser",
      title: "Browser voice",
      summary: "Free, nothing to set up. The viewer's browser reads the text, so the voice differs from computer to computer and nothing is stored with the video.",
      needs: "nothing",
      cost: "free",
      available: true
    },
    {
      provider: "openai",
      title: "OpenAI voice (external service)",
      summary: "Natural, the same on every computer; the audio is generated once and stored with the video. The text of the narration is sent to OpenAI.",
      needs: "OPENAI_API_KEY in the kit's .env file",
      cost: "pay per use, only when a text is new or changed",
      available: hasKey,
      voices: ["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse"],
      models: ["gpt-4o-mini-tts", "tts-1"],
      style: "free text, e.g. 'calm and professional'"
    },
    {
      provider: "say",
      title: "macOS voices",
      summary: "Free and offline, stored with the video. Good to hear timings; only on a Mac.",
      needs: "macOS",
      cost: "free",
      available: process.platform === "darwin"
    },
    {
      provider: "command",
      title: "A program on this computer (e.g. Piper)",
      summary: "Any local text-to-speech program, no key, nothing leaves the computer. You give the command line.",
      needs: "the program installed",
      cost: "free",
      available: true
    },
    { provider: "none", title: "Silent", summary: "No audio: the tutorial shows captions only.", needs: "nothing", cost: "free", available: true }
  ];
}

/** Which voice every video speaks with in each of its languages, and where that choice comes from. */
export async function voiceTable(kit: Kit, env: NodeJS.ProcessEnv = process.env) {
  const rows: { guide: string; language: string; provider: string; voice?: string; from: string }[] = [];
  for (const id of await listGuides(kit)) {
    const guide = await loadGuide(kit, id);
    for (const lang of guide.languages) {
      const { spec, source } = resolveVoice(kit.settings, id, lang);
      const envChoice = source === "default" && env.CUEFLOW_TTS && env.CUEFLOW_TTS !== "none" ? env.CUEFLOW_TTS : undefined;
      rows.push({ guide: id, language: lang, provider: envChoice ?? spec.provider, voice: "voice" in spec ? spec.voice : undefined, from: envChoice ? "CUEFLOW_TTS (environment)" : source });
    }
  }
  return rows;
}

/** cueflow.json as written on disk (not normalised), so a change touches only what was asked and nothing else grows in it. */
export async function readRawSettings(kit: Kit): Promise<Record<string, any>> {
  try {
    return JSON.parse(await readFile(settingsFile(kit.root), "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`cueflow.json is not valid JSON: ${e instanceof Error ? e.message : e}`);
  }
}

/** Validates and writes cueflow.json, then refreshes the kit's view of it (outDir, voices). */
export async function writeRawSettings(kit: Kit, raw: Record<string, unknown>): Promise<void> {
  Settings.parse(raw);
  await writeAtomic(settingsFile(kit.root), JSON.stringify(raw, null, 2) + "\n");
  Object.assign(kit, openKit(kit.root));
}

export type VoiceTarget = { scope: "global" } | { scope: "language"; language: string } | { scope: "video"; guide: string; language?: string };

/**
 * Chooses a voice at one level, or (voice null) clears it so that the level above applies. Levels are inherited:
 * a video's voice wins over its language's, which wins over the global one, which wins over the browser's.
 */
export async function setVoice(kit: Kit, target: VoiceTarget, voice: unknown | null): Promise<void> {
  const spec = voice === null ? null : VoiceSpecSchema.parse(voice);
  if (target.scope === "video" && !(await listGuides(kit)).includes(target.guide)) {
    throw new Error(`guide "${target.guide}" does not exist (available: ${(await listGuides(kit)).join(", ") || "none"})`);
  }
  const raw = await readRawSettings(kit);
  const voices = ((raw.voices ??= {}) as Record<string, any>);
  const put = (holder: Record<string, any>, key: string) => {
    if (spec) holder[key] = spec;
    else delete holder[key];
  };
  if (target.scope === "global") put(voices, "default");
  else if (target.scope === "language") put((voices.languages ??= {}), target.language);
  else {
    const guides = (voices.guides ??= {}) as Record<string, any>;
    const own = (guides[target.guide] ??= {}) as Record<string, any>;
    if (target.language) put((own.languages ??= {}), target.language);
    else put(own, "default");
    if (!own.default && Object.keys(own.languages ?? {}).length === 0) delete guides[target.guide];
  }
  await writeRawSettings(kit, raw);
}
