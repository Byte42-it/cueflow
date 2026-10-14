import type { Guide } from "./schema.ts";
import type { Kit } from "./kit.ts";
import { listScenes, readScene, sceneFile, sceneFileFor } from "./kit.ts";
import { countMatches } from "./scene.ts";

export type Report = { errors: string[]; warnings: string[] };

/**
 * Checks a guide against its scenes, the way a chess lesson checks its moves: every selector must exist in the
 * scene that is current at that step, ids must be unique, and every language needs a narration.
 */
export async function validateGuide(kit: Kit, guide: Guide): Promise<Report> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const available = new Set(await listScenes(kit));
  const seen = new Set<string>();
  let scene = guide.scene;

  if (!available.has(scene)) errors.push(`guide scene "${scene}" does not exist`);
  if (guide.steps.length === 0) warnings.push("the guide has no steps");

  for (const [i, step] of guide.steps.entries()) {
    const where = `step ${i + 1} (${step.id})`;
    if (seen.has(step.id)) errors.push(`${where}: duplicate step id`);
    seen.add(step.id);
    if (step.scene) {
      scene = step.scene;
      if (!available.has(scene)) errors.push(`${where}: scene "${scene}" does not exist`);
    }
    for (const lang of guide.languages) {
      if (!step.narration[lang]?.trim()) warnings.push(`${where}: no narration in "${lang}"`);
    }
    for (const lang of Object.keys(step.narration)) {
      if (!guide.languages.includes(lang)) warnings.push(`${where}: narration in "${lang}", which is not a language of the guide`);
    }
    if (!available.has(scene)) continue;

    const refs: { label: string; selector: string }[] = [];
    if (typeof step.camera?.target === "string") refs.push({ label: "camera", selector: step.camera.target });
    for (const [j, a] of step.actions.entries()) {
      const label = `action ${j + 1} (${a.do})`;
      if ("to" in a) refs.push({ label, selector: a.to });
      if (a.do === "scroll") refs.push({ label, selector: a.in });
      if (a.do === "camera" && typeof a.target === "string") refs.push({ label, selector: a.target });
      const texts = [
        a.do === "type" ? a.text : undefined,
        a.do === "set" ? a.text : undefined,
        a.do === "set" ? a.html : undefined,
        a.do === "select" ? a.option : undefined,
        a.do === "value" ? a.value : undefined
      ];
      for (const value of texts) {
        if (value == null || typeof value === "string") continue;
        for (const lang of guide.languages) if (value[lang] == null) warnings.push(`${where}, ${label}: no text in "${lang}" (the first one given is used)`);
      }
    }
    // every language plays its own version of the screen (scenes/<lang>/<scene>.html) when the kit has one
    const checked = new Set<string>();
    for (const lang of guide.languages) {
      const file = await sceneFileFor(kit, scene, lang);
      if (checked.has(file)) continue;
      checked.add(file);
      const variant = file === sceneFile(kit, scene) ? `scene "${scene}"` : `scene "${scene}" (${lang})`;
      const counts = countMatches(await readScene(kit, scene, lang), refs.map((r) => r.selector));
      for (const r of refs) {
        const n = counts.get(r.selector);
        if (n === "invalid") errors.push(`${where}, ${r.label}: "${r.selector}" is not a valid CSS selector`);
        else if (n === 0) errors.push(`${where}, ${r.label}: "${r.selector}" matches nothing in ${variant}`);
        else if (n !== undefined && n > 1) warnings.push(`${where}, ${r.label}: "${r.selector}" matches ${n} elements in ${variant}, the first one is used`);
      }
    }
  }
  return { errors, warnings };
}
