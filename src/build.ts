import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { distFile, loadGuide, sceneFile, sceneFileFor, type Kit } from "./kit.ts";
import { inlineScene } from "./scene.ts";
import type { Guide } from "./schema.ts";
import { loadTheme } from "./theme.ts";
import { narrationAudio, spokenText, type TtsProvider } from "./tts.ts";
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
  data: { guide: Guide; scenes: Record<string, string>; sceneLang: Record<string, Record<string, string>>; audio: Record<string, Record<string, string>> };
  scenes: string[];
  audioFiles: number;
  warnings: string[];
};

export async function guideBundle(kit: Kit, id: string, provider: TtsProvider | null): Promise<GuideBundle> {
  const guide = await loadGuide(kit, id);
  const report = await validateGuide(kit, guide);
  if (report.errors.length) throw new Error(`the guide "${id}" is not valid:\n- ${report.errors.join("\n- ")}`);

  // every scene the guide visits, in order
  const names: string[] = [guide.scene];
  for (const s of guide.steps) if (s.scene && !names.includes(s.scene)) names.push(s.scene);
  const scenes: Record<string, string> = {};
  for (const n of names) scenes[n] = await inlineScene(kit, n);
  // translated screens: only the languages that have their own version of a scene
  const sceneLang: Record<string, Record<string, string>> = {};
  for (const lang of guide.languages) {
    for (const n of names) {
      if ((await sceneFileFor(kit, n, lang)) === sceneFile(kit, n)) continue;
      (sceneLang[lang] ??= {})[n] = await inlineScene(kit, n, lang);
    }
  }

  const audio: Record<string, Record<string, string>> = {};
  let audioFiles = 0;
  if (provider) {
    for (const lang of guide.languages) {
      audio[lang] = {};
      for (const step of guide.steps) {
        const text = step.narration[lang]?.trim();
        if (!text) continue;
        const mp3 = await narrationAudio(kit, provider, spokenText(text, guide.pronunciation), lang);
        audio[lang]![step.id] = `data:audio/mpeg;base64,${mp3.toString("base64")}`;
        audioFiles += 1;
      }
    }
  }
  return { guide, data: { guide, scenes, sceneLang, audio }, scenes: names, audioFiles, warnings: report.warnings };
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

/** Builds guides/<id>.json into dist/<id>.html: one self-contained file with player, scenes, timeline and audio. */
export async function buildGuide(kit: Kit, id: string, provider: TtsProvider | null): Promise<BuildResult> {
  const bundle = await guideBundle(kit, id, provider);
  const { js, css, theme } = await playerAssets(kit);
  const styles = theme.css ? `${css}\n/* kit theme */\n${theme.css}` : css;
  const html = pageHtml(bundle.guide, styles, js, { ...bundle.data, labels: theme.labels });
  const file = distFile(kit, id);
  await writeAtomic(file, html);
  return { file, scenes: bundle.scenes, audioFiles: bundle.audioFiles, silent: !provider, warnings: bundle.warnings };
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
