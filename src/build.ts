import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { distFile, loadGuide, type Kit } from "./kit.ts";
import { inlineScene } from "./scene.ts";
import type { Guide } from "./schema.ts";
import { narrationAudio, spokenText, type TtsProvider } from "./tts.ts";
import { validateGuide } from "./validate.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

/** JSON that is safe inside a <script> element. */
const embed = (value: unknown): string => JSON.stringify(value).replace(/</g, "\\u003c");
const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export type BuildResult = { file: string; scenes: string[]; audioFiles: number; silent: boolean; warnings: string[] };

/** Builds guides/<id>.json into dist/<id>.html: one self-contained file with player, scenes, timeline and audio. */
export async function buildGuide(kit: Kit, id: string, provider: TtsProvider | null): Promise<BuildResult> {
  const guide = await loadGuide(kit, id);
  const report = await validateGuide(kit, guide);
  if (report.errors.length) throw new Error(`the guide is not valid:\n- ${report.errors.join("\n- ")}`);

  // every scene the guide visits, in order
  const names: string[] = [guide.scene];
  for (const s of guide.steps) if (s.scene && !names.includes(s.scene)) names.push(s.scene);
  const scenes: Record<string, string> = {};
  for (const n of names) scenes[n] = await inlineScene(kit, n);

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

  const [player, css] = await Promise.all([readFile(path.join(here, "player", "player.js"), "utf8"), readFile(path.join(here, "player", "player.css"), "utf8")]);
  const html = pageHtml(guide, css, player, { guide, scenes, audio });
  const file = distFile(kit, id);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, html);
  await rename(tmp, file);
  return { file, scenes: names, audioFiles, silent: !provider, warnings: report.warnings };
}

function pageHtml(guide: Guide, css: string, player: string, data: unknown): string {
  return `<!doctype html>
<html lang="${escapeHtml(guide.languages[0]!)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(guide.title)}</title>
<style>${css}</style>
</head>
<body>
<div id="cueflow"></div>
<script>${player.replace(/<\/script/gi, "<\\/script")}</script>
<script>window.__cueflow = Cueflow.mount(document.getElementById("cueflow"), ${embed(data)});</script>
</body>
</html>
`;
}
