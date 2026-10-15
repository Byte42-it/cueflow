import { mkdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { writeAtomic } from "./build.ts";
import { recordChange } from "./changes.ts";
import { guideFile, loadGuide, distFile, type Kit } from "./kit.ts";
import { loadSite, siteFile } from "./site.ts";

/**
 * Deletes a tutorial the careful way: its files are moved to trash/<date>-<id>/ in the kit (git-ignored), not erased,
 * and it leaves the dashboard. Screens and shared files stay: other tutorials may use them.
 */
export async function deleteTutorial(kit: Kit, id: string): Promise<{ trash: string; removedFromCatalog: string[] }> {
  const guide = await loadGuide(kit, id); // fails with a readable message when it does not exist
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const trash = path.join(kit.root, "trash", `${stamp}-${id}`);
  await mkdir(trash, { recursive: true });
  await rename(guideFile(kit, id), path.join(trash, `${id}.json`));
  const media = path.join(kit.root, "media", id);
  await rename(media, path.join(trash, "media")).catch(() => {}); // it may not have any
  await rm(distFile(kit, id), { force: true }); // the built copy is regenerated, not kept

  const removedFromCatalog: string[] = [];
  if (await readFile(siteFile(kit), "utf8").then(() => true, () => false)) {
    const raw = JSON.parse(await readFile(siteFile(kit), "utf8"));
    const items = (raw.items ?? []) as { id: string; guide?: string }[];
    raw.items = items.filter((i) => {
      const gone = i.guide === id;
      if (gone) removedFromCatalog.push(i.id);
      return !gone;
    });
    if (removedFromCatalog.includes(raw.featured)) raw.featured = raw.items[0]?.id;
    if (removedFromCatalog.length) await writeAtomic(siteFile(kit), JSON.stringify(raw, null, 2) + "\n");
    await loadSite(kit).catch(() => {}); // a catalog left invalid would show at the next build; nothing to do here
  }
  await recordChange(kit, { kind: "tutorial-deleted", tutorial: id, target: id, before: guide.title, after: `moved to ${path.relative(kit.root, trash)}` });
  return { trash: path.relative(kit.root, trash), removedFromCatalog };
}
