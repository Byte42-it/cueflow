import { mkdir, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { writeAtomic } from "./build.ts";
import type { Kit } from "./kit.ts";

type Edit = { file: string; before: string | null; after: string | null; label: string };
type Stack = { undo: Edit[]; redo: Edit[] };
type Book = Record<string, Stack>;
export class HistoryConflict extends Error { status = 409; }

/** Studio edits only. Full file snapshots also preserve the absence of a translated scene. */
export class StudioHistory {
  private queue: Promise<unknown> = Promise.resolve();
  private kit: Kit;
  constructor(kit: Kit) { this.kit = kit; }
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work);
    this.queue = next.catch(() => {});
    return next;
  }
  private async read(): Promise<Book> {
    try { return JSON.parse(await readFile(path.join(this.kit.root, ".studio-history.json"), "utf8")); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return {}; throw e; }
  }
  private async write(book: Book) {
    await writeAtomic(path.join(this.kit.root, ".studio-history.json"), JSON.stringify(book));
  }
  private file(relative: string) {
    const file = path.resolve(this.kit.root, relative);
    if (!file.startsWith(this.kit.root + path.sep) || !/^(guides|scenes)[/\\]/.test(relative)) throw new Error("Invalid history file");
    return file;
  }
  private async content(file: string) {
    try { return await readFile(file, "utf8"); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
  }
  private scope(book: Book, id: string): Stack {
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(id)) throw new Error("Invalid tutorial id");
    if (!Object.hasOwn(book, id)) Object.defineProperty(book, id, { value: { undo: [], redo: [] }, enumerable: true, writable: true });
    return book[id]!;
  }
  private summary(stack: Stack) {
    return { undo: stack.undo.at(-1)?.label ?? null, redo: stack.redo.at(-1)?.label ?? null };
  }
  async status(id: string) {
    return this.exclusive(async () => this.summary(this.scope(await this.read(), id)));
  }
  async record<T>(id: string, file: string, label: string, work: () => Promise<T>): Promise<T> {
    return this.exclusive(async () => {
      const relative = path.relative(this.kit.root, file);
      this.file(relative);
      const book = await this.read(), stack = this.scope(book, id);
      const before = await this.content(file);
      const result = await work();
      const after = await this.content(file);
      if (before !== after) {
        stack.undo.push({ file: relative, before, after, label });
        stack.undo = stack.undo.slice(-50);
        stack.redo = [];
        await this.write(book);
      }
      return result;
    });
  }
  async move(id: string, direction: "undo" | "redo") {
    return this.exclusive(async () => {
      const book = await this.read(), stack = this.scope(book, id), from = stack[direction], edit = from.at(-1);
      if (!edit) throw new HistoryConflict(`Nothing to ${direction}.`);
      const file = this.file(edit.file), expected = direction === "undo" ? edit.after : edit.before;
      if (await this.content(file) !== expected) throw new HistoryConflict("This file changed outside this edit. Undo/redo stopped to preserve the newer changes.");
      const target = direction === "undo" ? edit.before : edit.after;
      if (target === null) await unlink(file);
      else { await mkdir(path.dirname(file), { recursive: true }); await writeAtomic(file, target); }
      from.pop();
      stack[direction === "undo" ? "redo" : "undo"].push(edit);
      await this.write(book);
      return { ...this.summary(stack), label: edit.label, file: edit.file };
    });
  }
}
