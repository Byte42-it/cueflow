import { readFile } from "node:fs/promises";
import path from "node:path";
import { writeAtomic } from "./build.ts";
import { listGuides, loadGuide, openKit, type Kit } from "./kit.ts";
import { migrateVoiceSettings, resolveVoice, Settings, settingsFile, VoiceSpec as VoiceSpecSchema, type VoiceSource, type VoiceSpec } from "./settings.ts";
import { audioMime, cachedNarration, defaultProvider, narrationAudio, providerFromSpec, spokenText, type TtsProvider } from "./tts.ts";
import { loadBrief } from "./brief.ts";
import type { Guide, Step } from "./schema.ts";

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
  const hasKey = Boolean(env.FANTASTICO_API_KEY);
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
      provider: "fantastico",
      title: "Professional voices · Fantastico",
      summary: "Natural, the same on every computer; the audio is generated once and stored with the video. Uses your Fantastico credit.",
      needs: "FANTASTICO_API_KEY in the kit's .env file",
      cost: "Fantastico credit, only when a text is new or changed",
      available: hasKey,
      portal: "https://cueflow.fantastico.cc",
      catalogue: "/api/speech-models",
      style: "free text, e.g. 'calm and professional'"
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
    for (const step of guide.steps) {
      for (const [lang, own] of Object.entries(step.voice ?? {})) {
        rows.push({ guide: `${id} · ${step.id}`, language: lang, provider: own.provider, voice: "voice" in own ? own.voice : undefined, from: "step" });
      }
    }
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
    return migrateVoiceSettings(JSON.parse(await readFile(settingsFile(kit.root), "utf8")));
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
    if (target.language) {
      // Expand a legacy tutorial-wide override before editing a single language.
      // Auto for that language must reach the project while other languages keep their sound.
      if (own.default) {
        const languages = (own.languages ??= {});
        for (const language of (await loadGuide(kit, target.guide)).languages) {
          if (language !== target.language && !languages[language]) languages[language] = own.default;
        }
        delete own.default;
      }
      put((own.languages ??= {}), target.language);
    }
    else put(own, "default");
    if (!own.default && Object.keys(own.languages ?? {}).length === 0) delete guides[target.guide];
  }
  await writeRawSettings(kit, raw);
}

const FILE_MIME: Record<string, string> = { ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".wav": "audio/wav", ".ogg": "audio/ogg", ".aac": "audio/aac" };

/** An audio file the guide points at, read from inside the kit (never from outside it). */
async function kitAudioFile(kit: Kit, file: string): Promise<{ data: Buffer; mime: string }> {
  const abs = path.resolve(kit.root, file);
  if (abs !== kit.root && !abs.startsWith(kit.root + path.sep)) throw new Error(`the audio file "${file}" is outside the kit`);
  const mime = FILE_MIME[path.extname(abs).toLowerCase()];
  if (!mime) throw new Error(`the audio file "${file}" must be mp3, m4a, wav, ogg or aac`);
  return { data: await readFile(abs), mime };
}

/**
 * The sound of one step in one language, or null when it has none (silent, muted, or read by the browser).
 * The step's own voice wins over the project's. `provider`: undefined = the voices of cueflow.json, generating what is
 * missing; null = a preview: the same voices but only audio that already exists, so nothing is ever paid for; a provider
 * = that one for every step without an audio file of its own.
 */
export async function stepAudio(kit: Kit, guide: Guide, step: Step, lang: string, provider?: TtsProvider | null): Promise<{ data: Buffer; mime: string } | null> {
  const own = step.voice?.[lang];
  if (own?.provider === "file") return kitAudioFile(kit, own.file);
  const text = step.narration[lang]?.trim();
  if (!text || own?.provider === "none" || own?.provider === "browser") return null;
  const preview = provider === null;
  let p: TtsProvider | null;
  try {
    p = provider ? provider : own ? providerFromSpec(own) : voiceFor(kit, guide.id, lang).provider;
  } catch (e) {
    if (preview) return null; // a missing key must not break a preview
    throw e;
  }
  if (!p) return null;
  const brief = await loadBrief(kit);
  const spoken = spokenText(text, { ...brief.pronunciation, ...guide.pronunciation });
  const data = preview ? await cachedNarration(kit, p, spoken, lang) : await narrationAudio(kit, p, spoken, lang);
  return data ? { data, mime: audioMime(p) } : null;
}
