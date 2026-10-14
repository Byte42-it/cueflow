import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Kit } from "./kit.ts";
import { inlineCssUrls } from "./scene.ts";
import { PlayerLabels } from "./schema.ts";

/**
 * A kit's look, kept out of Cueflow: theme/theme.css is added after the player's own stylesheet (override its
 * --cf-* variables, or anything else), theme/labels.json changes or adds the player's interface words per language.
 * Both are optional; without them the player keeps its defaults.
 */
export type Theme = { css: string; labels: PlayerLabels };

export const themeDir = (kit: Kit) => path.join(kit.root, "theme");

async function readOptional(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

export async function loadTheme(kit: Kit): Promise<Theme> {
  const dir = themeDir(kit);
  const css = await readOptional(path.join(dir, "theme.css"));
  const rawLabels = await readOptional(path.join(dir, "labels.json"));
  let labels: PlayerLabels = {};
  if (rawLabels != null) {
    const parsed = PlayerLabels.safeParse(JSON.parse(rawLabels));
    if (!parsed.success) throw new Error(`theme/labels.json is not valid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    labels = parsed.data;
  }
  // fonts and images the theme points at are inlined like the scenes', so the guide stays one file
  return { css: css == null ? "" : await inlineCssUrls(css, dir), labels };
}
