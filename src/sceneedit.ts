import { serializeDocument } from "./scene.ts";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parseHTML } from "linkedom";
import { writeAtomic } from "./build.ts";
import { recordChange } from "./changes.ts";
import { sceneFile, sceneFileFor, listGuides, loadGuide, type Kit } from "./kit.ts";

export const EDITABLE_ATTRS = ["placeholder", "title", "alt", "aria-label", "value", "label"] as const;

/** The text an element carries itself (not its children's): a button's label next to its icon. */
export function ownText(el: { childNodes: ArrayLike<{ nodeType: number; nodeValue: string | null }> }): string {
  return [...Array.from(el.childNodes)].filter((n) => n.nodeType === 3).map((n) => n.nodeValue ?? "").join(" ").replace(/\s+/g, " ").trim();
}

function setOwnText(el: any, text: string) {
  const nodes = Array.from(el.childNodes as ArrayLike<any>).filter((n: any) => n.nodeType === 3 && (n.nodeValue ?? "").trim());
  if (!nodes.length) {
    if (el.children.length === 0) el.textContent = text;
    else el.insertBefore(el.ownerDocument.createTextNode(text), el.firstChild);
    return;
  }
  const first = nodes[0];
  const v = first.nodeValue as string;
  first.nodeValue = (/^\s/.test(v) ? " " : "") + text + (/\s$/.test(v) ? " " : "");
  for (const n of nodes.slice(1)) n.nodeValue = "";
}

const isLocal = (ref: string) => ref !== "" && !/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(ref);

/**
 * A copy of the base screen that goes one folder deeper (scenes/<lang>/) must point one folder further up: its
 * stylesheets, scripts and pictures are written relative to the file.
 */
function moveDeeper(document: any) {
  for (const [selector, attr] of [["link[href]", "href"], ["script[src]", "src"], ["img[src]", "src"], ["source[src]", "src"], ["video[src]", "src"], ["audio[src]", "src"]] as const) {
    for (const el of document.querySelectorAll(selector) as any) {
      const v = el.getAttribute(attr) as string;
      if (isLocal(v)) el.setAttribute(attr, "../" + v);
    }
  }
  const css = (text: string) => text.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (all, q, ref) => (isLocal(ref) ? `url(${q}../${ref}${q})` : all));
  for (const el of document.querySelectorAll("style") as any) el.textContent = css(el.textContent ?? "");
  for (const el of document.querySelectorAll("[style*='url(']") as any) el.setAttribute("style", css(el.getAttribute("style")));
}

/**
 * Edits the text or attributes of one element of a screen, for one language. Each language is its own sub-project:
 * the change goes to scenes/<lang>/<scene>.html, created from the version that language shows if it had none, so
 * editing English never touches Italian. What was changed is noted for the assistant.
 */
export async function editSceneElement(kit: Kit, scene: string, lang: string, selector: string, patch: { text?: string; attrs?: Record<string, string>; remove?: boolean }, tutorial?: string) {
  const source = await sceneFileFor(kit, scene, lang);
  const { document } = parseHTML(await readFile(source, "utf8"));
  let found: any[];
  try {
    found = [...(document.querySelectorAll(selector) as any)];
  } catch {
    throw new Error(`"${selector}" is not a valid CSS selector`);
  }
  if (found.length !== 1) throw new Error(`"${selector}" matches ${found.length} elements of the screen "${scene}": it must match exactly one`);
  const el = found[0];
  const target = sceneFile(kit, scene, lang);
  const changes: { kind: "element-text" | "element-attribute" | "element-deleted"; target: string; before: string; after: string }[] = [];

  if (patch.remove === true) {
    if (["html", "head", "body"].includes(el.localName)) throw new Error("The page root cannot be deleted. Select an element inside the scene.");
    // A deleted camera/action target would leave a tutorial that cannot play or export.
    for (const id of await listGuides(kit)) {
      const guide = await loadGuide(kit, id);
      if (!guide.languages.includes(lang)) continue;
      let current = guide.scene;
      for (const step of guide.steps) {
        current = step.scene ?? current;
        if (current !== scene) continue;
        const selectors = [step.camera?.target, ...step.actions.flatMap((action) => ["to" in action ? action.to : undefined, "target" in action ? action.target : undefined, "in" in action ? action.in : undefined])];
        for (const target of selectors) {
          if (typeof target !== "string") continue;
          let targets: any[];
          try { targets = [...document.querySelectorAll(target)]; } catch { continue; }
          if (targets.some((node) => node === el || el.contains(node))) throw new Error(`This element is used by tutorial "${id}", step "${step.id}" (${target}). Change or remove that camera/action target before deleting the element.`);
        }
      }
    }
    changes.push({ kind: "element-deleted", target: selector, before: el.outerHTML, after: "" });
    el.remove();
  }

  if (!patch.remove && patch.text !== undefined) {
    const before = ownText(el);
    if (before !== patch.text) {
      setOwnText(el, patch.text);
      changes.push({ kind: "element-text", target: selector, before, after: patch.text });
    }
  }
  for (const [name, value] of Object.entries(patch.remove ? {} : patch.attrs ?? {})) {
    if (!(EDITABLE_ATTRS as readonly string[]).includes(name)) throw new Error(`the attribute "${name}" cannot be edited here (${EDITABLE_ATTRS.join(", ")})`);
    const before = el.getAttribute(name) ?? "";
    if (before !== value) {
      el.setAttribute(name, value);
      changes.push({ kind: "element-attribute", target: `${selector} [${name}]`, before, after: value });
    }
  }
  if (!changes.length) return { file: target, changed: 0 };
  if (path.resolve(source) !== path.resolve(target)) moveDeeper(document); // first edit in this language: a copy of the base screen
  await mkdir(path.dirname(target), { recursive: true });
  await writeAtomic(target, serializeDocument(document as unknown as Document));
  const rel = path.relative(kit.root, target).split(path.sep).join("/");
  for (const c of changes) await recordChange(kit, { ...c, lang, scene, tutorial, file: rel });
  return { file: target, changed: changes.length };
}
