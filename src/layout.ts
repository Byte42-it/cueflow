import { buildGuide } from "./build.ts";
import { loadGuide, type Kit } from "./kit.ts";
import { openPreview, type At } from "./preview.ts";

/**
 * What `validate` cannot see from the HTML alone: where the elements really are when the guide uses them. The guide is
 * played in a browser and, at the moment of each camera, cursor, click, highlight or typing, its element must be
 * visible and inside the scene: an element below the scene's height is never on screen, whatever the camera does.
 * Returns warnings, one per problem, phrased with the fix.
 */
export async function checkLayout(kit: Kit, id: string, opts: { lang?: string } = {}): Promise<string[]> {
  const guide = await loadGuide(kit, id);
  const built = await buildGuide(kit, id, null); // silent: positions do not depend on the audio
  const session = await openPreview(built.file, { lang: opts.lang });
  const warnings: string[] = [];
  try {
    for (const [i, step] of guide.steps.entries()) {
      // the moments to look at, each with the elements that must be on screen then
      const looks = new Map<string, { at: At; checks: { label: string; selector: string }[] }>();
      const add = (at: At, label: string, selector: string) => {
        const key = JSON.stringify(at);
        if (!looks.has(key)) looks.set(key, { at, checks: [] });
        looks.get(key)!.checks.push({ label, selector });
      };
      if (typeof step.camera?.target === "string") add(0, "camera", step.camera.target);
      for (const [j, a] of step.actions.entries()) {
        const label = `action ${j + 1} (${a.do})`;
        if (["move", "click", "highlight", "type", "select", "value", "check"].includes(a.do) && "to" in a) add(a.at, label, a.to);
        else if (a.do === "camera" && typeof a.target === "string") add(a.at, label, a.target);
      }
      for (const { at, checks } of looks.values()) {
        await session.seek(i, at);
        for (const c of checks) {
          const p = await session.probe(c.selector);
          const where = `step ${i + 1} (${step.id}), ${c.label}: "${c.selector}"`;
          if (!p.found) warnings.push(`${where} is not in the scene at that moment (removed or not yet created by an earlier action)`);
          else if (!p.visible) warnings.push(`${where} is hidden at that moment: show it first (a "show" action before ${JSON.stringify(at)})`);
          else if (p.inView !== "full") {
            const { x, y, width, height } = p.rect;
            const size = `${p.viewport.width}×${p.viewport.height}`;
            warnings.push(
              `${where} is ${p.inView === "none" ? "outside" : "partly outside"} the ${size} scene (at ${x},${y}, ${width}×${height}): ` +
                (y + height > p.viewport.height ? `raise the guide's viewport height to at least ${Math.ceil(y + height + 16)}` : "frame another element, or scroll its container first")
            );
          }
        }
      }
    }
  } finally {
    await session.close();
  }
  return warnings;
}
