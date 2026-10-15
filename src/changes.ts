import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { writeAtomic } from "./build.ts";
import type { Kit } from "./kit.ts";

/**
 * What a person changed by hand in Studio, as information for the assistant: "the button was changed to …, take it
 * into account". It is not a list of edits to replay: the assistant reads it, understands why the person did it, and
 * decides what else should follow (a narration that names the button, a description, a pronunciation). Once read it
 * is marked seen; the file is an inbox, not a history to keep.
 */
export type ChangeKind = "element-text" | "element-attribute" | "narration" | "title" | "file-replaced" | "file-edited" | "catalog" | "tutorial-deleted";
export type Change = {
  id: string;
  at: string;
  kind: ChangeKind;
  lang?: string;
  tutorial?: string;
  scene?: string;
  /** the file the change was saved in */
  file?: string;
  /** a selector, a step id, a file name or a catalog item */
  target: string;
  before?: string;
  after?: string;
  seen: boolean;
  /** what the assistant did with it, when it says so */
  note?: string;
};

export const changesFile = (kit: Kit) => path.join(kit.root, "changes.json");

async function load(kit: Kit): Promise<Change[]> {
  try {
    const list = JSON.parse(await readFile(changesFile(kit), "utf8"));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export async function recordChange(kit: Kit, change: Omit<Change, "id" | "at" | "seen">): Promise<void> {
  if (change.before !== undefined && change.before === change.after) return;
  const all = await load(kit);
  all.push({ id: randomUUID().slice(0, 8), at: new Date().toISOString(), seen: false, ...change });
  // an inbox: what was read long ago goes away, what is unread stays
  const keep = all.filter((c) => !c.seen).concat(all.filter((c) => c.seen).slice(-100));
  await writeAtomic(changesFile(kit), JSON.stringify(keep, null, 2) + "\n");
}

export async function pendingChanges(kit: Kit): Promise<Change[]> {
  return (await load(kit)).filter((c) => !c.seen);
}

export async function markSeen(kit: Kit, ids: string[] | "all", note?: string): Promise<number> {
  const all = await load(kit);
  let n = 0;
  for (const c of all) {
    if (!c.seen && (ids === "all" || ids.includes(c.id))) {
      c.seen = true;
      if (note) c.note = note;
      n += 1;
    }
  }
  if (n) await writeAtomic(changesFile(kit), JSON.stringify(all, null, 2) + "\n");
  return n;
}

/**
 * Drops notes the person does not want the assistant to read (a try, an edit already explained to it). The edit
 * itself stays saved: only its note goes. Returns how many were dropped.
 */
export async function discardChanges(kit: Kit, ids: string[] | "all"): Promise<number> {
  const all = await load(kit);
  const keep = all.filter((c) => c.seen || (ids !== "all" && !ids.includes(c.id)));
  const n = all.length - keep.length;
  if (n) await writeAtomic(changesFile(kit), JSON.stringify(keep, null, 2) + "\n");
  return n;
}

/** How the assistant is told: a plain sentence per change. */
export function describeChange(c: Change): string {
  const where = [c.tutorial && `tutorial "${c.tutorial}"`, c.lang && `language "${c.lang}"`, c.scene && `screen "${c.scene}"`].filter(Boolean).join(", ");
  const w = (where ? ` (${where})` : "") + (c.file && c.kind.startsWith("element") ? ` [saved in ${c.file}, which this language now uses instead of the base screen]` : "");
  switch (c.kind) {
    case "element-text": return `The text of ${c.target}${w} was changed from “${c.before ?? ""}” to “${c.after ?? ""}”.`;
    case "element-attribute": return `An attribute of ${c.target}${w} was changed from “${c.before ?? ""}” to “${c.after ?? ""}”.`;
    case "narration": return `The narration of step ${c.target}${w} (what is shown as caption and read aloud) was changed from “${c.before ?? ""}” to “${c.after ?? ""}”.`;
    case "title": return `The title of step ${c.target}${w} was changed from “${c.before ?? ""}” to “${c.after ?? ""}”.`;
    case "file-replaced": return `The file ${c.target}${w} was replaced (${c.before ?? "?"} → ${c.after ?? "?"}).`;
    case "file-edited": return `The file ${c.target}${w} was edited: ${c.after ?? ""}`;
    case "tutorial-deleted": return `The tutorial "${c.target}" (“${c.before ?? ""}”) was deleted by the user; it is ${c.after ?? "in the trash"}. Do not recreate it; check that no other tutorial or description refers to it.`;
    case "catalog": return `The dashboard text ${c.target}${w} was changed from “${c.before ?? ""}” to “${c.after ?? ""}”.`;
  }
}
