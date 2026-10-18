import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

/**
 * cueflow.json in the kit: how the tool behaves for this project (where the output goes, which voice reads the
 * tutorials). What was agreed about the content lives in brief.json; this file is about the machinery.
 */

/** One way of speaking. `browser` is the default: free, no key, but it sounds different on every computer. */
export const VoiceSpec = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("browser") }).describe("the voice of the viewer's browser: free, no key, differs from computer to computer"),
  z.object({ provider: z.literal("none") }).describe("silent: captions only"),
  z.object({
    provider: z.literal("fantastico"),
    voice: z.string().min(1).describe("a supported voice from the Fantastico speech model catalogue"),
    model: z.string().min(1).describe("the model id from Fantastico audio.speech.models()"),
    style: z
      .string()
      .optional()
      // a key pasted here would be saved in cueflow.json (versioned) and sent to the service as spoken instructions
      .refine((s) => !s || !/^(?:sk-[\w-]{16,}|ck-fant-[\w-]+)$/.test(s.trim()), { message: "the style is how the voice should speak, not the API key: the key goes in the kit's .env file (FANTASTICO_API_KEY=ck-fant-…), or in the key field of the voice form" })
      .describe("how it should speak, e.g. 'calm, like a colleague explaining to a lawyer' (when supported by the model)")
  }),
  z.object({ provider: z.literal("say"), voice: z.string().optional().describe("a macOS voice; default: the first installed one for the language") }),
  z.object({
    provider: z.literal("command"),
    command: z.string().describe("shell command with {text} (file with the text), {out}, {lang}, {voice}, e.g. a Piper call"),
    format: z.enum(["mp3", "m4a", "wav", "ogg"]).default("wav"),
    voice: z.string().optional()
  })
]);
export type VoiceSpec = z.infer<typeof VoiceSpec>;

/** A voice for everything in the scope, and/or one per language. */
export const VoiceScope = z.object({
  default: VoiceSpec.optional(),
  languages: z.record(VoiceSpec).default({})
});
export type VoiceScope = z.infer<typeof VoiceScope>;

export const Settings = z.object({
  outDir: z
    .string()
    .default("dist")
    .describe("where the built guides and the docs site go, relative to the kit folder; `cueflow init` sets it once (default for a project: ../cueflow-dist)"),
  voices: z
    .object({
      default: VoiceSpec.optional().describe("the global voice"),
      languages: z.record(VoiceSpec).default({}).describe("a voice for every video in a language"),
      guides: z.record(VoiceScope).default({}).describe("a voice for one video only (all its languages, or one by language)")
    })
    .default({})
});
export type Settings = z.infer<typeof Settings>;

export const settingsFile = (root: string) => path.join(root, "cueflow.json");

/** Reading old project files must never call a retired service or select a paid voice on its own. */
export function migrateLegacyVoices(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(migrateLegacyVoices);
  if (!value || typeof value !== "object") return value;
  const object = value as Record<string, unknown>;
  if (object.provider === "openai") return { provider: "browser" };
  return Object.fromEntries(Object.entries(object).map(([key, child]) => [key, migrateLegacyVoices(child)]));
}

export function migrateVoiceSettings(raw: Record<string, unknown>): Record<string, unknown> {
  return raw.voices ? { ...raw, voices: migrateLegacyVoices(raw.voices) } : raw;
}

const warnedLegacyRoots = new Set<string>();

/** Synchronous because `openKit` needs the output folder right away. A kit without the file gets the defaults. */
export function readSettingsSync(root: string): Settings {
  let raw: string;
  try {
    raw = readFileSync(settingsFile(root), "utf8");
  } catch {
    return Settings.parse({});
  }
  try {
    const original = JSON.parse(raw);
    const migrated = migrateVoiceSettings(original);
    const settings = Settings.parse(migrated);
    if (JSON.stringify(original) !== JSON.stringify(migrated) && !warnedLegacyRoots.has(root)) {
      warnedLegacyRoots.add(root);
      console.warn("Cueflow: old OpenAI voice choices now use the free browser voice. Choose professional voices in Settings → General audio settings with a Fantastico key from https://cueflow.fantastico.cc.");
    }
    return settings;
  } catch (e) {
    throw new Error(`cueflow.json is not valid: ${e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : e instanceof Error ? e.message : e}`);
  }
}

export type VoiceSource = "video" | "video-language" | "language" | "global" | "default";

/**
 * The voice a video speaks with in a language, most specific first: the video's own voice for that language, the
 * video's own voice, the language's voice, the global voice, and finally the browser's. Nothing set means the
 * level above is inherited.
 */
export function resolveVoice(settings: Settings, guideId: string, lang: string): { spec: VoiceSpec; source: VoiceSource } {
  const v = settings.voices;
  const own = v.guides[guideId];
  if (own?.languages[lang]) return { spec: own.languages[lang]!, source: "video-language" };
  if (own?.default) return { spec: own.default, source: "video" };
  if (v.languages[lang]) return { spec: v.languages[lang]!, source: "language" };
  if (v.default) return { spec: v.default, source: "global" };
  return { spec: { provider: "browser" }, source: "default" };
}
