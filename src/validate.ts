import { stat } from "node:fs/promises";
import path from "node:path";
import type { Guide } from "./schema.ts";
import type { Kit } from "./kit.ts";
import { listScenes, readScene, sceneFile, sceneFileFor } from "./kit.ts";
import { countMatches, firstText } from "./scene.ts";
import { estimateDuration } from "./build.ts";
import { loadBrief } from "./brief.ts";

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

  // slides are advanced by hand and say nothing: no length to keep, and the narration is optional speaker's notes
  const slides = guide.format === "slides";
  // one idea per tutorial, one or two sentences per step: longer ones are better split
  const { maxSeconds } = await loadBrief(kit);
  for (const lang of slides ? [] : guide.languages) {
    const seconds = Math.round(estimateDuration(guide, lang) / 1000);
    if (seconds > maxSeconds) warnings.push(`the guide lasts about ${seconds} s in "${lang}", over the ${maxSeconds} s of the brief: split it into two tutorials`);
  }

  for (const [i, step] of guide.steps.entries()) {
    const where = `step ${i + 1} (${step.id})`;
    if (seen.has(step.id)) errors.push(`${where}: duplicate step id`);
    seen.add(step.id);
    if (step.scene) {
      scene = step.scene;
      if (!available.has(scene)) errors.push(`${where}: scene "${scene}" does not exist`);
    }
    for (const [lang, own] of Object.entries(step.voice ?? {})) {
      if (!guide.languages.includes(lang)) errors.push(`${where}: a voice is set for "${lang}", which is not a language of the guide`);
      if (own.provider === "file") {
        const abs = path.resolve(kit.root, own.file);
        if (!abs.startsWith(kit.root + path.sep)) errors.push(`${where}, voice "${lang}": the audio file must be inside the kit`);
        else if (!(await stat(abs).then((s) => s.isFile(), () => false))) errors.push(`${where}, voice "${lang}": the audio file "${own.file}" does not exist (upload it again in the step's Voice tab)`);
      }
    }
    for (const lang of slides ? [] : guide.languages) {
      const narration = step.narration[lang]?.trim();
      if (!narration) warnings.push(`${where}: no narration in "${lang}"`);
      else if ((narration.match(/[.!?…]+(\s|$)/g)?.length ?? 1) > 2) warnings.push(`${where}: more than two sentences in "${lang}": a step carries one idea, split it`);
    }
    for (const lang of Object.keys(step.speech ?? {})) {
      if (!guide.languages.includes(lang)) warnings.push(`${where}: spoken text in "${lang}", which is not a language of the guide`);
    }
    for (const lang of Object.keys(step.narration)) {
      if (!guide.languages.includes(lang)) warnings.push(`${where}: narration in "${lang}", which is not a language of the guide`);
    }
    if (!available.has(scene)) continue;

    // `many`: the action means every element the selector matches (a stagger), so several matches are not a doubt
    const refs: { label: string; selector: string; many?: boolean; number?: boolean }[] = [];
    if (typeof step.camera?.target === "string") refs.push({ label: "camera", selector: step.camera.target });
    for (const [j, a] of step.actions.entries()) {
      const label = `action ${j + 1} (${a.do})`;
      const many = (a.do === "show" || a.do === "hide") && a.stagger != null;
      if ("to" in a) refs.push({ label, selector: a.to, many, number: a.do === "count" && a.from == null });
      if (a.do === "scroll") refs.push({ label, selector: a.in });
      if (a.do === "reorder" || a.do === "drag") {
        const given = (["into", "before", "after"] as const).filter((key) => a[key] != null);
        if (given.length !== 1) errors.push(`${where}, ${label}: give exactly one of into, before, after (the place the element goes to)`);
        for (const key of given) refs.push({ label: `${label} ${key}`, selector: a[key]! });
      }
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
        else if (n !== undefined && n > 1 && !r.many) warnings.push(`${where}, ${r.label}: "${r.selector}" matches ${n} elements in ${variant}, the first one is used`);
        else if (n === 1 && r.many) warnings.push(`${where}, ${r.label}: stagger has no effect, "${r.selector}" matches one element in ${variant}`);
        if (r.number && n !== 0 && n !== "invalid") {
          const text = firstText(await readScene(kit, scene, lang), r.selector) ?? "";
          if (!/\d/.test(text)) errors.push(`${where}, ${r.label}: "${r.selector}" shows no number to count from ("${text.slice(0, 40)}"): give from`);
        }
      }
    }
  }
  return { errors, warnings };
}
