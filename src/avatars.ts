import path from "node:path";
import { Avatar, resolveAvatar, type Guide } from "./schema.ts";
import { dataUri } from "./scene.ts";
import { readRawSettings, writeRawSettings } from "./voices.ts";
import { listGuides, loadGuide, saveGuide, type Kit } from "./kit.ts";

/**
 * The narrator is chosen like a voice, at three levels inherited downwards: the project (cueflow.json `avatar`), a
 * video (guide.player.avatar), a step (step.avatar). Unlike voices, never per language: a face is the same whatever
 * is said over it.
 */
export type AvatarTarget = { scope: "global" } | { scope: "video"; guide: string } | { scope: "step"; guide: string; step: string };

/** Sets the narrator at one level; `avatar` null clears that level so the one above applies. */
export async function setAvatar(kit: Kit, target: AvatarTarget, avatar: unknown | null): Promise<void> {
  const spec = avatar === null ? null : Avatar.parse(avatar);
  if (target.scope === "global") {
    const raw = await readRawSettings(kit);
    if (spec && Object.keys(spec).length) raw.avatar = spec;
    else delete raw.avatar;
    await writeRawSettings(kit, raw);
    return;
  }
  if (!(await listGuides(kit)).includes(target.guide)) throw new Error(`guide "${target.guide}" does not exist (available: ${(await listGuides(kit)).join(", ") || "none"})`);
  const g = await loadGuide(kit, target.guide);
  if (target.scope === "video") {
    g.player = { ...g.player, avatar: spec ?? {} };
  } else {
    const st = g.steps.find((s) => s.id === target.step);
    if (!st) throw new Error(`step "${target.step}" does not exist in "${target.guide}" (steps: ${g.steps.map((s) => s.id).join(", ")})`);
    if (spec && Object.keys(spec).length) st.avatar = spec;
    else delete st.avatar;
  }
  await saveGuide(kit, g);
}

/** Looks like a file of the kit rather than a CSS colour. */
export const isKitImage = (v: string | undefined): v is string => !!v && /\.(png|jpe?g|gif|webp|svg|avif)$/i.test(v) && !/^(data:|https?:)/.test(v);

/**
 * The pictures a guide's narrator may show (its own, the project's, every step's), inlined as data URIs by kit path:
 * what the player receives as DATA.avatarImages. Missing files are left out (validate reports them).
 */
export async function avatarImages(kit: Kit, guide: Guide): Promise<Record<string, string>> {
  const layers: (Partial<Avatar> | undefined)[] = [kit.settings.avatar, guide.player.avatar, ...guide.steps.map((s) => s.avatar)];
  const out: Record<string, string> = {};
  for (const layer of layers) {
    for (const v of [layer?.image, layer?.background]) {
      if (!isKitImage(v) || out[v]) continue;
      const uri = await dataUri(path.join(kit.root, v));
      if (uri) out[v] = uri;
    }
  }
  return out;
}

/** What a step shows, all levels merged: for Studio's timeline and the validator. */
export function stepAvatar(kit: Kit, guide: Guide, step: Guide["steps"][number]) {
  return resolveAvatar(kit.settings.avatar, guide.player.avatar, step.avatar);
}
