import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { distFile, loadGuide, sceneFile, sceneFileFor, type Kit } from "./kit.ts";
import { inlineScene, type Shared } from "./scene.ts";
import type { Guide } from "./schema.ts";
import { loadTheme } from "./theme.ts";
import { loadBrief } from "./brief.ts";
import { voiceFor } from "./voices.ts";
import { audioMime, narrationAudio, spokenText, type TtsProvider } from "./tts.ts";
import { validateGuide } from "./validate.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

/** JSON that is safe inside a <script> element. */
export const embed = (value: unknown): string => JSON.stringify(value).replace(/</g, "\\u003c");
export const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** Text that is safe inside a <script> or <style> element. */
export const rawText = (s: string, tag: "script" | "style") => s.replace(new RegExp(`</${tag}`, "gi"), `<\\/${tag}`);

export type BuildResult = { file: string; scenes: string[]; audioFiles: number; silent: boolean; warnings: string[] };

/** What the player needs to run a guide: the guide, its scenes inlined, its audio as data URIs. */
export type GuideBundle = {
  guide: Guide;
  data: {
    guide: Guide;
    scenes: Record<string, string>;
    sceneLang: Record<string, Record<string, string>>;
    /** stylesheets and images shared by the scenes, once each (see Shared in scene.ts) */
    shared: Shared;
    audio: Record<string, Record<string, string>>;
  };
  scenes: string[];
  audioFiles: number;
  warnings: string[];
};

export async function guideBundle(kit: Kit, id: string, provider?: TtsProvider | null): Promise<GuideBundle> {
  const guide = await loadGuide(kit, id);
  const report = await validateGuide(kit, guide);
  if (report.errors.length) throw new Error(`the guide "${id}" is not valid:\n- ${report.errors.join("\n- ")}`);

  // every scene the guide visits, in order
  const names: string[] = [guide.scene];
  for (const s of guide.steps) if (s.scene && !names.includes(s.scene)) names.push(s.scene);
  const scenes: Record<string, string> = {};
  const shared: Shared = {};
  for (const n of names) scenes[n] = await inlineScene(kit, n, undefined, shared);
  // translated screens: only the languages that have their own version of a scene
  const sceneLang: Record<string, Record<string, string>> = {};
  for (const lang of guide.languages) {
    for (const n of names) {
      if ((await sceneFileFor(kit, n, lang)) === sceneFile(kit, n)) continue;
      (sceneLang[lang] ??= {})[n] = await inlineScene(kit, n, lang, shared);
    }
  }

  const audio: Record<string, Record<string, string>> = {};
  let audioFiles = 0;
  const brief = await loadBrief(kit);
  // `provider` undefined: each language speaks with the voice cueflow.json gives it; null: silent (previews); a provider: forced
  let browserVoice = false;
  for (const lang of guide.languages) {
    const voice = provider === undefined ? voiceFor(kit, id, lang) : null;
    const p = provider === undefined ? voice!.provider : provider;
    if (voice?.browser) browserVoice = true;
    if (p) {
      audio[lang] = {};
      for (const step of guide.steps) {
        const text = step.narration[lang]?.trim();
        if (!text) continue;
        const sound = await narrationAudio(kit, p, spokenText(text, { ...brief.pronunciation, ...guide.pronunciation }), lang);
        audio[lang]![step.id] = `data:${audioMime(p)};base64,${sound.toString("base64")}`;
        audioFiles += 1;
      }
    }
  }
  // a language without a recorded voice is read by the viewer's browser when that is what was chosen for it
  if (browserVoice) guide.player = { ...guide.player, fallbackVoice: "browser" };
  return { guide, data: { guide, scenes, sceneLang, shared, audio }, scenes: names, audioFiles, warnings: report.warnings };
}

const MS_PER_CHAR = 65; // as in the player: narration length estimate when there is no audio

/**
 * How long a guide plays in a language, in ms, computed like the player does for a silent build: each step lasts
 * its narration (estimated from its length) or until its last action ends, whichever is later, plus its hold.
 */
export function estimateStepDuration(step: Guide["steps"][number], lang: string): { narration: number; total: number } {
  const text = step.narration[lang] ?? "";
  const narr = Math.max(1500, text.length * MS_PER_CHAR);
  let end = 0;
  for (const a of step.actions) {
    const at = typeof a.at === "string" ? (parseFloat(a.at) / 100) * narr : a.at;
    end = Math.max(end, at + ("duration" in a ? a.duration : a.do === "click" ? 350 : 0));
  }
  return { narration: narr, total: Math.max(narr, end) + step.hold };
}

export function estimateDuration(guide: Guide, lang = guide.languages[0]!): number {
  return guide.steps.reduce((sum, step) => sum + estimateStepDuration(step, lang).total, 0);
}

/** The player's script and stylesheet, with the kit's theme after the defaults. */
export async function playerAssets(kit: Kit) {
  const [js, css, theme] = await Promise.all([
    readFile(path.join(here, "player", "player.js"), "utf8"),
    readFile(path.join(here, "player", "player.css"), "utf8"),
    loadTheme(kit)
  ]);
  return { js, css, theme };
}

export async function writeAtomic(file: string, content: string | Buffer): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, content);
  await rename(tmp, file); // never leave a half-written file where readers look
}

/** The page of a guide, as a string. `browserVoice` makes a silent build read its narration with the browser's voice (previews). */
export async function renderGuideHtml(kit: Kit, id: string, provider?: TtsProvider | null, opts: { browserVoice?: boolean } = {}) {
  const bundle = await guideBundle(kit, id, provider);
  if (opts.browserVoice) bundle.guide.player = { ...bundle.guide.player, fallbackVoice: "browser" };
  const { js, css, theme } = await playerAssets(kit);
  const styles = theme.css ? `${css}\n/* kit theme */\n${theme.css}` : css;
  return { bundle, html: pageHtml(bundle.guide, styles, js, { ...bundle.data, labels: theme.labels }) };
}

/** Builds guides/<id>.json into <output>/<id>.html: one self-contained file with player, scenes, timeline and audio. */
export async function buildGuide(kit: Kit, id: string, provider?: TtsProvider | null): Promise<BuildResult> {
  const { bundle, html } = await renderGuideHtml(kit, id, provider);
  const file = distFile(kit, id);
  await writeAtomic(file, html);
  return { file, scenes: bundle.scenes, audioFiles: bundle.audioFiles, silent: bundle.audioFiles === 0, warnings: bundle.warnings };
}

function pageHtml(guide: Guide, css: string, player: string, data: unknown): string {
  return `<!doctype html>
<html lang="${escapeHtml(guide.languages[0]!)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(guide.title)}</title>
<style>${rawText(css, "style")}</style>
</head>
<body class="cf-page">
<div id="cueflow"></div>
<script>${rawText(player, "script")}</script>
<script>window.__cueflow = Cueflow.mount(document.getElementById("cueflow"), ${embed(data)});</script>
</body>
</html>
`;
}
