import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";
import { StudioHistory } from "../src/history.ts";
import { openKit } from "../src/kit.ts";

it("persists undo/redo, preserves external edits, and branches history after a new edit", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cueflow-history-"));
  try {
    const kit = openKit(root), file = path.join(root, "guides", "test.json");
    await mkdir(path.dirname(file));
    await writeFile(file, "original");
    let history = new StudioHistory(kit);
    await history.record("test", file, "Camera", () => writeFile(file, "zoomed"));
    history = new StudioHistory(kit);
    assert.deepEqual(await history.status("test"), { undo: "Camera", redo: null });
    await history.move("test", "undo");
    assert.equal(await readFile(file, "utf8"), "original");
    history = new StudioHistory(kit);
    await history.move("test", "redo");
    assert.equal(await readFile(file, "utf8"), "zoomed");
    await writeFile(file, "assistant changed this");
    await assert.rejects(history.move("test", "undo"), /changed outside/);
    assert.equal(await readFile(file, "utf8"), "assistant changed this");
    await history.record("test", file, "New narration", () => writeFile(file, "new edit"));
    await history.move("test", "undo");
    assert.equal(await readFile(file, "utf8"), "assistant changed this");
    await history.record("test", file, "Another edit", () => writeFile(file, "branch"));
    assert.equal((await history.status("test")).redo, null);
    assert.deepEqual(await history.status("another"), { undo: null, redo: null });
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("undoes first translated scene creation, keeps the base intact, and ignores no-op and failed edits", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cueflow-history-scene-"));
  try {
    const history = new StudioHistory(openKit(root)), base = path.join(root, "scenes", "screen.html"), translation = path.join(root, "scenes", "en", "screen.html");
    await mkdir(path.dirname(translation), { recursive: true });
    await writeFile(base, "Italian");
    await history.record("test", translation, "Translate", () => writeFile(translation, "English"));
    await history.move("test", "undo");
    await assert.rejects(readFile(translation), { code: "ENOENT" });
    assert.equal(await readFile(base, "utf8"), "Italian");
    await history.move("test", "redo");
    assert.equal(await readFile(translation, "utf8"), "English");
    await history.record("test", translation, "No change", () => writeFile(translation, "English"));
    await assert.rejects(history.record("test", translation, "Invalid edit", async () => { throw new Error("Invalid selector"); }));
    assert.equal((await history.status("test")).undo, "Translate");
    await assert.rejects(history.record("test", path.join(root, "..", "outside"), "Invalid path", async () => {}), /Invalid history file/);
    await assert.rejects(history.record("test", path.join(root, "cueflow.json"), "Unsupported file", async () => {}), /Invalid history file/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
