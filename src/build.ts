import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { distFile, loadGuide, sceneFile, sceneFileFor, type Kit } from "./kit.ts";
import { inlineScene, type Shared } from "./scene.ts";
import { orientedGuide, spokenOf, type Guide } from "./schema.ts";
import { loadTheme } from "./theme.ts";
import { stepAudio, voiceFor } from "./voices.ts";
import type { TtsProvider } from "./tts.ts";
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

export async function guideBundle(kit: Kit, id: string, provider?: TtsProvider | null, opts: { lang?: string; onProgress?: (done: number, total: number) => void } = {}): Promise<GuideBundle> {
  const guide = orientedGuide(await loadGuide(kit, id));
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
  // `provider` undefined: each language speaks with the voice cueflow.json gives it; null: silent (previews); a provider: forced
  let browserVoice = false;
  // slides have no voice: their narration is the speaker's notes, never read aloud
  const langs = guide.format === "slides" ? [] : opts.lang ? [opts.lang] : guide.languages;
  const total = langs.length * guide.steps.length;
  let done = 0;
  opts.onProgress?.(0, total);
  for (const lang of langs) {
    const voice = provider === undefined ? voiceFor(kit, id, lang) : null;
    if (voice?.browser) browserVoice = true;
    // the language's voice is silent, but a step asks for the browser's: the other steps must stay silent, not be read too
    const langSilent = voice ? !voice.provider && !voice.browser : false;
    const anyBrowser = guide.steps.some((s) => s.voice?.[lang]?.provider === "browser");
    for (const step of guide.steps) {
      const own = step.voice?.[lang];
      if (own?.provider === "browser") browserVoice = true;
      else if (langSilent && anyBrowser && !own) step.voice = { ...step.voice, [lang]: { provider: "none" } };
      const sound = await stepAudio(kit, guide, step, lang, provider);
      opts.onProgress?.(++done, total);
      if (!sound) continue;
      (audio[lang] ??= {})[step.id] = `data:${sound.mime};base64,${sound.data.toString("base64")}`;
      audioFiles += 1;
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
  const text = spokenOf(step, lang);
  const narr = Math.max(1500, text.length * MS_PER_CHAR);
  let end = 0;
  for (const a of step.actions) {
    const at = typeof a.at === "string" ? (parseFloat(a.at) / 100) * narr : a.at;
    // a stagger adds time per matched element, unknown without the scene: the player measures it, this estimate does not
    end = Math.max(end, at + (a.do === "click" ? 350 : "animate" in a && a.animate != null ? a.animate : "duration" in a ? a.duration : 0));
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
export async function renderGuideHtml(kit: Kit, id: string, provider?: TtsProvider | null, opts: { browserVoice?: boolean; extras?: PageExtras; lang?: string; onProgress?: (done: number, total: number) => void } = {}) {
  const bundle = await guideBundle(kit, id, provider, { lang: opts.lang, onProgress: opts.onProgress });
  if (opts.browserVoice) bundle.guide.player = { ...bundle.guide.player, fallbackVoice: "browser" };
  const { js, css, theme } = await playerAssets(kit);
  const styles = theme.css ? `${css}\n/* kit theme */\n${theme.css}` : css;
  return { bundle, html: pageHtml(bundle.guide, styles, js, { ...bundle.data, labels: theme.labels }, opts.extras) };
}

/** Builds guides/<id>.json into <output>/<id>.html: one self-contained file with player, scenes, timeline and audio. */
export async function buildGuide(kit: Kit, id: string, provider?: TtsProvider | null, opts: { onProgress?: (done: number, total: number) => void } = {}): Promise<BuildResult> {
  const { bundle, html } = await renderGuideHtml(kit, id, provider, { onProgress: opts.onProgress });
  const file = distFile(kit, id);
  await writeAtomic(file, html);
  return { file, scenes: bundle.scenes, audioFiles: bundle.audioFiles, silent: bundle.audioFiles === 0, warnings: bundle.warnings };
}

/** What a variant of the page (the one for phones) adds to the standard one: head tags, css after the theme, a script after the player, and the options passed to mount (a JS expression). */
export type PageExtras = { head?: string; css?: string; bodyEnd?: string; mountOptions?: string };

function pageHtml(guide: Guide, css: string, player: string, data: unknown, extras: PageExtras = {}): string {
  return `<!doctype html>
<html lang="${escapeHtml(guide.languages[0]!)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(guide.title)}</title>
${extras.head ?? ""}
<style>${rawText(extras.css ? `${css}\n${extras.css}` : css, "style")}</style>
</head>
<body class="cf-page">
<div id="cueflow"></div>
<script>${rawText(player, "script")}</script>
<script>window.__cueflow = Cueflow.mount(document.getElementById("cueflow"), ${embed(data)}, Object.assign({ lang: new URLSearchParams(location.search).get("lang") }, ${extras.mountOptions ?? "{}"}));</script>
${extras.bodyEnd ? `<script>${rawText(extras.bodyEnd, "script")}</script>` : ""}
</body>
</html>
`;
}
